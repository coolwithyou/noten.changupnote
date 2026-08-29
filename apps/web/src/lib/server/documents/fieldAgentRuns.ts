import { createHash } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { FieldAssistReadiness } from "@/lib/chat/messageContent";
import type {
  StudioFieldBindingTargetV1,
  StudioFieldRestoreFormatV1,
} from "@/lib/rhwp/studioDocumentAgentProtocol";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "../db/client";
import * as schema from "../db/schema";
import { getDraftRevisionHead } from "./documentRevisions";
import { isFieldEditorAgentFeatureEnabled } from "./documentAgentAvailability";
import {
  deriveFilledFields,
  mergeLlmSuggestions,
  resolveFieldAnswers,
  type DraftFieldAnswer,
} from "./fieldAnswers";
import { rebuildFieldAgentAuthority } from "./fieldAgentAuthority";
import { fieldSuggestModel, generateFieldSuggestions } from "./fieldSuggest";

const PROMPT_VERSION = "field-agent-v3";

export class FieldAgentRunError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "FieldAgentRunError";
  }
}

export interface FieldAgentSuggestionDto {
  id: string;
  runId: string;
  fieldId: string;
  value: string;
  rationale: string;
  evidence: Record<string, unknown>[];
  status: string;
  statusVersion: number;
  operationState: string;
  operationVersion: number;
  appliedDocumentSha256: string | null;
  undoneDocumentSha256: string | null;
  appliedRevisionId: string | null;
  undoneRevisionId: string | null;
  updatedAt: string;
}

export interface FieldAgentRunDto {
  id: string;
  fieldId: string;
  fieldLabel: string;
  status: string;
  statusVersion: number;
  baseRevisionId: string;
  documentSha256: string;
  documentSemanticSha256: string | null;
  fieldBindingSha256: string;
  target: StudioFieldBindingTargetV1;
  beforeText: string;
  beforeAnswer: DraftFieldAnswer | null;
  beforeTextSha256: string;
  formatSha256: string;
  restoreFormat?: StudioFieldRestoreFormatV1 | null;
  adjacentContextSha256: string;
  modelVersion: string;
  promptVersion: string;
  failureCode: string | null;
  readiness?: FieldAssistReadiness & { missingInformation: string[] };
  suggestions: FieldAgentSuggestionDto[];
}

export async function requestFieldAgentSuggestions(input: {
  draftId: string;
  fieldId: string;
  clientRequestId: string;
  baseRevisionId: string;
  target: StudioFieldBindingTargetV1;
  sourceText?: string;
  userEvidenceText?: string;
  access: CompanyAccess;
}): Promise<FieldAgentRunDto> {
  if (!isFieldEditorAgentFeatureEnabled()) {
    throw new FieldAgentRunError("field_agent_disabled", "AI 필드 제안이 현재 rollout 범위에 없습니다.", 404);
  }
  for (const [label, value] of [
    ["draftId", input.draftId],
    ["fieldId", input.fieldId],
    ["clientRequestId", input.clientRequestId],
    ["baseRevisionId", input.baseRevisionId],
  ] as const) {
    if (!isUuid(value)) throw new FieldAgentRunError(`invalid_${label}`, `${label} 값이 올바르지 않습니다.`, 400);
  }
  const authority = await rebuildFieldAgentAuthority({
    draftId: input.draftId,
    fieldId: input.fieldId,
    baseRevisionId: input.baseRevisionId,
    requestedTarget: input.target,
    access: input.access,
  });
  const modelVersion = fieldSuggestModel();
  const requestBindingSha256 = sha256(stableJson({
    schemaVersion: PROMPT_VERSION,
    draftId: input.draftId,
    fieldId: input.fieldId,
    createdBy: input.access.userId,
    baseRevisionId: authority.revision.revisionId,
    documentSha256: authority.revision.sha256,
    fieldBindingSha256: authority.fieldBindingSha256,
    modelVersion,
    promptVersion: PROMPT_VERSION,
    sourceText: input.sourceText?.trim() || null,
    userEvidenceText: input.userEvidenceText?.trim() || null,
  }));
  const existing = await findRunByClientRequest(input.draftId, input.clientRequestId, input.access);
  if (existing) {
    if (existing.requestBindingSha256 !== requestBindingSha256) {
      throw new FieldAgentRunError("request_replay_mismatch", "같은 요청 ID가 다른 필드 binding에 사용되었습니다.", 409);
    }
    if (existing.status === "generating") {
      throw new FieldAgentRunError("field_agent_generating", "같은 필드 제안을 생성하고 있습니다.", 409);
    }
    return loadFieldAgentRunDto(existing.id, input.access);
  }

  const db = getCunoteDb();
  const run = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
    const [created] = await tx.insert(schema.grantDocumentFieldAgentRuns).values({
      draftId: input.draftId,
      fieldId: authority.field.fieldId,
      fieldLabel: authority.field.label,
      createdBy: input.access.userId,
      clientRequestId: input.clientRequestId,
      status: "generating",
      statusVersion: 0,
      requestBindingSha256,
      baseRevisionId: authority.revision.revisionId,
      documentSha256: authority.revision.sha256,
      documentSemanticSha256: authority.documentSemanticSha256,
      fieldBindingSha256: authority.fieldBindingSha256,
      target: authority.target,
      beforeText: authority.evidence.text,
      beforeTextSha256: authority.evidence.textSha256,
      formatSha256: authority.evidence.formatSha256,
      restoreFormat: authority.evidence.restoreFormat,
      adjacentContextSha256: authority.evidence.adjacentContextSha256,
      beforeAnswer: authority.beforeAnswer,
      modelVersion,
      promptVersion: PROMPT_VERSION,
      groundingBindingSha256: requestBindingSha256,
    }).returning();
    if (!created) throw new FieldAgentRunError("field_agent_run_create_failed", "필드 제안 실행을 만들지 못했습니다.", 500);
    await tx.insert(schema.grantDocumentDraftEvents).values({
      draftId: input.draftId,
      actorUserId: input.access.userId,
      event: "field_agent_suggestion_requested",
      payload: { runId: created.id, fieldId: authority.field.fieldId, baseRevisionId: authority.revision.revisionId },
    });
    return created;
  });
  if (!run) throw new FieldAgentRunError("field_agent_run_create_failed", "필드 제안 실행을 만들지 못했습니다.", 500);

  let generatedReadiness: FieldAgentRunDto["readiness"];
  try {
    const generated = await generateFieldSuggestions({
      draftId: input.draftId,
      access: input.access,
      labels: [authority.field.label],
      mode: authority.beforeAnswer?.value ? "regenerate" : "generate",
      ...(authority.beforeAnswer?.value ? { currentValue: authority.beforeAnswer.value } : {}),
      ...(input.sourceText?.trim() ? { sourceText: input.sourceText.trim() } : {}),
      ...(input.userEvidenceText?.trim() ? { userEvidenceText: input.userEvidenceText.trim() } : {}),
      alternativesPerLabel: 2,
      ...(authority.options.length > 0
        ? { allowedValuesByLabel: { [authority.field.label]: authority.options } }
        : {}),
      persistProjection: false,
    });
    generatedReadiness = generated.readiness?.[authority.field.label];
    const suggestion = generated.suggestions[authority.field.label];
    const alternatives = generated.alternatives?.[authority.field.label]
      ?? (suggestion ? [suggestion] : []);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
      await tx.execute(sql`SELECT id FROM grant_document_field_agent_runs WHERE id = ${run.id} FOR UPDATE`);
      const now = new Date();
      if (alternatives.length > 0) {
        await tx.update(schema.grantDocumentFieldAgentSuggestions)
          .set({
            status: "stale",
            statusVersion: sql`${schema.grantDocumentFieldAgentSuggestions.statusVersion} + 1`,
            updatedAt: now,
          })
          .where(and(
            eq(schema.grantDocumentFieldAgentSuggestions.draftId, input.draftId),
            eq(schema.grantDocumentFieldAgentSuggestions.fieldId, authority.field.fieldId),
            eq(schema.grantDocumentFieldAgentSuggestions.createdBy, input.access.userId),
            eq(schema.grantDocumentFieldAgentSuggestions.status, "pending"),
          ));
        await tx.insert(schema.grantDocumentFieldAgentSuggestions).values(
          alternatives.slice(0, 2).map((alternative, ordinal) => ({
            runId: run.id,
            draftId: input.draftId,
            fieldId: authority.field.fieldId,
            createdBy: input.access.userId,
            ordinal,
            value: alternative.value,
            rationale: alternative.basis,
            evidence: [{ kind: alternative.basisKind ?? "unknown", basis: alternative.basis }],
          })),
        );
        // 복수 대안은 아직 사용자가 값을 선택하지 않은 상태다. 단일 fieldAnswers 슬롯을
        // 첫 대안으로 미리 투영하면 두 번째 대안 apply가 답변 충돌로 잘못 거부된다.
        // 대안은 suggestion entity에만 두고, 하나만 생성된 경우에만 기존 projection을 유지한다.
        if (alternatives.length === 1) {
          const [lockedDraft] = await tx.select({
            fieldAnswers: schema.grantDocumentDrafts.fieldAnswers,
            filledFields: schema.grantDocumentDrafts.filledFields,
          }).from(schema.grantDocumentDrafts)
            .where(eq(schema.grantDocumentDrafts.id, input.draftId))
            .limit(1)
            .for("update");
          if (!lockedDraft) throw new FieldAgentRunError("draft_not_found", "문서 초안을 찾지 못했습니다.", 404);
          const nextAnswers = mergeLlmSuggestions(
            resolveFieldAnswers(lockedDraft),
            { [authority.field.label]: {
              value: alternatives[0]!.value,
              basis: alternatives[0]!.basis,
              fieldId: authority.field.fieldId,
              ...(alternatives[0]!.suggestionInput
                ? { suggestionInput: alternatives[0]!.suggestionInput }
                : {}),
            } },
            { at: now.toISOString() },
          );
          await tx.update(schema.grantDocumentDrafts).set({
            fieldAnswers: nextAnswers,
            filledFields: deriveFilledFields(nextAnswers),
            updatedAt: now,
          }).where(eq(schema.grantDocumentDrafts.id, input.draftId));
        }
      }
      const status = alternatives.length > 0 ? "ready" : "empty";
      await tx.update(schema.grantDocumentFieldAgentRuns).set({
        status,
        statusVersion: 1,
        groundingBindingSha256: generated.groundingBindingSha256 ?? requestBindingSha256,
        completedAt: now,
      }).where(and(
        eq(schema.grantDocumentFieldAgentRuns.id, run.id),
        eq(schema.grantDocumentFieldAgentRuns.status, "generating"),
      ));
      await tx.insert(schema.grantDocumentDraftEvents).values({
        draftId: input.draftId,
        actorUserId: input.access.userId,
        event: alternatives.length > 0 ? "field_agent_suggestion_ready" : "field_agent_suggestion_empty",
        payload: { runId: run.id, fieldId: authority.field.fieldId },
      });
    });
  } catch (error) {
    await withCunoteDbUser(db, input.access.userId, async (tx) => {
      await tx.update(schema.grantDocumentFieldAgentRuns).set({
        status: "failed",
        statusVersion: 1,
        failureCode: error instanceof FieldAgentRunError ? error.code : "generation_failed",
        completedAt: new Date(),
      }).where(and(
        eq(schema.grantDocumentFieldAgentRuns.id, run.id),
        eq(schema.grantDocumentFieldAgentRuns.status, "generating"),
      ));
    });
    throw error;
  }
  const completed = await loadFieldAgentRunDto(run.id, input.access);
  return generatedReadiness ? { ...completed, readiness: generatedReadiness } : completed;
}

export type FieldAgentSuggestionAction = "start_apply" | "authorize_undo" | "dismiss" | "abandon_apply" | "abandon_undo";

export async function transitionFieldAgentSuggestion(input: {
  draftId: string;
  suggestionId: string;
  action: FieldAgentSuggestionAction;
  expectedStatusVersion: number;
  expectedOperationVersion: number;
  operationClientId?: string;
  failureCode?: string;
  access: CompanyAccess;
}): Promise<FieldAgentSuggestionDto> {
  const db = getCunoteDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
    await tx.execute(sql`SELECT id FROM grant_document_field_agent_suggestions
      WHERE id = ${input.suggestionId} AND draft_id = ${input.draftId} AND created_by = ${input.access.userId}
      FOR UPDATE`);
    const [joined] = await tx.select({
      suggestion: schema.grantDocumentFieldAgentSuggestions,
      run: schema.grantDocumentFieldAgentRuns,
    }).from(schema.grantDocumentFieldAgentSuggestions)
      .innerJoin(
        schema.grantDocumentFieldAgentRuns,
        eq(schema.grantDocumentFieldAgentSuggestions.runId, schema.grantDocumentFieldAgentRuns.id),
      )
      .where(and(
        eq(schema.grantDocumentFieldAgentSuggestions.id, input.suggestionId),
        eq(schema.grantDocumentFieldAgentSuggestions.draftId, input.draftId),
        eq(schema.grantDocumentFieldAgentSuggestions.createdBy, input.access.userId),
      )).limit(1);
    if (!joined) throw new FieldAgentRunError("field_suggestion_not_found", "필드 제안을 찾지 못했습니다.", 404);
    const { suggestion, run } = joined;
    if (
      suggestion.statusVersion !== input.expectedStatusVersion
      || suggestion.operationVersion !== input.expectedOperationVersion
    ) throw new FieldAgentRunError("field_suggestion_version_conflict", "필드 제안 상태가 다른 탭에서 변경되었습니다.", 409);
    const head = await lockedHeadRevisionId(tx, input.draftId);
    const now = new Date();
    let values: Partial<typeof schema.grantDocumentFieldAgentSuggestions.$inferInsert>;
    switch (input.action) {
      case "start_apply":
        assertState(suggestion.status === "pending" && suggestion.operationState === "idle", "field_apply_not_allowed");
        assertHead(head, run.baseRevisionId);
        values = startOperation(suggestion, "apply_saving", requiredClientId(input.operationClientId), now);
        break;
      case "authorize_undo":
        assertState(suggestion.status === "applied" && suggestion.operationState === "idle", "field_undo_not_allowed");
        assertHead(head, suggestion.appliedRevisionId);
        values = startOperation(suggestion, "undo_saving", requiredClientId(input.operationClientId), now);
        break;
      case "dismiss":
        assertState(suggestion.status === "pending" && suggestion.operationState === "idle", "field_dismiss_not_allowed");
        values = { status: "dismissed", statusVersion: suggestion.statusVersion + 1, updatedAt: now };
        break;
      case "abandon_apply":
        assertState(suggestion.status === "pending" && suggestion.operationState === "apply_saving", "field_abandon_apply_not_allowed");
        assertHead(head, run.baseRevisionId);
        // 적용 전 검증 실패 또는 exact rollback이 끝난 경우 제안 자체는 여전히 유효할 수 있다.
        // 사용자가 다시 시도하거나 다른 대안을 고를 수 있도록 pending을 보존한다.
        values = { ...idleOperation(suggestion, input.failureCode ?? "apply_rolled_back", now), status: "pending" };
        break;
      case "abandon_undo":
        assertState(suggestion.status === "applied" && suggestion.operationState === "undo_saving", "field_abandon_undo_not_allowed");
        assertHead(head, suggestion.appliedRevisionId);
        values = idleOperation(suggestion, input.failureCode ?? "undo_rolled_back", now);
        break;
    }
    const [updated] = await tx.update(schema.grantDocumentFieldAgentSuggestions).set(values).where(and(
      eq(schema.grantDocumentFieldAgentSuggestions.id, suggestion.id),
      eq(schema.grantDocumentFieldAgentSuggestions.statusVersion, suggestion.statusVersion),
      eq(schema.grantDocumentFieldAgentSuggestions.operationVersion, suggestion.operationVersion),
    )).returning();
    if (!updated) throw new FieldAgentRunError("field_suggestion_version_conflict", "필드 제안 상태가 변경되었습니다.", 409);
    if (input.action === "start_apply") {
      // 한 run의 대안은 하나의 선택 집합이다. 선택된 값이 apply_saving에 들어가는 순간
      // 다른 pending 대안은 같은 base revision을 다시 적용하지 못하도록 terminal 처리한다.
      await tx.update(schema.grantDocumentFieldAgentSuggestions).set({
        status: "stale",
        statusVersion: sql`${schema.grantDocumentFieldAgentSuggestions.statusVersion} + 1`,
        updatedAt: now,
      }).where(and(
        eq(schema.grantDocumentFieldAgentSuggestions.runId, run.id),
        ne(schema.grantDocumentFieldAgentSuggestions.id, suggestion.id),
        eq(schema.grantDocumentFieldAgentSuggestions.status, "pending"),
        eq(schema.grantDocumentFieldAgentSuggestions.operationState, "idle"),
      ));
    }
    if (input.action === "abandon_apply") {
      // start_apply가 같은 run의 다른 pending 대안을 stale로 잠갔다. 적용이 확정되지
      // 않았으므로 그 선택 집합만 다시 pending으로 복구한다. 다른 run은 건드리지 않는다.
      await tx.update(schema.grantDocumentFieldAgentSuggestions).set({
        status: "pending",
        statusVersion: sql`${schema.grantDocumentFieldAgentSuggestions.statusVersion} + 1`,
        failureCode: input.failureCode ?? "apply_rolled_back",
        updatedAt: now,
      }).where(and(
        eq(schema.grantDocumentFieldAgentSuggestions.runId, run.id),
        ne(schema.grantDocumentFieldAgentSuggestions.id, suggestion.id),
        eq(schema.grantDocumentFieldAgentSuggestions.status, "stale"),
        eq(schema.grantDocumentFieldAgentSuggestions.operationState, "idle"),
      ));
    }
    if (input.action === "dismiss") {
      const [lockedDraft] = await tx.select({
        fieldAnswers: schema.grantDocumentDrafts.fieldAnswers,
        filledFields: schema.grantDocumentDrafts.filledFields,
      }).from(schema.grantDocumentDrafts)
        .where(eq(schema.grantDocumentDrafts.id, input.draftId))
        .limit(1)
        .for("update");
      if (lockedDraft) {
        const answers = resolveFieldAnswers(lockedDraft);
        const current = answers[run.fieldLabel.trim().slice(0, 160)];
        if (current?.status === "suggested" && current.value === suggestion.value) {
          const nextAnswers = { ...answers };
          if (run.beforeAnswer) nextAnswers[run.fieldLabel.trim().slice(0, 160)] = run.beforeAnswer;
          else delete nextAnswers[run.fieldLabel.trim().slice(0, 160)];
          await tx.update(schema.grantDocumentDrafts).set({
            fieldAnswers: nextAnswers,
            filledFields: deriveFilledFields(nextAnswers),
            updatedAt: now,
          }).where(eq(schema.grantDocumentDrafts.id, input.draftId));
        }
      }
    }
    await tx.insert(schema.grantDocumentDraftEvents).values({
      draftId: input.draftId,
      actorUserId: input.access.userId,
      event: `field_agent_${input.action}`,
      payload: { runId: run.id, suggestionId: updated.id, fieldId: run.fieldId },
    });
    return toSuggestionDto(updated);
  });
}

export async function loadRecentFieldAgentRuns(input: {
  draftId: string;
  access: CompanyAccess;
}): Promise<FieldAgentRunDto[]> {
  const db = getCunoteDb();
  return withCunoteDbUser(db, input.access.userId, async (tx) => {
    const runs = await tx.execute<{ id: string }>(sql`
      SELECT recent.id
      FROM (
        SELECT DISTINCT ON (field_id) id, created_at
        FROM grant_document_field_agent_runs
        WHERE draft_id = ${input.draftId}
          AND created_by = ${input.access.userId}
        ORDER BY field_id, created_at DESC
      ) recent
      ORDER BY recent.created_at DESC
    `);
    return Promise.all(runs.map((run) => loadFieldAgentRunDto(run.id, input.access)));
  });
}

async function loadFieldAgentRunDto(runId: string, access: CompanyAccess): Promise<FieldAgentRunDto> {
  const db = getCunoteDb();
  return withCunoteDbUser(db, access.userId, async (tx) => {
    const [run] = await tx.select().from(schema.grantDocumentFieldAgentRuns).where(and(
      eq(schema.grantDocumentFieldAgentRuns.id, runId),
      eq(schema.grantDocumentFieldAgentRuns.createdBy, access.userId),
    )).limit(1);
    if (!run) throw new FieldAgentRunError("field_run_not_found", "필드 제안 실행을 찾지 못했습니다.", 404);
    const suggestions = await tx.select().from(schema.grantDocumentFieldAgentSuggestions).where(and(
      eq(schema.grantDocumentFieldAgentSuggestions.runId, run.id),
      eq(schema.grantDocumentFieldAgentSuggestions.createdBy, access.userId),
    ));
    return {
      id: run.id,
      fieldId: run.fieldId,
      fieldLabel: run.fieldLabel,
      status: run.status,
      statusVersion: run.statusVersion,
      baseRevisionId: run.baseRevisionId,
      documentSha256: run.documentSha256,
      documentSemanticSha256: run.documentSemanticSha256,
      fieldBindingSha256: run.fieldBindingSha256,
      target: run.target as unknown as StudioFieldBindingTargetV1,
      beforeText: run.beforeText,
      beforeAnswer: run.beforeAnswer,
      beforeTextSha256: run.beforeTextSha256,
      formatSha256: run.formatSha256,
      restoreFormat: run.restoreFormat,
      adjacentContextSha256: run.adjacentContextSha256,
      modelVersion: run.modelVersion,
      promptVersion: run.promptVersion,
      failureCode: run.failureCode,
      suggestions: suggestions.sort((a, b) => a.ordinal - b.ordinal).map(toSuggestionDto),
    };
  });
}

async function findRunByClientRequest(draftId: string, clientRequestId: string, access: CompanyAccess) {
  const db = getCunoteDb();
  return withCunoteDbUser(db, access.userId, async (tx) => {
    const [run] = await tx.select().from(schema.grantDocumentFieldAgentRuns).where(and(
      eq(schema.grantDocumentFieldAgentRuns.draftId, draftId),
      eq(schema.grantDocumentFieldAgentRuns.createdBy, access.userId),
      eq(schema.grantDocumentFieldAgentRuns.clientRequestId, clientRequestId),
    )).limit(1);
    return run ?? null;
  });
}

function toSuggestionDto(row: typeof schema.grantDocumentFieldAgentSuggestions.$inferSelect): FieldAgentSuggestionDto {
  return {
    id: row.id,
    runId: row.runId,
    fieldId: row.fieldId,
    value: row.value,
    rationale: row.rationale,
    evidence: row.evidence,
    status: row.status,
    statusVersion: row.statusVersion,
    operationState: row.operationState,
    operationVersion: row.operationVersion,
    appliedDocumentSha256: row.appliedDocumentSha256,
    undoneDocumentSha256: row.undoneDocumentSha256,
    appliedRevisionId: row.appliedRevisionId,
    undoneRevisionId: row.undoneRevisionId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type FieldTx = Parameters<Parameters<ReturnType<typeof getCunoteDb>["transaction"]>[0]>[0];

async function lockedHeadRevisionId(tx: FieldTx, draftId: string): Promise<string | null> {
  await tx.execute(sql`SELECT id FROM grant_document_drafts WHERE id = ${draftId} FOR UPDATE`);
  const [head] = await tx.select({ revisionId: schema.grantDocumentRevisionHeads.revisionId })
    .from(schema.grantDocumentRevisionHeads)
    .where(eq(schema.grantDocumentRevisionHeads.draftId, draftId))
    .limit(1);
  return head?.revisionId ?? null;
}

function startOperation(
  suggestion: typeof schema.grantDocumentFieldAgentSuggestions.$inferSelect,
  state: "apply_saving" | "undo_saving",
  operationClientId: string,
  now: Date,
) {
  return {
    operationState: state,
    operationVersion: suggestion.operationVersion + 1,
    operationStartedAt: now,
    operationClientId,
    failureCode: null,
    updatedAt: now,
  } as const;
}

function idleOperation(
  suggestion: typeof schema.grantDocumentFieldAgentSuggestions.$inferSelect,
  failureCode: string,
  now: Date,
) {
  return {
    operationState: "idle",
    operationVersion: suggestion.operationVersion + 1,
    operationStartedAt: null,
    operationClientId: null,
    failureCode,
    updatedAt: now,
  } as const;
}

function assertState(condition: boolean, code: string): asserts condition {
  if (!condition) throw new FieldAgentRunError(code, "현재 필드 제안 상태에서는 이 작업을 할 수 없습니다.", 409);
}

function assertHead(actual: string | null, expected: string | null): void {
  if (actual !== expected) throw new FieldAgentRunError("revision_conflict", "다른 탭에서 최신 문서가 변경되었습니다.", 409);
}

function requiredClientId(value: string | undefined): string {
  if (!value || !isUuid(value)) throw new FieldAgentRunError("operation_client_id_required", "작업 요청 ID가 필요합니다.", 400);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
