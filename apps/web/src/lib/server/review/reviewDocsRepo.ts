/**
 * 필드맵 검수 워크스페이스 데이터 접근 (field_map_review_docs).
 *
 * 검수 확정은 곧 golden_set(kind=field_map) 승격이다.
 * 순환성 가드/승격 upsert 는 공용 모듈(promote-field-map-golden)을 재사용한다.
 */
import { and, asc, eq } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { evaluateReviewer } from "../db/field-map-review-guard";
import {
  DEFAULT_FIELD_MAP_GOLDEN_VER,
  promoteFieldMapGolden,
} from "../db/promote-field-map-golden";

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
  sourceFilename: string | null;
  fieldCount: number;
  pageCount: number | null;
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  hasCorrectionNotes: boolean;
  updatedAt: Date;
}

export interface ReviewDocDetail extends ReviewDocSummary {
  labelJson: ReviewLabelJson;
  labeledBy: string | null;
  labeledAt: string | null;
  correctionNotes: string | null;
  pageImageKeys: string[];
}

function toLabelJson(value: unknown): ReviewLabelJson {
  return (value && typeof value === "object" ? value : {}) as ReviewLabelJson;
}

function fieldCountOf(labelJson: ReviewLabelJson): number {
  return Array.isArray(labelJson.fields) ? labelJson.fields.length : 0;
}

export async function listReviewDocs(): Promise<ReviewDocSummary[]> {
  const db = getCunoteDb();
  const rows = await db
    .select()
    .from(schema.fieldMapReviewDocs)
    .orderBy(asc(schema.fieldMapReviewDocs.docId));
  return rows.map((row) => {
    const labelJson = toLabelJson(row.labelJson);
    return {
      id: row.id,
      docId: row.docId,
      docRef: row.docRef,
      sourceFilename: row.sourceFilename,
      fieldCount: fieldCountOf(labelJson),
      pageCount: row.pageCount,
      reviewStatus: row.reviewStatus as ReviewStatus,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      hasCorrectionNotes: Boolean(row.correctionNotes && row.correctionNotes.trim()),
      updatedAt: row.updatedAt,
    };
  });
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
  return {
    id: row.id,
    docId: row.docId,
    docRef: row.docRef,
    sourceFilename: row.sourceFilename,
    fieldCount: fieldCountOf(labelJson),
    pageCount: row.pageCount,
    reviewStatus: row.reviewStatus as ReviewStatus,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    hasCorrectionNotes: Boolean(row.correctionNotes && row.correctionNotes.trim()),
    updatedAt: row.updatedAt,
    labelJson,
    labeledBy: row.labeledBy,
    labeledAt: row.labeledAt,
    correctionNotes: row.correctionNotes,
    pageImageKeys: Array.isArray(row.pageImageKeys) ? row.pageImageKeys : [],
  };
}

/**
 * 페이지 이미지 키가 실제 검수 문서 소유 키인지 검증 (프록시 경로 이탈/임의 키 조회 방지).
 * 문서 수가 소량(수십)이라 전체 조회 후 키 포함 여부를 확인한다.
 */
export async function reviewDocOwnsImageKey(key: string): Promise<boolean> {
  if (!key.startsWith("label-review/pages/")) return false;
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
export async function approveReviewDoc(
  docId: string,
  reviewerEmail: string,
  labelJson?: ReviewLabelJson,
): Promise<
  | { ok: true; goldenAction: "insert" | "update" }
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

    return { ok: true, goldenAction: promo.action };
  });
}

/**
 * 확정 취소(오확정 복구): reviewStatus='in_review' 로 강등 + golden_set 해당 row 제거.
 * labeledBy 는 검수자 이메일에서 원 라벨러로 되돌리지 않는다(이력 유지). golden 만 롤백한다.
 */
export async function unapproveReviewDoc(
  docId: string,
): Promise<{ ok: true; goldenDeleted: number } | { ok: false; reason: string }> {
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

    return { ok: true, goldenDeleted: deleted.length };
  });
}
