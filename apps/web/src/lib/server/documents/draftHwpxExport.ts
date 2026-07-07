import { and, eq } from "drizzle-orm";
import { detectHwpFormat, fillHwpxTemplate } from "@cunote/core/documents/hwpx-fill";
import type { DocumentDraft, DraftableDocument, Grant } from "@cunote/contracts";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";

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
 * 초안의 원본 hwpx 양식에 값(draft.filledFields + answers, answers 우선)을 채운 파일을 만든다.
 */
export async function buildDraftHwpxDownload(input: {
  draft: DocumentDraft;
  answers?: Record<string, string>;
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

  let source: Buffer;
  try {
    const object = await storage.getObjectBytes(archive.storageKey);
    source = object.body;
  } catch (error) {
    throw new DraftHwpxExportError(
      "hwpx_source_fetch_failed",
      `원본 양식 보관본을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  if (detectHwpFormat(source) !== "hwpx") {
    throw new DraftHwpxExportError(
      "hwpx_disguised_binary",
      "이 양식은 hwpx로 표기됐지만 실제로는 구형 hwp 형식이라 자동 채움을 지원하지 않습니다.",
      415,
    );
  }

  // draft.filledFields 위에 워크스페이스 추가 입력(answers)을 덮어쓴다(answers 우선).
  const values: Record<string, string> = { ...input.draft.filledFields, ...(input.answers ?? {}) };

  try {
    const result = fillHwpxTemplate({ source, values });
    return {
      body: result.output,
      filled: result.filled,
      unfilled: result.unfilled.map((entry) => ({ label: entry.label, reason: entry.reason })),
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
 * draftableDocuments 에 hwpxTemplateAvailable 플래그를 덮어쓴다(설계 결정 6·8, Phase 2).
 * 해당 공고의 보관 첨부 중 파일명이 .hwpx 이고 storageKey 가 있는 것을 배치 조회해,
 * sourceAttachment 파일명이 일치하면 true 로 표시한다. 위장 파일은 다운로드 시 매직바이트로 차단하므로
 * 여기서는 파일명 기반으로 노출만 결정한다. DB 조회 실패 시에는 전부 false(버튼 비노출)로 안전하게 폴백.
 */
export async function annotateHwpxTemplateAvailability(input: {
  grant: { source: Grant["source"]; sourceId: string };
  documents: DraftableDocument[];
}): Promise<DraftableDocument[]> {
  if (input.documents.length === 0) return input.documents;
  const hasAnyAttachment = input.documents.some((document) => Boolean(document.sourceAttachment));
  if (!hasAnyAttachment) return input.documents;

  let hwpxFilenames: Set<string>;
  try {
    const db = getCunoteDb();
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
    hwpxFilenames = new Set(
      rows
        .filter((row) => row.storageKey && row.filename.toLowerCase().endsWith(".hwpx"))
        .map((row) => row.filename),
    );
  } catch (error) {
    console.warn(
      `hwpx 보관본 플래그 조회 실패(버튼 비노출로 폴백): ${error instanceof Error ? error.message : String(error)}`,
    );
    return input.documents;
  }

  if (hwpxFilenames.size === 0) return input.documents;
  return input.documents.map((document) =>
    document.sourceAttachment && hwpxFilenames.has(document.sourceAttachment)
      ? { ...document, hwpxTemplateAvailable: true }
      : document,
  );
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

async function resolveArchiveStorageKey(input: {
  source: Grant["source"];
  sourceId: string;
  filename: string;
}): Promise<{ storageKey: string | null } | null> {
  const db = getCunoteDb();
  const [row] = await db
    .select({ storageKey: schema.grantAttachmentArchives.storageKey })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, input.source),
        eq(schema.grantAttachmentArchives.sourceId, input.sourceId),
        eq(schema.grantAttachmentArchives.filename, input.filename),
      ),
    )
    .limit(1);
  return row ?? null;
}
