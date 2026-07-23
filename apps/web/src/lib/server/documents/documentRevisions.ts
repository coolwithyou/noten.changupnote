import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { detectHwpFormat } from "@cunote/core/documents/hwpx-fill";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "../storage/r2ObjectStorage";
import type { DraftSourceFile, DraftSourceFormat } from "./draftSourceFile";

const STUDIO_SNAPSHOT_MAX_BYTES = 30 * 1024 * 1024;
const STUDIO_SESSION_ID_MAX_LENGTH = 128;

export interface StudioSnapshotSaveInput {
  draftId: string;
  access: CompanyAccess;
  body: Buffer;
  format: DraftSourceFormat;
  filename: string;
  pageCount: number;
  sessionId: string;
  baseRevisionId: string | null;
  documentEpoch: number;
  changeSeq: number;
  origin: "studio_autosave" | "studio_manual";
  materializedAnswers: Record<string, string>;
  verification: Record<string, unknown>;
}

export interface StudioSnapshotSaveResult {
  revisionId: string;
  headRevisionId: string;
  sha256: string;
  savedAt: string;
  byteSize: number;
  pageCount: number;
}

export class DocumentRevisionError extends Error {
  readonly meta?: Record<string, unknown>;

  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly currentRevisionId?: string | null,
  ) {
    super(message);
    this.name = "DocumentRevisionError";
    if (currentRevisionId !== undefined) {
      this.meta = { currentRevisionId };
    }
  }
}

/**
 * Studio가 검증 내보낸 전체 HWP/HWPX를 R2 + 불변 revision으로 저장하고 draft head를 교체한다.
 *
 * R2 업로드를 DB transaction 밖에서 수행한 뒤 draft row를 FOR UPDATE로 잠가 head를 다시 비교한다.
 * 그 사이 head가 바뀌면 409를 반환한다. 이때 남은 content-addressed object는 같은 바이트 재시도에서
 * 재사용하거나 후속 GC가 제거할 수 있다.
 */
export async function saveStudioSnapshot(
  input: StudioSnapshotSaveInput,
  dependencies: {
    storage?: R2ObjectStorage | null;
  } = {},
): Promise<StudioSnapshotSaveResult> {
  validateSnapshotInput(input);
  const detectedFormat = detectSnapshotFormat(input.body);
  if (detectedFormat !== input.format) {
    throw new DocumentRevisionError(
      "snapshot_format_mismatch",
      `요청 형식(${input.format})과 실제 문서 형식(${detectedFormat})이 다릅니다.`,
      415,
    );
  }

  const db = getCunoteDb();
  const [draft] = await db
    .select({
      id: schema.grantDocumentDrafts.id,
      companyId: schema.grantDocumentDrafts.companyId,
      fieldAnswers: schema.grantDocumentDrafts.fieldAnswers,
      filledFields: schema.grantDocumentDrafts.filledFields,
    })
    .from(schema.grantDocumentDrafts)
    .where(and(
      eq(schema.grantDocumentDrafts.id, input.draftId),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .limit(1);
  if (!draft) {
    throw new DocumentRevisionError("draft_not_found", "저장할 문서 초안을 찾지 못했습니다.", 404);
  }

  const currentHead = await getDraftRevisionHead(input.draftId);
  const sha256 = createHash("sha256").update(input.body).digest("hex");
  const idempotent = await findIdempotentRevision({
    draftId: input.draftId,
    sessionId: input.sessionId,
    documentEpoch: input.documentEpoch,
    changeSeq: input.changeSeq,
    sha256,
  });
  if (idempotent && currentHead?.revisionId === idempotent.id) {
    return toSaveResult(idempotent);
  }
  assertExpectedHead(input.baseRevisionId, currentHead?.revisionId ?? null);

  const storage = dependencies.storage ?? createR2ObjectStorageFromEnv();
  if (!storage) {
    throw new DocumentRevisionError(
      "snapshot_storage_not_configured",
      "문서 저장소가 준비되지 않아 서버에 저장하지 못했습니다.",
      503,
    );
  }

  const revisionId = randomUUID();
  const storageKey = buildRevisionStorageKey({
    draftId: input.draftId,
    revisionId,
    sha256,
    format: input.format,
  });
  try {
    await storage.putObject({
      key: storageKey,
      body: input.body,
      contentType: contentTypeForFormat(input.format),
    });
  } catch (error) {
    throw new DocumentRevisionError(
      "snapshot_upload_failed",
      `문서 작업본을 파일 저장소에 보관하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  const fieldAnswersHash = hashFieldAnswers(draft.fieldAnswers ?? draft.filledFields);
  const saved = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
    const [lockedDraft] = await tx
      .select({ id: schema.grantDocumentDrafts.id })
      .from(schema.grantDocumentDrafts)
      .where(and(
        eq(schema.grantDocumentDrafts.id, input.draftId),
        eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
      ))
      .limit(1)
      .for("update");
    if (!lockedDraft) {
      throw new DocumentRevisionError("draft_not_found", "저장할 문서 초안을 찾지 못했습니다.", 404);
    }

    const [head] = await tx
      .select({ revisionId: schema.grantDocumentRevisionHeads.revisionId })
      .from(schema.grantDocumentRevisionHeads)
      .where(eq(schema.grantDocumentRevisionHeads.draftId, input.draftId))
      .limit(1);

    const [existing] = await tx
      .select()
      .from(schema.grantDocumentRevisions)
      .where(and(
        eq(schema.grantDocumentRevisions.draftId, input.draftId),
        eq(schema.grantDocumentRevisions.studioSessionId, input.sessionId),
        eq(schema.grantDocumentRevisions.documentEpoch, input.documentEpoch),
        eq(schema.grantDocumentRevisions.changeSeq, input.changeSeq),
        eq(schema.grantDocumentRevisions.sha256, sha256),
      ))
      .limit(1);
    if (existing) {
      if (head?.revisionId === existing.id) return existing;
      throw new DocumentRevisionError(
        "revision_conflict",
        "다른 편집 세션에서 저장한 문서가 있습니다. 최신 문서를 다시 불러와 주세요.",
        409,
        head?.revisionId ?? null,
      );
    }
    assertExpectedHead(input.baseRevisionId, head?.revisionId ?? null);

    const [revision] = await tx
      .insert(schema.grantDocumentRevisions)
      .values({
        id: revisionId,
        draftId: input.draftId,
        parentRevisionId: head?.revisionId ?? null,
        origin: input.origin,
        format: input.format,
        artifactStorageKey: storageKey,
        sha256,
        byteSize: input.body.byteLength,
        pageCount: input.pageCount,
        fieldAnswersHash,
        materializedAnswers: input.materializedAnswers,
        verification: {
          ...input.verification,
          detectedFormat: input.format,
          byteSize: input.body.byteLength,
          pageCount: input.pageCount,
        },
        studioSessionId: input.sessionId,
        documentEpoch: input.documentEpoch,
        changeSeq: input.changeSeq,
        createdBy: input.access.userId,
      })
      .returning();
    if (!revision) {
      throw new DocumentRevisionError("snapshot_insert_failed", "문서 revision을 만들지 못했습니다.", 500);
    }

    if (head) {
      const [updatedHead] = await tx
        .update(schema.grantDocumentRevisionHeads)
        .set({ revisionId: revision.id, updatedAt: new Date() })
        .where(and(
          eq(schema.grantDocumentRevisionHeads.draftId, input.draftId),
          eq(schema.grantDocumentRevisionHeads.revisionId, head.revisionId),
        ))
        .returning({ revisionId: schema.grantDocumentRevisionHeads.revisionId });
      if (!updatedHead) {
        throw new DocumentRevisionError(
          "revision_conflict",
          "다른 편집 세션에서 저장한 문서가 있습니다. 최신 문서를 다시 불러와 주세요.",
          409,
          head.revisionId,
        );
      }
    } else {
      await tx.insert(schema.grantDocumentRevisionHeads).values({
        draftId: input.draftId,
        revisionId: revision.id,
        updatedAt: new Date(),
      });
    }

    await tx.insert(schema.grantDocumentDraftEvents).values({
      draftId: input.draftId,
      actorUserId: input.access.userId,
      event: "studio_snapshot_saved",
      payload: {
        revisionId: revision.id,
        parentRevisionId: revision.parentRevisionId,
        format: revision.format,
        byteSize: revision.byteSize,
        pageCount: revision.pageCount,
        documentEpoch: revision.documentEpoch,
        changeSeq: revision.changeSeq,
        origin: revision.origin,
      },
    });

    return revision;
  });

  return toSaveResult(saved);
}

/** 최신 server head가 있으면 해당 R2 artifact를 읽는다. 없으면 null을 반환해 원본 경로로 폴백한다. */
export async function loadDraftHeadRevisionFile(input: {
  draftId: string;
}): Promise<(Omit<DraftSourceFile, "grant"> & {
  revisionId: string;
  savedAt: string;
  materializedAnswers: Record<string, string>;
}) | null> {
  const db = getCunoteDb();
  const [row] = await db
    .select({
      revisionId: schema.grantDocumentRevisions.id,
      format: schema.grantDocumentRevisions.format,
      storageKey: schema.grantDocumentRevisions.artifactStorageKey,
      savedAt: schema.grantDocumentRevisions.createdAt,
      materializedAnswers: schema.grantDocumentRevisions.materializedAnswers,
    })
    .from(schema.grantDocumentRevisionHeads)
    .innerJoin(
      schema.grantDocumentRevisions,
      eq(schema.grantDocumentRevisionHeads.revisionId, schema.grantDocumentRevisions.id),
    )
    .where(eq(schema.grantDocumentRevisionHeads.draftId, input.draftId))
    .limit(1);
  if (!row) return null;
  if (row.format !== "hwp" && row.format !== "hwpx") {
    throw new DocumentRevisionError("snapshot_format_invalid", "저장된 문서 형식이 올바르지 않습니다.", 500);
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    throw new DocumentRevisionError(
      "snapshot_storage_not_configured",
      "문서 저장소가 준비되지 않아 저장본을 불러오지 못했습니다.",
      503,
    );
  }
  let body: Buffer;
  try {
    body = (await storage.getObjectBytes(row.storageKey)).body;
  } catch (error) {
    throw new DocumentRevisionError(
      "snapshot_fetch_failed",
      `저장된 문서 작업본을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
  const detected = detectSnapshotFormat(body);
  if (detected !== row.format) {
    throw new DocumentRevisionError("snapshot_corrupted", "저장된 문서 작업본의 형식을 확인하지 못했습니다.", 500);
  }
  return {
    revisionId: row.revisionId,
    savedAt: row.savedAt.toISOString(),
    materializedAnswers: row.materializedAnswers,
    body,
    filename: `창업노트-작업본.${row.format}`,
    format: row.format,
    contentType: contentTypeForFormat(row.format),
  };
}

export async function getDraftRevisionHead(draftId: string): Promise<{
  revisionId: string;
  sha256: string;
  savedAt: Date;
  materializedAnswers: Record<string, string>;
} | null> {
  const db = getCunoteDb();
  const [row] = await db
    .select({
      revisionId: schema.grantDocumentRevisions.id,
      sha256: schema.grantDocumentRevisions.sha256,
      savedAt: schema.grantDocumentRevisions.createdAt,
      materializedAnswers: schema.grantDocumentRevisions.materializedAnswers,
    })
    .from(schema.grantDocumentRevisionHeads)
    .innerJoin(
      schema.grantDocumentRevisions,
      eq(schema.grantDocumentRevisionHeads.revisionId, schema.grantDocumentRevisions.id),
    )
    .where(eq(schema.grantDocumentRevisionHeads.draftId, draftId))
    .limit(1);
  return row ?? null;
}

function validateSnapshotInput(input: StudioSnapshotSaveInput): void {
  if (!isUuid(input.draftId)) {
    throw new DocumentRevisionError("invalid_draft_id", "문서 초안 식별자가 올바르지 않습니다.", 400);
  }
  if (input.body.byteLength === 0) {
    throw new DocumentRevisionError("snapshot_empty", "빈 문서는 저장할 수 없습니다.", 400);
  }
  if (input.body.byteLength > STUDIO_SNAPSHOT_MAX_BYTES) {
    throw new DocumentRevisionError(
      "snapshot_too_large",
      `Studio 작업본은 ${(STUDIO_SNAPSHOT_MAX_BYTES / 1024 / 1024).toLocaleString("ko-KR")}MB까지 저장할 수 있습니다.`,
      413,
    );
  }
  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1 || input.pageCount > 10_000) {
    throw new DocumentRevisionError("invalid_page_count", "문서 페이지 수가 올바르지 않습니다.", 400);
  }
  if (!input.sessionId || input.sessionId.length > STUDIO_SESSION_ID_MAX_LENGTH) {
    throw new DocumentRevisionError("invalid_session_id", "Studio 세션 식별자가 올바르지 않습니다.", 400);
  }
  if (!Number.isSafeInteger(input.documentEpoch) || input.documentEpoch < 0) {
    throw new DocumentRevisionError("invalid_document_epoch", "문서 epoch 값이 올바르지 않습니다.", 400);
  }
  if (!Number.isSafeInteger(input.changeSeq) || input.changeSeq < 0) {
    throw new DocumentRevisionError("invalid_change_seq", "문서 변경 순번이 올바르지 않습니다.", 400);
  }
  if (input.baseRevisionId !== null && !isUuid(input.baseRevisionId)) {
    throw new DocumentRevisionError("invalid_base_revision", "기준 문서 revision이 올바르지 않습니다.", 400);
  }
  if (Object.keys(input.materializedAnswers).length > 500) {
    throw new DocumentRevisionError(
      "materialized_answers_too_large",
      "문서에 반영된 빠른 작성 항목이 너무 많습니다.",
      400,
    );
  }
  for (const [fieldId, value] of Object.entries(input.materializedAnswers)) {
    if (fieldId.length > 200 || value.length > 4_000) {
      throw new DocumentRevisionError(
        "materialized_answer_invalid",
        "문서에 반영된 빠른 작성 항목이 올바르지 않습니다.",
        400,
      );
    }
  }
}

function assertExpectedHead(expected: string | null, current: string | null): void {
  if (expected === current) return;
  throw new DocumentRevisionError(
    "revision_conflict",
    "다른 편집 세션에서 저장한 문서가 있습니다. 최신 문서를 다시 불러와 주세요.",
    409,
    current,
  );
}

function detectSnapshotFormat(body: Buffer): DraftSourceFormat {
  const detected = detectHwpFormat(body);
  if (detected === "hwp-binary") return "hwp";
  if (detected === "hwpx") return "hwpx";
  throw new DocumentRevisionError(
    "snapshot_unsupported",
    "저장본이 지원되는 HWP/HWPX 형식이 아니거나 손상되었습니다.",
    415,
  );
}

function contentTypeForFormat(format: DraftSourceFormat): DraftSourceFile["contentType"] {
  return format === "hwp" ? "application/x-hwp" : "application/hwp+zip";
}

function buildRevisionStorageKey(input: {
  draftId: string;
  revisionId: string;
  sha256: string;
  format: DraftSourceFormat;
}): string {
  return `grant-drafts/${input.draftId}/revisions/${input.revisionId}-${input.sha256.slice(0, 16)}.${input.format}`;
}

function hashFieldAnswers(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function findIdempotentRevision(input: {
  draftId: string;
  sessionId: string;
  documentEpoch: number;
  changeSeq: number;
  sha256: string;
}) {
  const db = getCunoteDb();
  const [row] = await db
    .select()
    .from(schema.grantDocumentRevisions)
    .where(and(
      eq(schema.grantDocumentRevisions.draftId, input.draftId),
      eq(schema.grantDocumentRevisions.studioSessionId, input.sessionId),
      eq(schema.grantDocumentRevisions.documentEpoch, input.documentEpoch),
      eq(schema.grantDocumentRevisions.changeSeq, input.changeSeq),
      eq(schema.grantDocumentRevisions.sha256, input.sha256),
    ))
    .limit(1);
  return row ?? null;
}

function toSaveResult(row: typeof schema.grantDocumentRevisions.$inferSelect): StudioSnapshotSaveResult {
  return {
    revisionId: row.id,
    headRevisionId: row.id,
    sha256: row.sha256,
    savedAt: row.createdAt.toISOString(),
    byteSize: row.byteSize,
    pageCount: row.pageCount,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
