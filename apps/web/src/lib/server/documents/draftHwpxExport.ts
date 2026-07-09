import { and, eq } from "drizzle-orm";
import { detectHwpFormat, fillHwpxTemplate, normalizeLabel } from "@cunote/core/documents/hwpx-fill";
import type { DocumentDraft, DraftableDocument, Grant } from "@cunote/contracts";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { detectDuplicateNormalizedLabels, type DraftFieldAnswers } from "./fieldAnswers";
import { loadConnectedDocumentFields, resolveArchiveStorageKey } from "./documentFieldLink";

/**
 * hwp2hwpx sibling artifact 의 document_artifacts.kind 값
 * (apps/conversion 이 hwp 바이너리 입력에 대해 올리는 STORE 정규화 hwpx 변환본).
 * hwp2hwpx 트랙 Phase 2: docs/plans/2026-07-08-hwp2hwpx-track.md.
 */
export const HWPX_SIBLING_ARTIFACT_KIND = "hwpx";

/**
 * HWPX 원본 양식 채움 다운로드 서버 배선 — docs/plans/2026-07-07-hwpx-fill-export.md Phase 2.
 *
 * draft(sourceAttachment·grantId) → grants(source·sourceId) → grant_attachment_archives 행 →
 * R2 getObjectBytes(storageKey) → detectHwpFormat 매직바이트 가드 → fillHwpxTemplate.
 * 각 실패 모드는 한국어 메시지 + status 로 정직하게 보고한다(위장 파일/미보관/저장소 미설정/채움 실패).
 */
export class DraftHwpxExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "DraftHwpxExportError";
  }
}

export interface DraftHwpxDownloadResult {
  body: Buffer;
  filled: Array<{ label: string; value: string }>;
  unfilled: Array<{ label: string; reason: string }>;
}

/**
 * 미확정 제안(suggested) 잔여를 미채움 보고 항목으로 나열한다(순수 — 검수 기준 D2).
 * suggested 는 컨펌 게이트에 의해 채움에서 제외되지만, 사용자에게는 "미채움 잔여"로서
 * X-Cunote-Hwpx-Unfilled 에 정직하게 보고돼야 한다(§4.3). dismissed(건너뛰기)는 사용자의
 * 의도적 제외이므로 보고하지 않는다.
 */
export function listSuggestedUnfilled(input: {
  fieldAnswers: DraftFieldAnswers | null | undefined;
  filledFields: Record<string, string>;
}): Array<{ label: string; reason: string }> {
  const entries: Array<{ label: string; reason: string }> = [];
  if (!input.fieldAnswers) return entries;
  for (const [label, answer] of Object.entries(input.fieldAnswers)) {
    if (!answer || answer.status !== "suggested") continue;
    if (!answer.value || answer.value.trim().length === 0) continue;
    if (label in input.filledFields) continue;
    entries.push({
      label,
      reason: "제안 값이 아직 확정되지 않아 채우지 않았습니다. 반영 후 다시 받아주세요.",
    });
  }
  return entries;
}

/**
 * 초안의 원본 hwpx 양식에 서버 저장 파생 filledFields(accepted|edited 만) 를 채운 파일을 만든다.
 * Apply Experience v2 ADR-5: 컨펌 게이트를 서버가 집행 — 클라이언트 answers 동봉은 폐기됐다.
 * 정규화 label 충돌(예: "기업명(국문)"/"기업명(영문)")은 채움에서 제외하고 미채움으로 정직 보고한다.
 * 미확정 제안(suggested)도 미채움 잔여로 정직 보고한다(listSuggestedUnfilled — 검수 기준 D2).
 */
export async function buildDraftHwpxDownload(input: {
  draft: DocumentDraft & { fieldAnswers?: DraftFieldAnswers | null };
}): Promise<DraftHwpxDownloadResult> {
  const filename = input.draft.sourceAttachment?.trim();
  if (!filename) {
    throw new DraftHwpxExportError(
      "hwpx_source_missing",
      "이 서류에는 채울 원본 양식(첨부)이 연결돼 있지 않아 HWPX 채움 다운로드를 제공할 수 없습니다.",
      409,
    );
  }

  const grant = await resolveGrantSource(input.draft.grantId);
  if (!grant) {
    throw new DraftHwpxExportError("grant_not_found", "공고 정보를 찾지 못했습니다.", 404);
  }

  const archive = await resolveArchiveStorageKey({
    source: grant.source,
    sourceId: grant.sourceId,
    filename,
  });
  if (!archive?.storageKey) {
    throw new DraftHwpxExportError(
      "hwpx_archive_not_found",
      "원본 양식 보관본을 찾지 못해 HWPX 채움 다운로드를 제공할 수 없습니다.",
      404,
    );
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    throw new DraftHwpxExportError(
      "storage_not_configured",
      "파일 저장소(R2)가 설정되지 않아 원본 양식을 불러오지 못했습니다.",
      503,
    );
  }

  let archiveBytes: Buffer;
  try {
    const object = await storage.getObjectBytes(archive.storageKey);
    archiveBytes = object.body;
  } catch (error) {
    throw new DraftHwpxExportError(
      "hwpx_source_fetch_failed",
      `원본 양식 보관본을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  // 보관 원본이 hwpx 면 그대로 사용하고, 원본이 hwp 바이너리(확장자 위장 포함)면 hwp2hwpx
  // sibling 변환본(kind="hwpx")으로 합류한다. sibling 이 없으면 정직하게 미준비를 알린다.
  const source = await resolveHwpxTemplateSource({
    archiveBytes,
    loadSiblingBytes: async () => {
      const siblingKey = await resolveHwpxSiblingStorageKey({
        source: grant.source,
        sourceId: grant.sourceId,
        filename,
      });
      if (!siblingKey) return null;
      try {
        const object = await storage.getObjectBytes(siblingKey);
        return object.body;
      } catch (error) {
        throw new DraftHwpxExportError(
          "hwpx_source_fetch_failed",
          `hwpx 변환본을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
          502,
        );
      }
    },
  });

  // 매직 바이트 가드(합류점): 원본 hwpx·sibling 변환본은 통과, 그 외(위장/손상)는 정직 차단.
  if (detectHwpFormat(source) !== "hwpx") {
    throw new DraftHwpxExportError(
      "hwpx_disguised_binary",
      "이 양식은 hwpx로 표기됐지만 실제로는 구형 hwp 형식이라 자동 채움을 지원하지 않습니다.",
      415,
    );
  }

  // ADR-5 label 충돌 정책: 문서에 연결된 grant_document_fields 에서 정규화 label 중복을 감지하고,
  // 충돌하는 label 은 채움에서 제외한다(matchLabelCells 가 첫 셀만 잡는 한계 → 오기입 방지).
  // DB 조회 실패 시에는 충돌 감지를 건너뛰고 안전하게 진행한다(다운로드 자체는 막지 않는다).
  const connectedFields = await loadConnectedDocumentFields({
    source: grant.source,
    sourceId: grant.sourceId,
    sourceAttachment: filename,
  }).catch((error) => {
    console.warn(
      `필드 충돌 감지용 조회 실패(충돌 감지 생략): ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  });
  const { collisions } = detectDuplicateNormalizedLabels(connectedFields.map((field) => field.label));
  const collidingNormalized = new Set(collisions.map((collision) => collision.normalized));

  const values: Record<string, string> = {};
  const collisionUnfilled: Array<{ label: string; reason: string }> = [];
  for (const [label, value] of Object.entries(input.draft.filledFields)) {
    if (collidingNormalized.size > 0 && collidingNormalized.has(normalizeLabel(label))) {
      collisionUnfilled.push({
        label,
        reason: "동일 항목명(정규화 충돌)이라 자동 채움에서 제외했습니다. 원본 양식에서 직접 확인해 주세요.",
      });
      continue;
    }
    values[label] = value;
  }

  // D2: 미확정 제안(suggested)은 채움 제외 대상이지만 "미채움 잔여"로 정직 보고한다.
  const suggestedUnfilled = listSuggestedUnfilled({
    fieldAnswers: input.draft.fieldAnswers,
    filledFields: input.draft.filledFields,
  });

  try {
    const result = fillHwpxTemplate({ source, values });
    return {
      body: result.output,
      filled: result.filled,
      unfilled: [
        ...result.unfilled.map((entry) => ({ label: entry.label, reason: entry.reason })),
        ...collisionUnfilled,
        ...suggestedUnfilled,
      ],
    };
  } catch (error) {
    throw new DraftHwpxExportError(
      "hwpx_fill_failed",
      `원본 HWPX 양식을 채우는 중 오류가 발생했습니다: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}

/**
 * 채움 대상 hwpx 바이트를 결정한다(순수 분기 — DB/R2 의존 없음, 주입된 로더만 사용).
 *  - 보관 원본이 hwpx(매직 바이트) → 그대로 사용(기존 경로 유지).
 *  - 원본이 hwp 바이너리(또는 확장자 위장/기타) → hwp2hwpx sibling 변환본으로 합류.
 *    sibling 이 없으면(loadSiblingBytes → null) 정직하게 미준비를 알린다.
 * hwp2hwpx 트랙 Phase 2: docs/plans/2026-07-08-hwp2hwpx-track.md.
 */
export async function resolveHwpxTemplateSource(input: {
  archiveBytes: Buffer;
  loadSiblingBytes: () => Promise<Buffer | null>;
}): Promise<Buffer> {
  if (detectHwpFormat(input.archiveBytes) === "hwpx") {
    return input.archiveBytes;
  }
  const sibling = await input.loadSiblingBytes();
  if (!sibling) {
    throw new DraftHwpxExportError(
      "hwpx_sibling_not_ready",
      "이 문서의 원본은 hwp 형식이며 아직 hwpx 변환본이 준비되지 않았습니다.",
      409,
    );
  }
  return sibling;
}

/**
 * 문서별 hwpxTemplateAvailable 플래그를 순수하게 판정한다(설계 결정 6·8 + hwp2hwpx Phase 2).
 * true 조건(둘 중 하나):
 *  1) sourceAttachment 파일명이 .hwpx 보관본 집합에 있음(기존 규칙).
 *  2) sourceAttachment 파일명이 hwp2hwpx sibling(kind="hwpx") 보유 surface 집합에 있음(신규).
 * 위장 파일은 다운로드 시 매직 바이트로 차단하므로 여기서는 파일명 기반 노출만 결정한다.
 */
export function resolveHwpxTemplateAvailability(input: {
  documents: DraftableDocument[];
  hwpxArchiveFilenames: Set<string>;
  hwpxSiblingFilenames: Set<string>;
}): DraftableDocument[] {
  if (input.hwpxArchiveFilenames.size === 0 && input.hwpxSiblingFilenames.size === 0) {
    return input.documents;
  }
  return input.documents.map((document) => {
    const name = document.sourceAttachment;
    if (name && (input.hwpxArchiveFilenames.has(name) || input.hwpxSiblingFilenames.has(name))) {
      return { ...document, hwpxTemplateAvailable: true };
    }
    return document;
  });
}

/**
 * draftableDocuments 에 hwpxTemplateAvailable 플래그를 덮어쓴다(설계 결정 6·8, hwp2hwpx Phase 2).
 * 공고 단위 배치 조회 2회로 두 집합을 만든 뒤 순수 판정(resolveHwpxTemplateAvailability)에 합류한다(N+1 없음):
 *  1) grant_attachment_archives: 파일명이 .hwpx 이고 storageKey 존재(기존 규칙).
 *  2) grant_application_surfaces ⨝ document_artifacts(kind="hwpx"): sibling 변환본 보유 surface 의 title.
 *     surface.title 은 첨부 파일명(registerAttachmentConversions)이라 document.sourceAttachment 와 조인된다.
 * DB 조회 실패 시에는 해당 집합을 비워 안전하게 폴백(버튼 비노출).
 */
export async function annotateHwpxTemplateAvailability(input: {
  grant: { source: Grant["source"]; sourceId: string };
  documents: DraftableDocument[];
}): Promise<DraftableDocument[]> {
  if (input.documents.length === 0) return input.documents;
  const hasAnyAttachment = input.documents.some((document) => Boolean(document.sourceAttachment));
  if (!hasAnyAttachment) return input.documents;

  const db = getCunoteDb();

  let hwpxArchiveFilenames = new Set<string>();
  try {
    const rows = await db
      .select({
        filename: schema.grantAttachmentArchives.filename,
        storageKey: schema.grantAttachmentArchives.storageKey,
      })
      .from(schema.grantAttachmentArchives)
      .where(
        and(
          eq(schema.grantAttachmentArchives.source, input.grant.source),
          eq(schema.grantAttachmentArchives.sourceId, input.grant.sourceId),
        ),
      );
    hwpxArchiveFilenames = new Set(
      rows
        .filter((row) => row.storageKey && row.filename.toLowerCase().endsWith(".hwpx"))
        .map((row) => row.filename),
    );
  } catch (error) {
    console.warn(
      `hwpx 보관본 플래그 조회 실패(해당 집합 비움으로 폴백): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let hwpxSiblingFilenames = new Set<string>();
  try {
    const rows = await db
      .select({ title: schema.grantApplicationSurfaces.title })
      .from(schema.documentArtifacts)
      .innerJoin(
        schema.grantApplicationSurfaces,
        eq(schema.documentArtifacts.surfaceId, schema.grantApplicationSurfaces.id),
      )
      .where(
        and(
          eq(schema.grantApplicationSurfaces.source, input.grant.source),
          eq(schema.grantApplicationSurfaces.sourceId, input.grant.sourceId),
          eq(schema.documentArtifacts.kind, HWPX_SIBLING_ARTIFACT_KIND),
        ),
      );
    hwpxSiblingFilenames = new Set(rows.map((row) => row.title));
  } catch (error) {
    console.warn(
      `hwpx sibling 플래그 조회 실패(해당 집합 비움으로 폴백): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return resolveHwpxTemplateAvailability({
    documents: input.documents,
    hwpxArchiveFilenames,
    hwpxSiblingFilenames,
  });
}

/**
 * 문서 sourceAttachment(파일명)에 대응하는 hwp2hwpx sibling 변환본(kind="hwpx")의 storage_key 를 찾는다.
 * surface.title = 첨부 파일명(registerAttachmentConversions)을 조인 근거로 삼는다. 없으면 null.
 */
async function resolveHwpxSiblingStorageKey(input: {
  source: Grant["source"];
  sourceId: string;
  filename: string;
}): Promise<string | null> {
  const db = getCunoteDb();
  const [row] = await db
    .select({ storageKey: schema.documentArtifacts.storageKey })
    .from(schema.documentArtifacts)
    .innerJoin(
      schema.grantApplicationSurfaces,
      eq(schema.documentArtifacts.surfaceId, schema.grantApplicationSurfaces.id),
    )
    .where(
      and(
        eq(schema.grantApplicationSurfaces.source, input.source),
        eq(schema.grantApplicationSurfaces.sourceId, input.sourceId),
        eq(schema.grantApplicationSurfaces.title, input.filename),
        eq(schema.documentArtifacts.kind, HWPX_SIBLING_ARTIFACT_KIND),
      ),
    )
    .limit(1);
  return row?.storageKey ?? null;
}

async function resolveGrantSource(
  grantId: string,
): Promise<{ source: Grant["source"]; sourceId: string } | null> {
  const db = getCunoteDb();
  const [row] = await db
    .select({ source: schema.grants.source, sourceId: schema.grants.sourceId })
    .from(schema.grants)
    .where(eq(schema.grants.id, grantId))
    .limit(1);
  return row ?? null;
}

// resolveArchiveStorageKey 는 documentFieldLink.ts 로 호이스트됐다(workspaceData 와 공유 — 사본 금지).
