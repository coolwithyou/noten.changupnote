/**
 * 필드맵 검수 워크스페이스 데이터 접근 (field_map_review_docs).
 *
 * 검수 확정은 곧 golden_set(kind=field_map) 승격이다.
 * 순환성 가드/승격 upsert 는 공용 모듈(promote-field-map-golden)을 재사용한다.
 */
import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import type { GrantSource } from "@cunote/contracts";
import { getCunoteDb, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { evaluateReviewer } from "../db/field-map-review-guard";
import {
  DEFAULT_FIELD_MAP_GOLDEN_VER,
  promoteFieldMapGolden,
} from "../db/promote-field-map-golden";
import { applyReconciledFields, RECONCILE_PARSER_VERSION } from "../documents/applyReconciledFields";
import {
  reviewFieldsToReconciled,
  SURFACE_DOC_REF_PREFIX,
  type ReviewLabelField,
} from "../documents/reviewFieldMapping";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * docRef 가 surface 네임스페이스(`surface:<uuid>`)면 surfaceId 를 돌려준다(아니면 null).
 * 이 판정이 B3 승인 반영 브리지의 발동 조건이다 — 스파이크 문서(`doc`/기존 네임스페이스)는 null.
 */
function surfaceIdFromDocRef(docRef: string): string | null {
  if (!docRef.startsWith(SURFACE_DOC_REF_PREFIX)) return null;
  const id = docRef.slice(SURFACE_DOC_REF_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
}

export type ReviewStatus = "pending" | "in_review" | "approved";

export interface ReviewField {
  key?: string;
  label?: string;
  section?: string;
  type?: string;
  required?: boolean;
  applicantFills?: boolean;
  manual?: boolean;
  page?: number;
  bbox?: [number, number, number, number] | null;
  options?: string[];
  notes?: string;
  [k: string]: unknown;
}

export interface ReviewLabelJson {
  docRef?: string;
  labeledBy?: string;
  labeledAt?: string;
  reviewedBy?: string;
  pageCount?: number;
  fields?: ReviewField[];
  [k: string]: unknown;
}

export interface ReviewDocSummary {
  id: string;
  docId: string;
  docRef: string;
  /** 목록 1차 표기용 공고명(grants.title). docRef 가 공고로 해석되지 않으면 null → docId 폴백. */
  grantTitle: string | null;
  sourceFilename: string | null;
  fieldCount: number;
  pageCount: number | null;
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  hasCorrectionNotes: boolean;
  /** 필드 notes 가 "판정 보류:" 로 시작하는 필드 수 (목록 뱃지·확정 경고용). */
  heldCount: number;
  hasReviewerComment: boolean;
  updatedAt: Date;
}

export interface ReviewDocDetail extends ReviewDocSummary {
  labelJson: ReviewLabelJson;
  labeledBy: string | null;
  labeledAt: string | null;
  correctionNotes: string | null;
  reviewerComment: string | null;
  pageImageKeys: string[];
  evidence: ReviewDocEvidence | null;
}

export interface ReviewDocEvidence {
  source: GrantSource;
  sourceId: string;
  sourceFilename: string | null;
  grant: {
    id: string;
    title: string;
    url: string | null;
    agencyOperator: string | null;
    status: string;
  } | null;
  attachment: {
    filename: string;
    sourceUri: string | null;
    archiveUrl: string | null;
    storageKey: string | null;
    contentType: string | null;
  } | null;
  surface: {
    id: string;
    title: string;
    format: string;
    sourceUrl: string | null;
    sourceAttachment: string | null;
    extractionStatus: string;
  } | null;
}

function toLabelJson(value: unknown): ReviewLabelJson {
  return (value && typeof value === "object" ? value : {}) as ReviewLabelJson;
}

function fieldCountOf(labelJson: ReviewLabelJson): number {
  return Array.isArray(labelJson.fields) ? labelJson.fields.length : 0;
}

/**
 * 보류 접두어 규약. notes 가 이 문구로 시작하면 "판정 보류" 상태로 취급한다.
 * UI([보류] 토글)와 목록 카운트가 동일 규약을 공유한다.
 */
export const HOLD_PREFIX = "판정 보류:";

/** labelJson.fields 에서 보류(판정 보류:) 필드 수를 센다. 저장 시점의 jsonb 에서 직접 계산. */
function heldCountOf(labelJson: ReviewLabelJson): number {
  if (!Array.isArray(labelJson.fields)) return 0;
  return labelJson.fields.filter(
    (f) => typeof f?.notes === "string" && f.notes.trimStart().startsWith(HOLD_PREFIX),
  ).length;
}

export async function listReviewDocs(): Promise<ReviewDocSummary[]> {
  const db = getCunoteDb();
  const rows = await db
    .select()
    .from(schema.fieldMapReviewDocs)
    .orderBy(asc(schema.fieldMapReviewDocs.docId));
  const titleByDocRef = await resolveGrantTitles(rows.map((row) => row.docRef));
  return rows.map((row) => {
    const labelJson = toLabelJson(row.labelJson);
    return {
      id: row.id,
      docId: row.docId,
      docRef: row.docRef,
      grantTitle: titleByDocRef.get(row.docRef) ?? null,
      sourceFilename: row.sourceFilename,
      fieldCount: fieldCountOf(labelJson),
      pageCount: row.pageCount,
      reviewStatus: row.reviewStatus as ReviewStatus,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      hasCorrectionNotes: Boolean(row.correctionNotes && row.correctionNotes.trim()),
      heldCount: heldCountOf(labelJson),
      hasReviewerComment: Boolean(row.reviewerComment && row.reviewerComment.trim()),
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * 목록 표기용 공고명 배치 조회 — docRef → grants.title 매핑.
 * surface 문서(`surface:<id>`)는 surfaces.grantId 로, 스파이크 문서(`<source>:<sourceId>:…`)는
 * (source, sourceId) 로 되짚는다. 어느 쪽으로도 해석되지 않으면 매핑에 없음(호출부 docId 폴백).
 */
async function resolveGrantTitles(docRefs: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const docRefBySurfaceId = new Map<string, string>();
  const docRefsBySourceKey = new Map<string, string[]>();

  for (const docRef of docRefs) {
    const surfaceId = surfaceIdFromDocRef(docRef);
    if (surfaceId) {
      docRefBySurfaceId.set(surfaceId, docRef);
      continue;
    }
    const parsed = parseReviewDocRef(docRef);
    if (!parsed) continue;
    const key = `${parsed.source}:${parsed.sourceId}`;
    const refs = docRefsBySourceKey.get(key) ?? [];
    refs.push(docRef);
    docRefsBySourceKey.set(key, refs);
  }

  const db = getCunoteDb();

  if (docRefBySurfaceId.size > 0) {
    const rows = await db
      .select({
        surfaceId: schema.grantApplicationSurfaces.id,
        title: schema.grants.title,
      })
      .from(schema.grantApplicationSurfaces)
      .innerJoin(schema.grants, eq(schema.grants.id, schema.grantApplicationSurfaces.grantId))
      .where(inArray(schema.grantApplicationSurfaces.id, [...docRefBySurfaceId.keys()]));
    for (const row of rows) {
      const docRef = docRefBySurfaceId.get(row.surfaceId);
      if (docRef) titles.set(docRef, row.title);
    }
  }

  if (docRefsBySourceKey.size > 0) {
    const pairs = [...docRefsBySourceKey.keys()].map((key) => {
      const [source, sourceId] = key.split(":") as [GrantSource, string];
      return and(eq(schema.grants.source, source), eq(schema.grants.sourceId, sourceId));
    });
    const rows = await db
      .select({
        source: schema.grants.source,
        sourceId: schema.grants.sourceId,
        title: schema.grants.title,
      })
      .from(schema.grants)
      .where(or(...pairs));
    for (const row of rows) {
      const refs = docRefsBySourceKey.get(`${row.source}:${row.sourceId}`) ?? [];
      for (const docRef of refs) titles.set(docRef, row.title);
    }
  }

  return titles;
}

export async function getReviewDocByDocId(docId: string): Promise<ReviewDocDetail | null> {
  const db = getCunoteDb();
  const rows = await db
    .select()
    .from(schema.fieldMapReviewDocs)
    .where(eq(schema.fieldMapReviewDocs.docId, docId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const labelJson = toLabelJson(row.labelJson);
  const evidence = await loadReviewDocEvidence(row.docRef, row.sourceFilename);
  return {
    id: row.id,
    docId: row.docId,
    docRef: row.docRef,
    grantTitle: evidence?.grant?.title ?? null,
    sourceFilename: row.sourceFilename,
    fieldCount: fieldCountOf(labelJson),
    pageCount: row.pageCount,
    reviewStatus: row.reviewStatus as ReviewStatus,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    hasCorrectionNotes: Boolean(row.correctionNotes && row.correctionNotes.trim()),
    heldCount: heldCountOf(labelJson),
    hasReviewerComment: Boolean(row.reviewerComment && row.reviewerComment.trim()),
    updatedAt: row.updatedAt,
    labelJson,
    labeledBy: row.labeledBy,
    labeledAt: row.labeledAt,
    correctionNotes: row.correctionNotes,
    reviewerComment: row.reviewerComment,
    pageImageKeys: Array.isArray(row.pageImageKeys) ? row.pageImageKeys : [],
    evidence,
  };
}

const GRANT_SOURCES: GrantSource[] = ["kstartup", "bizinfo", "bizinfo_event"];

interface ParsedReviewDocRef {
  source: GrantSource;
  sourceId: string;
  filename: string | null;
}

function parseReviewDocRef(docRef: string): ParsedReviewDocRef | null {
  const [source, sourceId, ...filenameParts] = docRef.split(":");
  if (!source || !sourceId || !isGrantSource(source)) return null;
  return {
    source,
    sourceId,
    filename: filenameParts.join(":") || null,
  };
}

function isGrantSource(value: string): value is GrantSource {
  return GRANT_SOURCES.includes(value as GrantSource);
}

async function loadReviewDocEvidence(
  docRef: string,
  sourceFilename: string | null,
): Promise<ReviewDocEvidence | null> {
  // surface 네임스페이스(B1 유입기 등재분)는 surfaceId 로 직접 근거를 되짚는다.
  const surfaceId = surfaceIdFromDocRef(docRef);
  if (surfaceId) return loadSurfaceEvidence(surfaceId, sourceFilename);

  const parsed = parseReviewDocRef(docRef);
  if (!parsed) return null;

  const db = getCunoteDb();
  const filename = sourceFilename ?? parsed.filename;

  const [grant] = await db
    .select({
      id: schema.grants.id,
      title: schema.grants.title,
      url: schema.grants.url,
      agencyOperator: schema.grants.agencyOperator,
      status: schema.grants.status,
    })
    .from(schema.grants)
    .where(
      and(
        eq(schema.grants.source, parsed.source),
        eq(schema.grants.sourceId, parsed.sourceId),
      ),
    )
    .limit(1);

  const attachments = await db
    .select({
      filename: schema.grantAttachmentArchives.filename,
      sourceUri: schema.grantAttachmentArchives.sourceUri,
      archiveUrl: schema.grantAttachmentArchives.archiveUrl,
      storageKey: schema.grantAttachmentArchives.storageKey,
      contentType: schema.grantAttachmentArchives.contentType,
    })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, parsed.source),
        eq(schema.grantAttachmentArchives.sourceId, parsed.sourceId),
      ),
    );

  const surfaces = await db
    .select({
      id: schema.grantApplicationSurfaces.id,
      title: schema.grantApplicationSurfaces.title,
      format: schema.grantApplicationSurfaces.format,
      sourceUrl: schema.grantApplicationSurfaces.sourceUrl,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      extractionStatus: schema.grantApplicationSurfaces.extractionStatus,
    })
    .from(schema.grantApplicationSurfaces)
    .where(
      and(
        eq(schema.grantApplicationSurfaces.source, parsed.source),
        eq(schema.grantApplicationSurfaces.sourceId, parsed.sourceId),
      ),
    )
    .orderBy(asc(schema.grantApplicationSurfaces.createdAt));

  const attachment = pickBestAttachment(attachments, filename);
  const surface = pickBestSurface(surfaces, filename, attachment?.storageKey ?? null);

  return {
    source: parsed.source,
    sourceId: parsed.sourceId,
    sourceFilename: filename,
    grant: grant
      ? {
          id: grant.id,
          title: grant.title,
          url: grant.url,
          agencyOperator: grant.agencyOperator,
          status: grant.status,
        }
      : null,
    attachment: attachment
      ? {
          filename: attachment.filename,
          sourceUri: nonEmpty(attachment.sourceUri),
          archiveUrl: nonEmpty(attachment.archiveUrl),
          storageKey: nonEmpty(attachment.storageKey),
          contentType: nonEmpty(attachment.contentType),
        }
      : null,
    surface: surface
      ? {
          id: surface.id,
          title: surface.title,
          format: surface.format,
          sourceUrl: nonEmpty(surface.sourceUrl),
          sourceAttachment: nonEmpty(surface.sourceAttachment),
          extractionStatus: surface.extractionStatus,
        }
      : null,
  };
}

/**
 * surface 네임스페이스 근거 로더 (B1 유입기 등재분).
 * surfaceId → surface 행 → grant + 매칭 첨부(source/sourceId) 를 모아 ReviewDocEvidence 로 정규화한다.
 */
async function loadSurfaceEvidence(
  surfaceId: string,
  sourceFilename: string | null,
): Promise<ReviewDocEvidence | null> {
  const db = getCunoteDb();

  const [surface] = await db
    .select({
      id: schema.grantApplicationSurfaces.id,
      grantId: schema.grantApplicationSurfaces.grantId,
      source: schema.grantApplicationSurfaces.source,
      sourceId: schema.grantApplicationSurfaces.sourceId,
      title: schema.grantApplicationSurfaces.title,
      format: schema.grantApplicationSurfaces.format,
      sourceUrl: schema.grantApplicationSurfaces.sourceUrl,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      extractionStatus: schema.grantApplicationSurfaces.extractionStatus,
    })
    .from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.id, surfaceId))
    .limit(1);
  if (!surface) return null;

  const [grant] = await db
    .select({
      id: schema.grants.id,
      title: schema.grants.title,
      url: schema.grants.url,
      agencyOperator: schema.grants.agencyOperator,
      status: schema.grants.status,
    })
    .from(schema.grants)
    .where(eq(schema.grants.id, surface.grantId))
    .limit(1);

  const attachments = await db
    .select({
      filename: schema.grantAttachmentArchives.filename,
      sourceUri: schema.grantAttachmentArchives.sourceUri,
      archiveUrl: schema.grantAttachmentArchives.archiveUrl,
      storageKey: schema.grantAttachmentArchives.storageKey,
      contentType: schema.grantAttachmentArchives.contentType,
    })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, surface.source),
        eq(schema.grantAttachmentArchives.sourceId, surface.sourceId),
      ),
    );

  // sourceAttachment(storage_key) 우선 매칭, 없으면 파일명 유사도.
  const attachment =
    attachments.find((a) => a.storageKey && a.storageKey === surface.sourceAttachment) ??
    pickBestAttachment(attachments, sourceFilename ?? surface.title);

  const filename = sourceFilename ?? surface.title;

  return {
    source: surface.source as GrantSource,
    sourceId: surface.sourceId,
    sourceFilename: filename,
    grant: grant
      ? {
          id: grant.id,
          title: grant.title,
          url: grant.url,
          agencyOperator: grant.agencyOperator,
          status: grant.status,
        }
      : null,
    attachment: attachment
      ? {
          filename: attachment.filename,
          sourceUri: nonEmpty(attachment.sourceUri),
          archiveUrl: nonEmpty(attachment.archiveUrl),
          storageKey: nonEmpty(attachment.storageKey),
          contentType: nonEmpty(attachment.contentType),
        }
      : null,
    surface: {
      id: surface.id,
      title: surface.title,
      format: surface.format,
      sourceUrl: nonEmpty(surface.sourceUrl),
      sourceAttachment: nonEmpty(surface.sourceAttachment),
      extractionStatus: surface.extractionStatus,
    },
  };
}

function pickBestAttachment<T extends {
  filename: string;
  sourceUri: string | null;
  archiveUrl: string | null;
  storageKey: string | null;
}>(rows: T[], filename: string | null): T | null {
  if (rows.length === 0) return null;
  const scored = rows
    .map((row) => ({ row, score: scoreEvidenceCandidate(filename, [
      row.filename,
      row.sourceUri,
      row.archiveUrl,
      row.storageKey,
    ]) }))
    .sort((left, right) => right.score - left.score);
  return scored[0]?.row ?? null;
}

function pickBestSurface<T extends {
  title: string;
  sourceUrl: string | null;
  sourceAttachment: string | null;
}>(rows: T[], filename: string | null, storageKey: string | null): T | null {
  if (rows.length === 0) return null;
  const scored = rows
    .map((row) => {
      const storageMatch = storageKey && row.sourceAttachment === storageKey ? 120 : 0;
      return {
        row,
        score: storageMatch + scoreEvidenceCandidate(filename, [
          row.title,
          row.sourceUrl,
          row.sourceAttachment,
        ]),
      };
    })
    .sort((left, right) => right.score - left.score);
  return scored[0]?.row ?? null;
}

function scoreEvidenceCandidate(filename: string | null, candidates: Array<string | null>): number {
  if (!filename) return 1;
  const target = normalizeEvidenceName(filename);
  if (!target) return 1;

  let score = 0;
  for (const candidate of candidates) {
    const normalized = normalizeEvidenceName(candidate);
    if (!normalized) continue;
    if (normalized === target) score = Math.max(score, 100);
    else if (normalized.includes(target) || target.includes(normalized)) score = Math.max(score, 70);
  }
  return score;
}

function normalizeEvidenceName(value: string | null): string {
  if (!value) return "";
  const basename = value.split(/[\\/]/).at(-1) ?? value;
  try {
    return decodeURIComponent(basename).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  } catch {
    return basename.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  }
}

function nonEmpty(value: string | null): string | null {
  return value && value.trim() ? value : null;
}

/**
 * 페이지 이미지 키가 실제 검수 문서 소유 키인지 검증 (프록시 경로 이탈/임의 키 조회 방지).
 * 문서 수가 소량(수십)이라 전체 조회 후 키 포함 여부를 확인한다.
 */
export async function reviewDocOwnsImageKey(key: string): Promise<boolean> {
  // 접두어 허용목록: spike 임포터(label-review/pages/) + 변환 파이프라인 page_image(grant-convert/).
  // B1 유입기가 등재한 surface 문서는 conversion artifact 키(grant-convert/…)를 참조하므로 함께 허용한다.
  // 실제 소유 검증은 아래 pageImageKeys 포함 여부가 담당한다(접두어는 값싼 사전 차단일 뿐).
  if (!key.startsWith("label-review/pages/") && !key.startsWith("grant-convert/")) return false;
  const db = getCunoteDb();
  const all = await db
    .select({ keys: schema.fieldMapReviewDocs.pageImageKeys })
    .from(schema.fieldMapReviewDocs);
  return all.some((r) => Array.isArray(r.keys) && r.keys.includes(key));
}

/**
 * 초안 저장: labelJson(fields) 갱신 + reviewStatus='in_review'.
 * 이미 approved 인 문서는 초안 저장으로 강등하지 않는다(확정 취소를 거치도록).
 */
export async function saveReviewDraft(
  docId: string,
  labelJson: ReviewLabelJson,
  reviewerComment?: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = getCunoteDb();
  const existing = await getReviewDocByDocId(docId);
  if (!existing) return { ok: false, reason: "not_found" };

  const nextStatus: ReviewStatus =
    existing.reviewStatus === "approved" ? "approved" : "in_review";

  await db
    .update(schema.fieldMapReviewDocs)
    .set({
      labelJson: labelJson as unknown as Record<string, unknown>,
      pageCount: typeof labelJson.pageCount === "number" ? labelJson.pageCount : existing.pageCount,
      // reviewerComment 가 명시적으로 전달됐을 때만 갱신(빈 문자열은 null 로 정규화).
      ...(reviewerComment !== undefined
        ? { reviewerComment: reviewerComment && reviewerComment.trim() ? reviewerComment : null }
        : {}),
      reviewStatus: nextStatus,
      updatedAt: new Date(),
    })
    .where(eq(schema.fieldMapReviewDocs.id, existing.id));
  return { ok: true };
}

/**
 * 검수 확정: reviewStatus='approved' + labeledBy/reviewedBy=검수자 이메일 + golden_set 승격.
 * 트랜잭션으로 리뷰행 갱신과 golden upsert 를 함께 처리한다.
 */
export interface ApprovalReflection {
  surfaceId: string;
  inserted: number;
  updated: number;
  extractionStatus: string;
}

export async function approveReviewDoc(
  docId: string,
  reviewerEmail: string,
  labelJson?: ReviewLabelJson,
): Promise<
  | { ok: true; goldenAction: "insert" | "update"; applied?: ApprovalReflection }
  | { ok: false; reason: string }
> {
  const db = getCunoteDb();
  const existing = await getReviewDocByDocId(docId);
  if (!existing) return { ok: false, reason: "not_found" };

  // 확정과 동시에 마지막 편집분을 반영할 수 있게 labelJson 을 받는다(없으면 저장된 값 사용).
  const base = labelJson ?? existing.labelJson;
  const now = new Date();
  const reviewedAtIso = now.toISOString().slice(0, 10);

  // 파일 파이프라인 규약과 일치: labeledBy 를 검수자 이메일로 갱신.
  const gold: ReviewLabelJson = {
    ...base,
    docRef: existing.docRef,
    labeledBy: reviewerEmail,
    reviewedBy: reviewerEmail,
    labeledAt: reviewedAtIso,
  };

  // 순환성 가드 사전 확인 (이메일이 아니거나 AI 라벨러면 거부).
  const gate = evaluateReviewer(gold.labeledBy, gold.reviewedBy);
  if (!gate.ok) return { ok: false, reason: gate.reason };

  return db.transaction(async (tx) => {
    const promo = await promoteFieldMapGolden(tx, {
      docRef: existing.docRef,
      gold: gold as unknown as Record<string, unknown>,
      labeledBy: gold.labeledBy,
      reviewedBy: gold.reviewedBy,
      goldenVer: DEFAULT_FIELD_MAP_GOLDEN_VER,
      write: true,
    });
    if (!promo.ok) return { ok: false, reason: promo.reason };

    await tx
      .update(schema.fieldMapReviewDocs)
      .set({
        labelJson: gold as unknown as Record<string, unknown>,
        labeledBy: reviewerEmail,
        labeledAt: reviewedAtIso,
        reviewStatus: "approved",
        reviewedBy: reviewerEmail,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.fieldMapReviewDocs.id, existing.id));

    // B3 승인 반영 브리지: surface 네임스페이스 문서면 확정 필드맵을 grant_document_fields 로 반영한다.
    // 같은 트랜잭션에서 applyReconciledFields 를 호출해 golden 승격과 사용자 필드 반영을 원자적으로 처리한다.
    // 스파이크 문서(doc/기존 네임스페이스)는 surfaceIdFromDocRef 가 null → golden 승격만(기존 동작 유지).
    let applied: ApprovalReflection | undefined;
    const surfaceId = surfaceIdFromDocRef(existing.docRef);
    if (surfaceId) {
      const goldFields = (Array.isArray(gold.fields) ? gold.fields : []) as ReviewLabelField[];
      const reconciled = reviewFieldsToReconciled(goldFields);
      const result = await applyReconciledFields({
        db: tx as unknown as CunoteDbSession,
        surfaceId,
        fields: reconciled,
        defaults: existing.sourceFilename ? { documentName: existing.sourceFilename } : {},
      });
      applied = {
        surfaceId,
        inserted: result.inserted,
        updated: result.updated,
        extractionStatus: result.extractionStatus,
      };
    }

    return { ok: true, goldenAction: promo.action, ...(applied ? { applied } : {}) };
  });
}

/**
 * 확정 취소(오확정 복구): reviewStatus='in_review' 로 강등 + golden_set 해당 row 제거.
 * labeledBy 는 검수자 이메일에서 원 라벨러로 되돌리지 않는다(이력 유지). golden 만 롤백한다.
 */
export interface ApprovalWithdrawal {
  surfaceId: string;
  fieldsDeleted: number;
  extractionStatus: string;
}

export async function unapproveReviewDoc(
  docId: string,
): Promise<
  | { ok: true; goldenDeleted: number; withdrawn?: ApprovalWithdrawal }
  | { ok: false; reason: string }
> {
  const db = getCunoteDb();
  const existing = await getReviewDocByDocId(docId);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.reviewStatus !== "approved") return { ok: false, reason: "not_approved" };

  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(schema.goldenSet)
      .where(
        and(
          eq(schema.goldenSet.kind, "field_map"),
          eq(schema.goldenSet.ref, existing.docRef),
          eq(schema.goldenSet.goldenVer, DEFAULT_FIELD_MAP_GOLDEN_VER),
        ),
      )
      .returning({ id: schema.goldenSet.id });

    await tx
      .update(schema.fieldMapReviewDocs)
      .set({ reviewStatus: "in_review", reviewedAt: null, updatedAt: new Date() })
      .where(eq(schema.fieldMapReviewDocs.id, existing.id));

    // B3 반영 철회: surface 네임스페이스면 reconcile-v0 로 반영한 grant_document_fields 를 되돌린다.
    let withdrawn: ApprovalWithdrawal | undefined;
    const surfaceId = surfaceIdFromDocRef(existing.docRef);
    if (surfaceId) {
      // 방어적 확인: 같은 surface 를 공유하는 다른 approved 검수 문서가 없을 때만 철회한다.
      // docRef 가 유니크(surface 당 검수 문서 1개)라 정상적으로는 항상 0건이지만, 회귀 방지로 명시 확인한다.
      const otherApproved = await tx
        .select({ id: schema.fieldMapReviewDocs.id })
        .from(schema.fieldMapReviewDocs)
        .where(
          and(
            eq(schema.fieldMapReviewDocs.docRef, existing.docRef),
            eq(schema.fieldMapReviewDocs.reviewStatus, "approved"),
            ne(schema.fieldMapReviewDocs.id, existing.id),
          ),
        );

      if (otherApproved.length === 0) {
        const removed = await tx
          .delete(schema.grantDocumentFields)
          .where(
            and(
              eq(schema.grantDocumentFields.surfaceId, surfaceId),
              eq(schema.grantDocumentFields.parserVersion, RECONCILE_PARSER_VERSION),
            ),
          )
          .returning({ id: schema.grantDocumentFields.id });

        // surface fields_ready → preview_ready 로 되돌린다(다른 상태는 건드리지 않음).
        const surfaceRows = await tx
          .select({ status: schema.grantApplicationSurfaces.extractionStatus })
          .from(schema.grantApplicationSurfaces)
          .where(eq(schema.grantApplicationSurfaces.id, surfaceId))
          .limit(1);
        let extractionStatus = surfaceRows[0]?.status ?? "unknown";
        if (extractionStatus === "fields_ready") {
          await tx
            .update(schema.grantApplicationSurfaces)
            .set({ extractionStatus: "preview_ready", updatedAt: new Date() })
            .where(eq(schema.grantApplicationSurfaces.id, surfaceId));
          extractionStatus = "preview_ready";
        }
        withdrawn = { surfaceId, fieldsDeleted: removed.length, extractionStatus };
      }
    }

    return { ok: true, goldenDeleted: deleted.length, ...(withdrawn ? { withdrawn } : {}) };
  });
}
