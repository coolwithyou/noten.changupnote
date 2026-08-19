import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { detectHwpFormat } from "@cunote/core/documents/hwpx-fill";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "../storage/r2ObjectStorage";
import type { DraftSourceFile, DraftSourceFormat } from "./draftSourceFile";
import {
  deriveFilledFields,
  normalizeAnswerLabel,
  resolveFieldAnswers,
  type DraftFieldAnswers,
} from "./fieldAnswers";

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
  origin: StudioSnapshotOrigin;
  checkpointRequestId: string | null;
  agentSuggestionId?: string | null;
  fieldAgentSuggestionId?: string | null;
  agentOperation?: "apply" | "undo" | null;
  operationVersion?: number | null;
  materializedAnswers: Record<string, string>;
  verification: Record<string, unknown>;
}

export type StudioSnapshotOrigin =
  | "studio_autosave"
  | "studio_manual"
  | "studio_agent_checkpoint"
  | "studio_agent_apply"
  | "studio_agent_undo";

export interface StudioSnapshotSaveResult {
  revisionId: string;
  headRevisionId: string;
  sha256: string;
  savedAt: string;
  byteSize: number;
  pageCount: number;
}

export interface ExactDraftRevisionFile {
  revisionId: string;
  draftId: string;
  parentRevisionId: string | null;
  origin: string;
  checkpointRequestId: string | null;
  sha256: string;
  format: DraftSourceFormat;
  body: Buffer;
  byteSize: number;
  pageCount: number;
  studioSessionId: string;
  documentEpoch: number;
  changeSeq: number;
  createdBy: string;
  createdAt: Date;
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
  const agentRequest = isAgentSnapshot(input) ? input : null;
  const agentPreauthorization = agentRequest
    ? await authorizeAgentSnapshotPreupload({ input: agentRequest, sha256, currentHead })
    : null;
  if (agentPreauthorization?.existingRevision) {
    return toSaveResult(agentPreauthorization.existingRevision);
  }
  if (input.origin === "studio_agent_checkpoint") {
    const checkpoint = await findCheckpointRevision({
      draftId: input.draftId,
      createdBy: input.access.userId,
      checkpointRequestId: input.checkpointRequestId!,
    });
    if (checkpoint) {
      assertCheckpointReplay({ input, sha256, checkpoint, currentHead });
      return toSaveResult(checkpoint);
    }
  } else if (!agentPreauthorization) {
    const idempotent = await findLegacyIdempotentRevision({
      draftId: input.draftId,
      sessionId: input.sessionId,
      documentEpoch: input.documentEpoch,
      changeSeq: input.changeSeq,
      sha256,
    });
    if (idempotent) {
      if (currentHead?.revisionId === idempotent.id) return toSaveResult(idempotent);
      if (currentHead && isCheckpointChildOfLegacyReplay(currentHead, idempotent.id, sha256)) {
        const checkpointHead = await getRevisionById(currentHead.revisionId);
        if (checkpointHead) return toSaveResult(checkpointHead);
      }
      throw revisionConflict(currentHead?.revisionId ?? null);
    }
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

  const saved = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
    const [lockedDraft] = await tx
      .select({
        id: schema.grantDocumentDrafts.id,
        fieldAnswers: schema.grantDocumentDrafts.fieldAnswers,
        filledFields: schema.grantDocumentDrafts.filledFields,
      })
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
      .select({
        revisionId: schema.grantDocumentRevisionHeads.revisionId,
        parentRevisionId: schema.grantDocumentRevisions.parentRevisionId,
        origin: schema.grantDocumentRevisions.origin,
        sha256: schema.grantDocumentRevisions.sha256,
        materializedAnswers: schema.grantDocumentRevisions.materializedAnswers,
      })
      .from(schema.grantDocumentRevisionHeads)
      .innerJoin(
        schema.grantDocumentRevisions,
        eq(schema.grantDocumentRevisionHeads.revisionId, schema.grantDocumentRevisions.id),
      )
      .where(eq(schema.grantDocumentRevisionHeads.draftId, input.draftId))
      .limit(1);

    let transactionAgentAuthorization: AnyAgentSnapshotAuthorization | null = null;
    if (input.origin === "studio_agent_checkpoint") {
      const [existingCheckpoint] = await tx
        .select()
        .from(schema.grantDocumentRevisions)
        .where(and(
          eq(schema.grantDocumentRevisions.draftId, input.draftId),
          eq(schema.grantDocumentRevisions.createdBy, input.access.userId),
          eq(schema.grantDocumentRevisions.checkpointRequestId, input.checkpointRequestId!),
        ))
        .limit(1);
      if (existingCheckpoint) {
        assertCheckpointReplay({ input, sha256, checkpoint: existingCheckpoint, currentHead: head ?? null });
        return existingCheckpoint;
      }
    } else if (agentPreauthorization) {
      transactionAgentAuthorization = await authorizeAgentSnapshotInTransaction({
        tx,
        input: agentRequest!,
        sha256,
        currentHead: head ?? null,
      });
      if (transactionAgentAuthorization.existingRevision) {
        return transactionAgentAuthorization.existingRevision;
      }
    } else {
      const [existing] = await tx
        .select()
        .from(schema.grantDocumentRevisions)
        .where(and(
          eq(schema.grantDocumentRevisions.draftId, input.draftId),
          eq(schema.grantDocumentRevisions.studioSessionId, input.sessionId),
          eq(schema.grantDocumentRevisions.documentEpoch, input.documentEpoch),
          eq(schema.grantDocumentRevisions.changeSeq, input.changeSeq),
          eq(schema.grantDocumentRevisions.sha256, sha256),
          isNull(schema.grantDocumentRevisions.checkpointRequestId),
          isNull(schema.grantDocumentRevisions.agentCommandId),
        ))
        .limit(1);
      if (existing) {
        if (head?.revisionId === existing.id) return existing;
        if (isCheckpointChildOfLegacyReplay(head ?? null, existing.id, sha256)) {
          const [checkpointHead] = await tx
            .select()
            .from(schema.grantDocumentRevisions)
            .where(eq(schema.grantDocumentRevisions.id, head!.revisionId))
            .limit(1);
          if (checkpointHead) return checkpointHead;
        }
        throw revisionConflict(head?.revisionId ?? null);
      }
    }
    assertExpectedHead(input.baseRevisionId, head?.revisionId ?? null);

    const fieldProjection = transactionAgentAuthorization?.kind === "field"
      ? buildFieldAgentProjection({
          authorization: transactionAgentAuthorization,
          currentAnswers: resolveFieldAnswers(lockedDraft),
          currentMaterializedAnswers: head?.materializedAnswers ?? {},
          revisionId,
        })
      : null;
    const revisionFieldAnswers = fieldProjection?.fieldAnswers ?? resolveFieldAnswers(lockedDraft);
    const revisionMaterializedAnswers = fieldProjection?.materializedAnswers ?? input.materializedAnswers;
    const fieldAnswersHash = hashFieldAnswers(revisionFieldAnswers);

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
        materializedAnswers: revisionMaterializedAnswers,
        verification: {
          ...input.verification,
          detectedFormat: input.format,
          byteSize: input.body.byteLength,
          pageCount: input.pageCount,
        },
        studioSessionId: input.sessionId,
        documentEpoch: input.documentEpoch,
        changeSeq: input.changeSeq,
        checkpointRequestId: input.checkpointRequestId,
        agentCommandId: transactionAgentAuthorization?.commandId ?? null,
        agentOperation: transactionAgentAuthorization?.operation ?? null,
        agentRunId: transactionAgentAuthorization?.kind === "document"
          ? transactionAgentAuthorization.run.id
          : null,
        agentSuggestionId: transactionAgentAuthorization?.kind === "document"
          ? transactionAgentAuthorization.suggestion.id
          : null,
        fieldAgentRunId: transactionAgentAuthorization?.kind === "field"
          ? transactionAgentAuthorization.run.id
          : null,
        fieldAgentSuggestionId: transactionAgentAuthorization?.kind === "field"
          ? transactionAgentAuthorization.suggestion.id
          : null,
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

    if (transactionAgentAuthorization?.kind === "document") {
      const authorization = transactionAgentAuthorization;
      const operationValues = authorization.operation === "apply"
        ? {
            status: "applied",
            statusVersion: authorization.suggestion.statusVersion + 1,
            operationState: "idle",
            operationVersion: authorization.suggestion.operationVersion + 1,
            operationStartedAt: null,
            operationClientId: null,
            failureCode: null,
            appliedDocumentSha256: sha256,
            appliedRevisionId: revision.id,
            appliedAt: new Date(),
            updatedAt: new Date(),
          }
        : {
            status: "undone",
            statusVersion: authorization.suggestion.statusVersion + 1,
            operationState: "idle",
            operationVersion: authorization.suggestion.operationVersion + 1,
            operationStartedAt: null,
            operationClientId: null,
            failureCode: null,
            undoneDocumentSha256: sha256,
            undoneRevisionId: revision.id,
            undoneAt: new Date(),
            updatedAt: new Date(),
          };
      const [transitioned] = await tx
        .update(schema.grantDocumentAgentSuggestions)
        .set(operationValues)
        .where(and(
          eq(schema.grantDocumentAgentSuggestions.id, authorization.suggestion.id),
          eq(schema.grantDocumentAgentSuggestions.statusVersion, authorization.suggestion.statusVersion),
          eq(schema.grantDocumentAgentSuggestions.operationVersion, authorization.suggestion.operationVersion),
        ))
        .returning({ id: schema.grantDocumentAgentSuggestions.id });
      if (!transitioned) throw revisionConflict(head?.revisionId ?? null);
      if (authorization.operation === "apply") {
        await tx
          .update(schema.grantDocumentAgentSuggestions)
          .set({
            status: "stale",
            statusVersion: sql`${schema.grantDocumentAgentSuggestions.statusVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(schema.grantDocumentAgentSuggestions.runId, authorization.run.id),
            eq(schema.grantDocumentAgentSuggestions.status, "pending"),
          ));
      }
    }

    if (transactionAgentAuthorization?.kind === "field") {
      const authorization = transactionAgentAuthorization;
      const operationValues = authorization.operation === "apply"
        ? {
            status: "applied",
            statusVersion: authorization.suggestion.statusVersion + 1,
            operationState: "idle",
            operationVersion: authorization.suggestion.operationVersion + 1,
            operationStartedAt: null,
            operationClientId: null,
            failureCode: null,
            appliedDocumentSha256: sha256,
            appliedRevisionId: revision.id,
            appliedAt: new Date(),
            updatedAt: new Date(),
          }
        : {
            status: "undone",
            statusVersion: authorization.suggestion.statusVersion + 1,
            operationState: "idle",
            operationVersion: authorization.suggestion.operationVersion + 1,
            operationStartedAt: null,
            operationClientId: null,
            failureCode: null,
            undoneDocumentSha256: sha256,
            undoneRevisionId: revision.id,
            undoneAt: new Date(),
            updatedAt: new Date(),
          };
      const [transitioned] = await tx.update(schema.grantDocumentFieldAgentSuggestions)
        .set(operationValues)
        .where(and(
          eq(schema.grantDocumentFieldAgentSuggestions.id, authorization.suggestion.id),
          eq(schema.grantDocumentFieldAgentSuggestions.statusVersion, authorization.suggestion.statusVersion),
          eq(schema.grantDocumentFieldAgentSuggestions.operationVersion, authorization.suggestion.operationVersion),
        ))
        .returning({ id: schema.grantDocumentFieldAgentSuggestions.id });
      if (!transitioned || !fieldProjection) throw revisionConflict(head?.revisionId ?? null);
      await tx.update(schema.grantDocumentDrafts).set({
        fieldAnswers: fieldProjection.fieldAnswers,
        filledFields: deriveFilledFields(fieldProjection.fieldAnswers),
        updatedAt: new Date(),
      }).where(eq(schema.grantDocumentDrafts.id, input.draftId));
    }

    await tx.insert(schema.grantDocumentDraftEvents).values({
      draftId: input.draftId,
      actorUserId: input.access.userId,
      event: transactionAgentAuthorization
        ? transactionAgentAuthorization.kind === "field"
          ? transactionAgentAuthorization.operation === "apply"
            ? "field_agent_suggestion_applied"
            : "field_agent_suggestion_undone"
          : transactionAgentAuthorization.operation === "apply"
            ? "document_agent_suggestion_applied"
            : "document_agent_suggestion_undone"
        : "studio_snapshot_saved",
      payload: {
        revisionId: revision.id,
        parentRevisionId: revision.parentRevisionId,
        format: revision.format,
        byteSize: revision.byteSize,
        pageCount: revision.pageCount,
        documentEpoch: revision.documentEpoch,
        changeSeq: revision.changeSeq,
        origin: revision.origin,
        ...(transactionAgentAuthorization ? {
          runId: transactionAgentAuthorization.run.id,
          suggestionId: transactionAgentAuthorization.suggestion.id,
          operation: transactionAgentAuthorization.operation,
        } : {}),
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

/** 문서 agent가 권위값으로 쓰는 exact immutable revision 바이트를 소유권 범위에서 검증해 읽는다. */
export async function loadExactDraftRevisionFile(input: {
  draftId: string;
  revisionId: string;
  access: CompanyAccess;
  requireCreator?: boolean;
}, dependencies: {
  storage?: R2ObjectStorage | null;
} = {}): Promise<ExactDraftRevisionFile> {
  if (!isUuid(input.draftId) || !isUuid(input.revisionId)) {
    throw new DocumentRevisionError("invalid_revision_id", "문서 revision 식별자가 올바르지 않습니다.", 400);
  }
  const db = getCunoteDb();
  const [row] = await db
    .select({
      revisionId: schema.grantDocumentRevisions.id,
      draftId: schema.grantDocumentRevisions.draftId,
      parentRevisionId: schema.grantDocumentRevisions.parentRevisionId,
      origin: schema.grantDocumentRevisions.origin,
      checkpointRequestId: schema.grantDocumentRevisions.checkpointRequestId,
      sha256: schema.grantDocumentRevisions.sha256,
      format: schema.grantDocumentRevisions.format,
      storageKey: schema.grantDocumentRevisions.artifactStorageKey,
      byteSize: schema.grantDocumentRevisions.byteSize,
      pageCount: schema.grantDocumentRevisions.pageCount,
      studioSessionId: schema.grantDocumentRevisions.studioSessionId,
      documentEpoch: schema.grantDocumentRevisions.documentEpoch,
      changeSeq: schema.grantDocumentRevisions.changeSeq,
      createdBy: schema.grantDocumentRevisions.createdBy,
      createdAt: schema.grantDocumentRevisions.createdAt,
    })
    .from(schema.grantDocumentRevisions)
    .innerJoin(
      schema.grantDocumentDrafts,
      eq(schema.grantDocumentRevisions.draftId, schema.grantDocumentDrafts.id),
    )
    .where(and(
      eq(schema.grantDocumentRevisions.id, input.revisionId),
      eq(schema.grantDocumentRevisions.draftId, input.draftId),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
      ...(input.requireCreator
        ? [eq(schema.grantDocumentRevisions.createdBy, input.access.userId)]
        : []),
    ))
    .limit(1);
  if (!row) {
    throw new DocumentRevisionError("revision_not_found", "문서 revision을 찾지 못했습니다.", 404);
  }
  if (row.format !== "hwp" && row.format !== "hwpx") {
    throw new DocumentRevisionError("snapshot_format_invalid", "저장된 문서 형식이 올바르지 않습니다.", 500);
  }
  const storage = dependencies.storage ?? createR2ObjectStorageFromEnv();
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
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (
    sha256 !== row.sha256
    || body.byteLength !== row.byteSize
    || detectSnapshotFormat(body) !== row.format
  ) {
    throw new DocumentRevisionError("snapshot_corrupted", "저장된 문서 작업본의 무결성이 맞지 않습니다.", 500);
  }
  return {
    revisionId: row.revisionId,
    draftId: row.draftId,
    parentRevisionId: row.parentRevisionId,
    origin: row.origin,
    checkpointRequestId: row.checkpointRequestId,
    sha256,
    format: row.format,
    body,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    studioSessionId: row.studioSessionId,
    documentEpoch: row.documentEpoch,
    changeSeq: row.changeSeq,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export async function getDraftRevisionHead(draftId: string): Promise<{
  revisionId: string;
  parentRevisionId: string | null;
  origin: string;
  sha256: string;
  savedAt: Date;
  materializedAnswers: Record<string, string>;
} | null> {
  const db = getCunoteDb();
  const [row] = await db
    .select({
      revisionId: schema.grantDocumentRevisions.id,
      parentRevisionId: schema.grantDocumentRevisions.parentRevisionId,
      origin: schema.grantDocumentRevisions.origin,
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
  if (input.origin === "studio_agent_checkpoint") {
    if (!input.checkpointRequestId || !isUuid(input.checkpointRequestId)) {
      throw new DocumentRevisionError(
        "invalid_checkpoint_request",
        "AI 제안 checkpoint 요청 식별자가 올바르지 않습니다.",
        400,
      );
    }
  } else if (input.checkpointRequestId !== null) {
    throw new DocumentRevisionError(
      "unexpected_checkpoint_request",
      "일반 Studio 저장에는 checkpoint 요청 식별자를 넣을 수 없습니다.",
      400,
    );
  }
  if (isAgentSnapshot(input)) {
    const suggestionIds = [input.agentSuggestionId, input.fieldAgentSuggestionId].filter(
      (value): value is string => typeof value === "string",
    );
    if (suggestionIds.length !== 1 || !isUuid(suggestionIds[0]!)) {
      throw new DocumentRevisionError("invalid_agent_suggestion", "AI 제안 식별자가 올바르지 않습니다.", 400);
    }
    if (
      !Number.isSafeInteger(input.operationVersion)
      || (input.operationVersion as number) < 1
    ) {
      throw new DocumentRevisionError("invalid_agent_operation_version", "AI 작업 버전이 올바르지 않습니다.", 400);
    }
    const expectedOrigin = input.agentOperation === "apply"
      ? "studio_agent_apply"
      : "studio_agent_undo";
    if (input.origin !== expectedOrigin) {
      throw new DocumentRevisionError("agent_origin_mismatch", "AI 작업과 저장 유형이 일치하지 않습니다.", 400);
    }
  } else if (
    input.agentSuggestionId != null
    || input.fieldAgentSuggestionId != null
    || input.agentOperation != null
    || input.operationVersion != null
  ) {
    throw new DocumentRevisionError("unexpected_agent_operation", "일반 저장에는 AI 작업 정보를 넣을 수 없습니다.", 400);
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

async function findLegacyIdempotentRevision(input: {
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
      isNull(schema.grantDocumentRevisions.checkpointRequestId),
      isNull(schema.grantDocumentRevisions.agentCommandId),
    ))
    .limit(1);
  return row ?? null;
}

async function findCheckpointRevision(input: {
  draftId: string;
  createdBy: string;
  checkpointRequestId: string;
}) {
  const db = getCunoteDb();
  const [row] = await db
    .select()
    .from(schema.grantDocumentRevisions)
    .where(and(
      eq(schema.grantDocumentRevisions.draftId, input.draftId),
      eq(schema.grantDocumentRevisions.createdBy, input.createdBy),
      eq(schema.grantDocumentRevisions.checkpointRequestId, input.checkpointRequestId),
    ))
    .limit(1);
  return row ?? null;
}

async function getRevisionById(revisionId: string) {
  const db = getCunoteDb();
  const [row] = await db
    .select()
    .from(schema.grantDocumentRevisions)
    .where(eq(schema.grantDocumentRevisions.id, revisionId))
    .limit(1);
  return row ?? null;
}

interface AgentSnapshotAuthorization {
  kind: "document";
  operation: "apply" | "undo";
  commandId: string;
  run: typeof schema.grantDocumentAgentRuns.$inferSelect;
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect;
  existingRevision: typeof schema.grantDocumentRevisions.$inferSelect | null;
}

interface FieldAgentSnapshotAuthorization {
  kind: "field";
  operation: "apply" | "undo";
  commandId: string;
  run: typeof schema.grantDocumentFieldAgentRuns.$inferSelect;
  suggestion: typeof schema.grantDocumentFieldAgentSuggestions.$inferSelect;
  existingRevision: typeof schema.grantDocumentRevisions.$inferSelect | null;
}

type AnyAgentSnapshotAuthorization = AgentSnapshotAuthorization | FieldAgentSnapshotAuthorization;

type RevisionTx = Parameters<Parameters<ReturnType<typeof getCunoteDb>["transaction"]>[0]>[0];

function isAgentSnapshot(input: StudioSnapshotSaveInput): input is StudioSnapshotSaveInput & {
  agentOperation: "apply" | "undo";
  operationVersion: number;
} {
  return input.agentOperation === "apply" || input.agentOperation === "undo";
}

async function authorizeAgentSnapshotPreupload(input: {
  input: StudioSnapshotSaveInput & {
    agentOperation: "apply" | "undo";
    operationVersion: number;
  };
  sha256: string;
  currentHead: {
    revisionId: string;
    parentRevisionId: string | null;
    origin: string;
    sha256: string;
  } | null;
}): Promise<AnyAgentSnapshotAuthorization> {
  if (input.input.fieldAgentSuggestionId) return authorizeFieldAgentSnapshotPreupload(input);
  if (!input.input.agentSuggestionId) {
    throw new DocumentRevisionError("invalid_agent_suggestion", "AI 제안 식별자가 올바르지 않습니다.", 400);
  }
  const documentInput = { ...input.input, agentSuggestionId: input.input.agentSuggestionId };
  const db = getCunoteDb();
  const joined = await loadAgentSnapshotRows(db, documentInput);
  const commandId = agentCommandId(documentInput.agentSuggestionId, documentInput.agentOperation);
  const [existingRevision] = await db
    .select()
    .from(schema.grantDocumentRevisions)
    .where(eq(schema.grantDocumentRevisions.agentCommandId, commandId))
    .limit(1);
  if (existingRevision) {
    assertExistingAgentCommandReplay({
      request: documentInput,
      sha256: input.sha256,
      currentHead: input.currentHead,
      existingRevision,
      ...joined,
    });
    return { kind: "document", ...joined, operation: input.input.agentOperation, commandId, existingRevision };
  }
  assertActiveAgentSnapshotAuthorization({
    request: input.input,
    currentHead: input.currentHead,
    ...joined,
  });
  return { kind: "document", ...joined, operation: input.input.agentOperation, commandId, existingRevision: null };
}

async function authorizeAgentSnapshotInTransaction(input: {
  tx: RevisionTx;
  input: StudioSnapshotSaveInput & {
    agentOperation: "apply" | "undo";
    operationVersion: number;
  };
  sha256: string;
  currentHead: {
    revisionId: string;
    parentRevisionId: string | null;
    origin: string;
    sha256: string;
  } | null;
}): Promise<AnyAgentSnapshotAuthorization> {
  if (input.input.fieldAgentSuggestionId) return authorizeFieldAgentSnapshotInTransaction(input);
  if (!input.input.agentSuggestionId) {
    throw new DocumentRevisionError("invalid_agent_suggestion", "AI 제안 식별자가 올바르지 않습니다.", 400);
  }
  const documentInput = { ...input.input, agentSuggestionId: input.input.agentSuggestionId };
  await input.tx.execute(sql`
    SELECT id FROM grant_document_agent_suggestions
    WHERE id = ${input.input.agentSuggestionId}
      AND draft_id = ${input.input.draftId}
      AND created_by = ${input.input.access.userId}
    FOR UPDATE
  `);
  const joined = await loadAgentSnapshotRows(input.tx, documentInput);
  const commandId = agentCommandId(documentInput.agentSuggestionId, documentInput.agentOperation);
  const [existingRevision] = await input.tx
    .select()
    .from(schema.grantDocumentRevisions)
    .where(eq(schema.grantDocumentRevisions.agentCommandId, commandId))
    .limit(1);
  if (existingRevision) {
    assertExistingAgentCommandReplay({
      request: documentInput,
      sha256: input.sha256,
      currentHead: input.currentHead,
      existingRevision,
      ...joined,
    });
    return { kind: "document", ...joined, operation: input.input.agentOperation, commandId, existingRevision };
  }
  assertActiveAgentSnapshotAuthorization({
    request: input.input,
    currentHead: input.currentHead,
    ...joined,
  });
  return { kind: "document", ...joined, operation: input.input.agentOperation, commandId, existingRevision: null };
}

async function authorizeFieldAgentSnapshotPreupload(input: {
  input: StudioSnapshotSaveInput & {
    agentOperation: "apply" | "undo";
    operationVersion: number;
  };
  sha256: string;
  currentHead: { revisionId: string; sha256: string } | null;
}): Promise<FieldAgentSnapshotAuthorization> {
  const suggestionId = input.input.fieldAgentSuggestionId;
  if (!suggestionId) {
    throw new DocumentRevisionError("invalid_field_agent_suggestion", "AI 필드 제안 식별자가 올바르지 않습니다.", 400);
  }
  const db = getCunoteDb();
  const joined = await loadFieldAgentSnapshotRows(db, input.input, suggestionId);
  const commandId = fieldAgentCommandId(suggestionId, input.input.agentOperation);
  const [existingRevision] = await db.select().from(schema.grantDocumentRevisions)
    .where(eq(schema.grantDocumentRevisions.agentCommandId, commandId)).limit(1);
  if (existingRevision) {
    assertExistingFieldAgentCommandReplay({
      request: input.input,
      sha256: input.sha256,
      currentHead: input.currentHead,
      existingRevision,
      ...joined,
    });
    return { kind: "field", ...joined, operation: input.input.agentOperation, commandId, existingRevision };
  }
  assertActiveFieldAgentSnapshotAuthorization({ request: input.input, currentHead: input.currentHead, ...joined });
  return { kind: "field", ...joined, operation: input.input.agentOperation, commandId, existingRevision: null };
}

async function authorizeFieldAgentSnapshotInTransaction(input: {
  tx: RevisionTx;
  input: StudioSnapshotSaveInput & {
    agentOperation: "apply" | "undo";
    operationVersion: number;
  };
  sha256: string;
  currentHead: { revisionId: string; sha256: string } | null;
}): Promise<FieldAgentSnapshotAuthorization> {
  const suggestionId = input.input.fieldAgentSuggestionId;
  if (!suggestionId) {
    throw new DocumentRevisionError("invalid_field_agent_suggestion", "AI 필드 제안 식별자가 올바르지 않습니다.", 400);
  }
  await input.tx.execute(sql`
    SELECT id FROM grant_document_field_agent_suggestions
    WHERE id = ${suggestionId}
      AND draft_id = ${input.input.draftId}
      AND created_by = ${input.input.access.userId}
    FOR UPDATE
  `);
  const joined = await loadFieldAgentSnapshotRows(input.tx, input.input, suggestionId);
  const commandId = fieldAgentCommandId(suggestionId, input.input.agentOperation);
  const [existingRevision] = await input.tx.select().from(schema.grantDocumentRevisions)
    .where(eq(schema.grantDocumentRevisions.agentCommandId, commandId)).limit(1);
  if (existingRevision) {
    assertExistingFieldAgentCommandReplay({
      request: input.input,
      sha256: input.sha256,
      currentHead: input.currentHead,
      existingRevision,
      ...joined,
    });
    return { kind: "field", ...joined, operation: input.input.agentOperation, commandId, existingRevision };
  }
  assertActiveFieldAgentSnapshotAuthorization({ request: input.input, currentHead: input.currentHead, ...joined });
  return { kind: "field", ...joined, operation: input.input.agentOperation, commandId, existingRevision: null };
}

async function loadFieldAgentSnapshotRows(
  db: Pick<ReturnType<typeof getCunoteDb>, "select">,
  input: StudioSnapshotSaveInput,
  suggestionId: string,
): Promise<{
  run: typeof schema.grantDocumentFieldAgentRuns.$inferSelect;
  suggestion: typeof schema.grantDocumentFieldAgentSuggestions.$inferSelect;
}> {
  const [joined] = await db.select({
    suggestion: schema.grantDocumentFieldAgentSuggestions,
    run: schema.grantDocumentFieldAgentRuns,
  }).from(schema.grantDocumentFieldAgentSuggestions)
    .innerJoin(
      schema.grantDocumentFieldAgentRuns,
      eq(schema.grantDocumentFieldAgentSuggestions.runId, schema.grantDocumentFieldAgentRuns.id),
    )
    .where(and(
      eq(schema.grantDocumentFieldAgentSuggestions.id, suggestionId),
      eq(schema.grantDocumentFieldAgentSuggestions.draftId, input.draftId),
      eq(schema.grantDocumentFieldAgentSuggestions.createdBy, input.access.userId),
    )).limit(1);
  if (!joined) {
    throw new DocumentRevisionError("field_agent_suggestion_not_found", "AI 필드 제안을 찾지 못했습니다.", 404);
  }
  return joined;
}

function assertActiveFieldAgentSnapshotAuthorization(input: {
  request: StudioSnapshotSaveInput & { agentOperation: "apply" | "undo"; operationVersion: number };
  currentHead: { revisionId: string; sha256: string } | null;
  run: typeof schema.grantDocumentFieldAgentRuns.$inferSelect;
  suggestion: typeof schema.grantDocumentFieldAgentSuggestions.$inferSelect;
}): void {
  const { request, currentHead, run, suggestion } = input;
  if (suggestion.operationVersion !== request.operationVersion) throw revisionConflict(currentHead?.revisionId ?? null);
  if (request.agentOperation === "apply") {
    if (
      run.status !== "ready"
      || suggestion.status !== "pending"
      || suggestion.operationState !== "apply_saving"
      || currentHead?.revisionId !== run.baseRevisionId
      || currentHead.sha256 !== run.documentSha256
    ) throw revisionConflict(currentHead?.revisionId ?? null);
  } else if (
    suggestion.status !== "applied"
    || suggestion.operationState !== "undo_saving"
    || currentHead?.revisionId !== suggestion.appliedRevisionId
    || currentHead.sha256 !== suggestion.appliedDocumentSha256
  ) {
    throw revisionConflict(currentHead?.revisionId ?? null);
  }
}

function assertExistingFieldAgentCommandReplay(input: {
  request: StudioSnapshotSaveInput & { agentOperation: "apply" | "undo" };
  sha256: string;
  currentHead: { revisionId: string } | null;
  run: typeof schema.grantDocumentFieldAgentRuns.$inferSelect;
  suggestion: typeof schema.grantDocumentFieldAgentSuggestions.$inferSelect;
  existingRevision: typeof schema.grantDocumentRevisions.$inferSelect;
}): void {
  const expectedParent = input.request.agentOperation === "apply"
    ? input.run.baseRevisionId
    : input.suggestion.appliedRevisionId;
  const expectedOrigin = input.request.agentOperation === "apply" ? "studio_agent_apply" : "studio_agent_undo";
  if (
    input.currentHead?.revisionId === input.existingRevision.id
    && input.existingRevision.draftId === input.request.draftId
    && input.existingRevision.createdBy === input.request.access.userId
    && input.existingRevision.parentRevisionId === expectedParent
    && input.existingRevision.origin === expectedOrigin
    && input.existingRevision.agentOperation === input.request.agentOperation
    && input.existingRevision.fieldAgentRunId === input.run.id
    && input.existingRevision.fieldAgentSuggestionId === input.suggestion.id
    && input.existingRevision.sha256 === input.sha256
  ) return;
  throw revisionConflict(input.currentHead?.revisionId ?? null);
}

async function loadAgentSnapshotRows(
  db: Pick<ReturnType<typeof getCunoteDb>, "select">,
  input: StudioSnapshotSaveInput & { agentSuggestionId: string },
): Promise<{
  run: typeof schema.grantDocumentAgentRuns.$inferSelect;
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect;
}> {
  const [joined] = await db
    .select({ suggestion: schema.grantDocumentAgentSuggestions, run: schema.grantDocumentAgentRuns })
    .from(schema.grantDocumentAgentSuggestions)
    .innerJoin(
      schema.grantDocumentAgentRuns,
      eq(schema.grantDocumentAgentSuggestions.runId, schema.grantDocumentAgentRuns.id),
    )
    .where(and(
      eq(schema.grantDocumentAgentSuggestions.id, input.agentSuggestionId),
      eq(schema.grantDocumentAgentSuggestions.draftId, input.draftId),
      eq(schema.grantDocumentAgentSuggestions.createdBy, input.access.userId),
    ))
    .limit(1);
  if (!joined) {
    throw new DocumentRevisionError("agent_suggestion_not_found", "AI 문서 제안을 찾지 못했습니다.", 404);
  }
  return joined;
}

function assertActiveAgentSnapshotAuthorization(input: {
  request: StudioSnapshotSaveInput & {
    agentOperation: "apply" | "undo";
    operationVersion: number;
  };
  currentHead: { revisionId: string; sha256: string } | null;
  run: typeof schema.grantDocumentAgentRuns.$inferSelect;
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect;
}): void {
  const { request, currentHead, run, suggestion } = input;
  if (suggestion.operationVersion !== request.operationVersion) throw revisionConflict(currentHead?.revisionId ?? null);
  if (request.agentOperation === "apply") {
    if (
      suggestion.status !== "approved"
      || suggestion.operationState !== "apply_saving"
      || currentHead?.revisionId !== run.baseRevisionId
      || currentHead.sha256 !== run.documentSha256
    ) throw revisionConflict(currentHead?.revisionId ?? null);
  } else if (
    suggestion.status !== "applied"
    || suggestion.operationState !== "undo_saving"
    || currentHead?.revisionId !== suggestion.appliedRevisionId
    || currentHead.sha256 !== suggestion.appliedDocumentSha256
  ) {
    throw revisionConflict(currentHead?.revisionId ?? null);
  }
}

function assertExistingAgentCommandReplay(input: {
  request: StudioSnapshotSaveInput & { agentOperation: "apply" | "undo"; agentSuggestionId: string };
  sha256: string;
  currentHead: { revisionId: string } | null;
  run: typeof schema.grantDocumentAgentRuns.$inferSelect;
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect;
  existingRevision: typeof schema.grantDocumentRevisions.$inferSelect;
}): void {
  const expectedParent = input.request.agentOperation === "apply"
    ? input.run.baseRevisionId
    : input.suggestion.appliedRevisionId;
  const expectedOrigin = input.request.agentOperation === "apply"
    ? "studio_agent_apply"
    : "studio_agent_undo";
  if (
    input.currentHead?.revisionId === input.existingRevision.id
    && input.existingRevision.draftId === input.request.draftId
    && input.existingRevision.createdBy === input.request.access.userId
    && input.existingRevision.parentRevisionId === expectedParent
    && input.existingRevision.origin === expectedOrigin
    && input.existingRevision.agentOperation === input.request.agentOperation
    && input.existingRevision.agentRunId === input.run.id
    && input.existingRevision.agentSuggestionId === input.suggestion.id
    && input.existingRevision.sha256 === input.sha256
  ) return;
  throw revisionConflict(input.currentHead?.revisionId ?? null);
}

function agentCommandId(suggestionId: string, operation: "apply" | "undo"): string {
  return operation === "apply" ? suggestionId : `${suggestionId}:undo`;
}

function fieldAgentCommandId(suggestionId: string, operation: "apply" | "undo"): string {
  return operation === "apply" ? `field:${suggestionId}` : `field:${suggestionId}:undo`;
}

function buildFieldAgentProjection(input: {
  authorization: FieldAgentSnapshotAuthorization;
  currentAnswers: DraftFieldAnswers;
  currentMaterializedAnswers: Record<string, string>;
  revisionId: string;
}): { fieldAnswers: DraftFieldAnswers; materializedAnswers: Record<string, string> } {
  const { authorization } = input;
  const label = normalizeAnswerLabel(authorization.run.fieldLabel);
  const current = input.currentAnswers[label];
  const nextAnswers: DraftFieldAnswers = { ...input.currentAnswers };
  const nextMaterialized = { ...input.currentMaterializedAnswers };
  if (authorization.operation === "apply") {
    const matchesBefore = stableJson(current ?? null) === stableJson(authorization.run.beforeAnswer ?? null);
    const matchesSuggestion = current?.status === "suggested"
      && current.value === authorization.suggestion.value
      && (!current.fieldId || current.fieldId === authorization.run.fieldId);
    if (!matchesBefore && !matchesSuggestion) {
      throw new DocumentRevisionError(
        "field_answer_conflict",
        "제안 후 필드 답변이 변경되어 문서에 덮어쓰지 않았습니다.",
        409,
      );
    }
    nextAnswers[label] = {
      value: authorization.suggestion.value,
      status: "accepted",
      source: "llm",
      suggestedValue: authorization.suggestion.value,
      basis: authorization.suggestion.rationale,
      fieldId: authorization.run.fieldId,
      materializedRevisionId: input.revisionId,
      valueSha256: createHash("sha256").update(authorization.suggestion.value).digest("hex"),
      updatedAt: new Date().toISOString(),
      ...(current?.suggestionInput ? { suggestionInput: current.suggestionInput } : {}),
    };
    nextMaterialized[authorization.run.fieldId] = authorization.suggestion.value;
  } else {
    if (
      current?.materializedRevisionId !== authorization.suggestion.appliedRevisionId
      || current.value !== authorization.suggestion.value
    ) {
      throw new DocumentRevisionError(
        "field_answer_conflict",
        "적용 뒤 필드 답변이 변경되어 되돌리지 않았습니다.",
        409,
      );
    }
    if (authorization.run.beforeAnswer) nextAnswers[label] = authorization.run.beforeAnswer;
    else delete nextAnswers[label];
    const beforeText = authorization.run.beforeText.trim();
    if (beforeText) nextMaterialized[authorization.run.fieldId] = beforeText;
    else delete nextMaterialized[authorization.run.fieldId];
  }
  return { fieldAnswers: nextAnswers, materializedAnswers: nextMaterialized };
}

function assertCheckpointReplay(input: {
  input: StudioSnapshotSaveInput;
  sha256: string;
  checkpoint: typeof schema.grantDocumentRevisions.$inferSelect;
  currentHead: {
    revisionId: string;
    parentRevisionId: string | null;
    origin: string;
    sha256: string;
  } | null;
}): void {
  if (
    input.currentHead?.revisionId === input.checkpoint.id
    && input.checkpoint.origin === "studio_agent_checkpoint"
    && input.checkpoint.parentRevisionId === input.input.baseRevisionId
    && input.checkpoint.sha256 === input.sha256
    && input.checkpoint.checkpointRequestId === input.input.checkpointRequestId
  ) return;
  throw revisionConflict(input.currentHead?.revisionId ?? null);
}

function isCheckpointChildOfLegacyReplay(
  currentHead: {
    revisionId: string;
    parentRevisionId: string | null;
    origin: string;
    sha256: string;
  } | null,
  legacyRevisionId: string,
  sha256: string,
): boolean {
  return currentHead?.origin === "studio_agent_checkpoint"
    && currentHead.parentRevisionId === legacyRevisionId
    && currentHead.sha256 === sha256;
}

function revisionConflict(currentRevisionId: string | null): DocumentRevisionError {
  return new DocumentRevisionError(
    "revision_conflict",
    "다른 편집 세션에서 저장한 문서가 있습니다. 최신 문서를 다시 불러와 주세요.",
    409,
    currentRevisionId,
  );
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
