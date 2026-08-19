import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  canonicalJson,
  decodeDocumentEditCandidate,
  type DocumentEditAnchor,
  type DocumentEditCandidate,
} from "@/lib/rhwp/documentAgentContract";
import type { CompanyAccess } from "../auth/companyGuard";
import { assertChatBudget, type NormalizedChatUsage } from "../chat/budget";
import { getCunoteDb, withCunoteDbUser } from "../db/client";
import * as schema from "../db/schema";
import { getGrantDocumentDraft } from "./grantDocumentDrafts";
import { rebuildDocumentAgentCandidateAuthority } from "./documentAgentCandidateAuthority";
import { buildDocumentAgentGrounding } from "./documentAgentGrounding";
import {
  DOCUMENT_AGENT_PROMPT_VERSION,
  documentAgentModel,
  generateDocumentAgentSuggestions,
  type VerifiedDocumentAgentSuggestion,
} from "./documentAgentPrompt";
import { beginGenerativeUsage, finalizeGenerativeUsage } from "./generativeUsage";

const OPERATION_TIMEOUT_MS = 5 * 60_000;
const RUN_LEASE_MS = 120_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FAILURE_CODES = new Set([
  "core_validation_failed",
  "reload_failed",
  "snapshot_upload_failed",
  "revision_conflict",
  "undo_conflict",
  "apply_rolled_back",
  "undo_rolled_back",
  "operation_recovered",
]);

export class DocumentAgentRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "DocumentAgentRunError";
  }
}

export type DocumentAgentSuggestionAction =
  | "approve"
  | "dismiss"
  | "stale"
  | "start_apply"
  | "apply_save_failed"
  | "retry_apply_save"
  | "abandon_apply"
  | "authorize_undo"
  | "undo_save_failed"
  | "retry_undo_save"
  | "abandon_undo"
  | "recover_operation";

export interface DocumentAgentSuggestionDto {
  id: string;
  runId: string;
  ordinal: number;
  anchor: Record<string, unknown>;
  location: Record<string, unknown>;
  beforeText: string;
  afterText: string;
  format: Record<string, unknown>;
  rationale: string;
  evidence: Record<string, unknown>[];
  status: string;
  statusVersion: number;
  operationState: string;
  operationVersion: number;
  operationStartedAt: string | null;
  operationClientId: string | null;
  failureCode: string | null;
  appliedDocumentSha256: string | null;
  undoneDocumentSha256: string | null;
  appliedRevisionId: string | null;
  undoneRevisionId: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  undoneAt: string | null;
  updatedAt: string;
}

export interface DocumentAgentRunDto {
  id: string;
  clientRequestId: string;
  status: string;
  statusVersion: number;
  baseRevisionId: string;
  documentSha256: string;
  selectedPage: number;
  candidateId: string;
  candidate: DocumentEditCandidate;
  modelVersion: string;
  promptVersion: string;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
  suggestions: DocumentAgentSuggestionDto[];
}

export interface RequestDocumentAgentSuggestionsResult {
  run: DocumentAgentRunDto;
  acceptedExisting: boolean;
}

export async function requestDocumentAgentSuggestions(input: {
  draftId: string;
  access: CompanyAccess;
  clientRequestId: string;
  checkpointRequestId: string;
  baseRevisionId: string;
  selectedPage: number;
  candidateId: string;
  anchor: DocumentEditAnchor;
}): Promise<RequestDocumentAgentSuggestionsResult> {
  validateRunRequest(input);
  const draft = await getGrantDocumentDraft({ draftId: input.draftId, access: input.access });
  const authority = await rebuildDocumentAgentCandidateAuthority({
    draftId: input.draftId,
    access: input.access,
    baseRevisionId: input.baseRevisionId,
    checkpointRequestId: input.checkpointRequestId,
    selectedPage: input.selectedPage,
    candidateId: input.candidateId,
    anchor: input.anchor,
  });
  const grounding = await buildDocumentAgentGrounding({
    grantId: draft.grantId,
    companyId: input.access.companyId,
    revisionId: authority.revision.revisionId,
    candidate: authority.candidate,
  });
  const model = documentAgentModel();
  const requestBindingSha256 = sha256(canonicalJson({
    schemaVersion: "document-agent-v1",
    draftId: input.draftId,
    createdBy: input.access.userId,
    baseRevisionId: authority.revision.revisionId,
    documentSha256: authority.revision.sha256,
    candidateId: authority.candidate.candidateId,
    modelVersion: model,
    promptVersion: DOCUMENT_AGENT_PROMPT_VERSION,
    groundingBindingSha256: grounding.groundingBindingSha256,
  }));

  const db = getCunoteDb();
  await assertChatBudget(db, input.access.companyId);
  const claim = await claimDocumentAgentRun({
    draftId: input.draftId,
    access: input.access,
    clientRequestId: input.clientRequestId,
    requestBindingSha256,
    baseRevisionId: authority.revision.revisionId,
    documentSha256: authority.revision.sha256,
    studioSessionId: authority.revision.studioSessionId,
    documentEpoch: authority.revision.documentEpoch,
    changeSeq: authority.revision.changeSeq,
    selectedPage: input.selectedPage,
    candidate: authority.candidate,
    candidateId: authority.candidate.candidateId,
    modelVersion: model,
    promptVersion: DOCUMENT_AGENT_PROMPT_VERSION,
    groundingBindingSha256: grounding.groundingBindingSha256,
    groundingProvenance: grounding.groundingProvenance,
  });
  if (!claim.execute) {
    return { run: await loadDocumentAgentRunDto(claim.run.id, input.access), acceptedExisting: true };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    await failClaimedRun({ claim, access: input.access, failureCode: "anthropic_key_missing" });
    throw new DocumentAgentRunError("anthropic_key_missing", "문서 AI 작성 기능을 사용할 수 없습니다.", 503);
  }
  const usageAttempt = await beginGenerativeUsage({
    companyId: input.access.companyId,
    userId: input.access.userId,
    grantId: draft.grantId,
    sourceKind: "document_agent",
    sourceRequestId: input.clientRequestId,
    runId: claim.run.id,
    attempt: claim.run.attempt,
    leaseVersion: claim.run.leaseVersion,
    model,
  });
  try {
    const generated = await generateDocumentAgentSuggestions({
      candidate: authority.candidate,
      grounding,
      apiKey,
      model,
    });
    await finalizeGenerativeUsage({
      eventId: usageAttempt.id,
      companyId: input.access.companyId,
      userId: input.access.userId,
      grantId: draft.grantId,
      model,
      status: "reported",
      providerRequestId: generated.providerRequestId,
      usage: generated.usage,
    });
    const won = await completeClaimedRun({
      claim,
      access: input.access,
      candidate: authority.candidate,
      suggestions: generated.suggestions,
      usage: generated.usage,
    });
    return {
      run: await loadDocumentAgentRunDto(claim.run.id, input.access),
      acceptedExisting: !won,
    };
  } catch (error) {
    try {
      await finalizeGenerativeUsage({
        eventId: usageAttempt.id,
        companyId: input.access.companyId,
        userId: input.access.userId,
        grantId: draft.grantId,
        model,
        status: "unavailable",
      });
    } catch (usageError) {
      console.error("[document-agent] usage 종결 실패", usageError);
    }
    await failClaimedRun({ claim, access: input.access, failureCode: "model_generation_failed" });
    if (error instanceof DocumentAgentRunError) throw error;
    throw new DocumentAgentRunError(
      "document_agent_generation_failed",
      `문서 작성 제안을 생성하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }
}

interface ClaimedDocumentAgentRun {
  run: typeof schema.grantDocumentAgentRuns.$inferSelect;
  leaseOwner: string;
  execute: boolean;
}

async function claimDocumentAgentRun(input: {
  draftId: string;
  access: CompanyAccess;
  clientRequestId: string;
  requestBindingSha256: string;
  baseRevisionId: string;
  documentSha256: string;
  studioSessionId: string;
  documentEpoch: number;
  changeSeq: number;
  selectedPage: number;
  candidate: DocumentEditCandidate;
  candidateId: string;
  modelVersion: string;
  promptVersion: string;
  groundingBindingSha256: string;
  groundingProvenance: Record<string, unknown>;
}): Promise<ClaimedDocumentAgentRun> {
  const db = getCunoteDb();
  const leaseOwner = randomUUID();
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + RUN_LEASE_MS);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
    await tx.execute(sql`
      SELECT id FROM grant_document_drafts
      WHERE id = ${input.draftId} AND company_id = ${input.access.companyId}
      FOR UPDATE
    `);
    const [sameRequest] = await tx
      .select()
      .from(schema.grantDocumentAgentRuns)
      .where(and(
        eq(schema.grantDocumentAgentRuns.draftId, input.draftId),
        eq(schema.grantDocumentAgentRuns.createdBy, input.access.userId),
        eq(schema.grantDocumentAgentRuns.clientRequestId, input.clientRequestId),
      ))
      .limit(1);
    if (sameRequest) {
      if (sameRequest.requestBindingSha256 !== input.requestBindingSha256) {
        throw new DocumentAgentRunError("run_request_binding_conflict", "같은 요청 ID의 문서 결속이 다릅니다.", 409);
      }
      if (sameRequest.status !== "generating" || (sameRequest.leaseExpiresAt?.getTime() ?? 0) > now.getTime()) {
        return { run: sameRequest, leaseOwner: sameRequest.leaseOwner ?? leaseOwner, execute: false };
      }
    }

    const [active] = await tx
      .select()
      .from(schema.grantDocumentAgentRuns)
      .where(and(
        eq(schema.grantDocumentAgentRuns.draftId, input.draftId),
        eq(schema.grantDocumentAgentRuns.createdBy, input.access.userId),
        eq(schema.grantDocumentAgentRuns.status, "generating"),
      ))
      .limit(1);
    if (active && (active.leaseExpiresAt?.getTime() ?? 0) > now.getTime()) {
      return { run: active, leaseOwner: active.leaseOwner!, execute: false };
    }
    if (active) {
      await tx
        .update(schema.generativeUsageEvents)
        .set({ usageStatus: "unavailable", finalizedAt: now })
        .where(and(
          eq(schema.generativeUsageEvents.runId, active.id),
          eq(schema.generativeUsageEvents.attempt, active.attempt),
          eq(schema.generativeUsageEvents.leaseVersion, active.leaseVersion),
          eq(schema.generativeUsageEvents.usageStatus, "started"),
        ));
      if (active.requestBindingSha256 === input.requestBindingSha256) {
        const [reclaimed] = await tx
          .update(schema.grantDocumentAgentRuns)
          .set({
            statusVersion: active.statusVersion + 1,
            attempt: active.attempt + 1,
            leaseOwner,
            leaseVersion: active.leaseVersion + 1,
            leaseExpiresAt,
            failureCode: null,
          })
          .where(and(
            eq(schema.grantDocumentAgentRuns.id, active.id),
            eq(schema.grantDocumentAgentRuns.statusVersion, active.statusVersion),
            eq(schema.grantDocumentAgentRuns.leaseVersion, active.leaseVersion),
          ))
          .returning();
        if (!reclaimed) throw new DocumentAgentRunError("run_lease_conflict", "제안 실행 lease가 변경되었습니다.", 409);
        return { run: reclaimed, leaseOwner, execute: true };
      }
      await tx
        .update(schema.grantDocumentAgentRuns)
        .set({
          status: "failed",
          statusVersion: active.statusVersion + 1,
          leaseOwner: null,
          leaseExpiresAt: null,
          failureCode: "lease_expired",
          completedAt: now,
        })
        .where(and(
          eq(schema.grantDocumentAgentRuns.id, active.id),
          eq(schema.grantDocumentAgentRuns.statusVersion, active.statusVersion),
        ));
    }
    const [created] = await tx
      .insert(schema.grantDocumentAgentRuns)
      .values({
        draftId: input.draftId,
        createdBy: input.access.userId,
        clientRequestId: input.clientRequestId,
        status: "generating",
        statusVersion: 0,
        attempt: 1,
        leaseOwner,
        leaseVersion: 1,
        leaseExpiresAt,
        requestBindingSha256: input.requestBindingSha256,
        baseRevisionId: input.baseRevisionId,
        documentSha256: input.documentSha256,
        studioSessionId: input.studioSessionId,
        documentEpoch: input.documentEpoch,
        changeSeq: input.changeSeq,
        selectedPage: input.selectedPage,
        candidate: input.candidate as unknown as Record<string, unknown>,
        candidateId: input.candidateId,
        modelVersion: input.modelVersion,
        promptVersion: input.promptVersion,
        groundingBindingSha256: input.groundingBindingSha256,
        groundingProvenance: input.groundingProvenance,
      })
      .returning();
    if (!created) throw new DocumentAgentRunError("run_create_failed", "제안 실행 원장을 만들지 못했습니다.", 500);
    await tx.insert(schema.grantDocumentDraftEvents).values({
      draftId: input.draftId,
      actorUserId: input.access.userId,
      event: "document_agent_run_started",
      payload: { runId: created.id, baseRevisionId: created.baseRevisionId, candidateId: created.candidateId },
    });
    return { run: created, leaseOwner, execute: true };
  });
}

async function completeClaimedRun(input: {
  claim: ClaimedDocumentAgentRun;
  access: CompanyAccess;
  candidate: DocumentEditCandidate;
  suggestions: VerifiedDocumentAgentSuggestion[];
  usage: NormalizedChatUsage;
}): Promise<boolean> {
  const db = getCunoteDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
    await tx.execute(sql`SELECT id FROM grant_document_agent_runs WHERE id = ${input.claim.run.id} FOR UPDATE`);
    const [current] = await tx
      .select()
      .from(schema.grantDocumentAgentRuns)
      .where(eq(schema.grantDocumentAgentRuns.id, input.claim.run.id))
      .limit(1);
    if (
      !current
      || current.status !== "generating"
      || current.leaseOwner !== input.claim.leaseOwner
      || current.leaseVersion !== input.claim.run.leaseVersion
    ) return false;
    const now = new Date();
    if (input.suggestions.length > 0) {
      await tx.insert(schema.grantDocumentAgentSuggestions).values(
        input.suggestions.slice(0, 2).map((suggestion, ordinal) => ({
          runId: current.id,
          draftId: current.draftId,
          createdBy: current.createdBy,
          ordinal,
          anchor: input.candidate.anchor as unknown as Record<string, unknown>,
          location: input.candidate.location as unknown as Record<string, unknown>,
          beforeText: input.candidate.beforeText,
          afterText: suggestion.replacement,
          format: input.candidate.formatSnapshot as unknown as Record<string, unknown>,
          rationale: suggestion.rationale,
          evidence: suggestion.evidence,
        })),
      );
    }
    const status = input.suggestions.length > 0 ? "ready" : "empty";
    const [completed] = await tx
      .update(schema.grantDocumentAgentRuns)
      .set({
        status,
        statusVersion: current.statusVersion + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        inputTokens: input.usage.input,
        outputTokens: input.usage.output,
        cacheReadTokens: input.usage.cacheRead,
        cacheWriteTokens: input.usage.cacheWrite,
        completedAt: now,
      })
      .where(and(
        eq(schema.grantDocumentAgentRuns.id, current.id),
        eq(schema.grantDocumentAgentRuns.status, "generating"),
        eq(schema.grantDocumentAgentRuns.leaseOwner, input.claim.leaseOwner),
        eq(schema.grantDocumentAgentRuns.leaseVersion, input.claim.run.leaseVersion),
      ))
      .returning({ id: schema.grantDocumentAgentRuns.id });
    if (!completed) {
      throw new DocumentAgentRunError(
        "run_lease_conflict",
        "제안 실행 lease가 완료 직전에 변경되었습니다.",
        409,
      );
    }
    await tx.insert(schema.grantDocumentDraftEvents).values({
      draftId: current.draftId,
      actorUserId: input.access.userId,
      event: "document_agent_run_completed",
      payload: { runId: current.id, status, suggestionCount: input.suggestions.length },
    });
    return true;
  });
}

async function failClaimedRun(input: {
  claim: ClaimedDocumentAgentRun;
  access: CompanyAccess;
  failureCode: string;
}): Promise<void> {
  const db = getCunoteDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
    const [failed] = await tx
      .update(schema.grantDocumentAgentRuns)
      .set({
        status: "failed",
        statusVersion: input.claim.run.statusVersion + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        failureCode: input.failureCode,
        completedAt: new Date(),
      })
      .where(and(
        eq(schema.grantDocumentAgentRuns.id, input.claim.run.id),
        eq(schema.grantDocumentAgentRuns.status, "generating"),
        eq(schema.grantDocumentAgentRuns.leaseOwner, input.claim.leaseOwner),
        eq(schema.grantDocumentAgentRuns.leaseVersion, input.claim.run.leaseVersion),
      ))
      .returning({ id: schema.grantDocumentAgentRuns.id });
    if (failed) {
      await tx.insert(schema.grantDocumentDraftEvents).values({
        draftId: input.claim.run.draftId,
        actorUserId: input.access.userId,
        event: "document_agent_run_failed",
        payload: { runId: input.claim.run.id, failureCode: input.failureCode },
      });
    }
  });
}

async function loadDocumentAgentRunDto(runId: string, access: CompanyAccess): Promise<DocumentAgentRunDto> {
  const db = getCunoteDb();
  return withCunoteDbUser(db, access.userId, async (tx) => {
    const [run] = await tx
      .select()
      .from(schema.grantDocumentAgentRuns)
      .where(and(
        eq(schema.grantDocumentAgentRuns.id, runId),
        eq(schema.grantDocumentAgentRuns.createdBy, access.userId),
      ))
      .limit(1);
    if (!run) throw new DocumentAgentRunError("run_not_found", "문서 제안 실행을 찾지 못했습니다.", 404);
    const suggestions = await tx
      .select()
      .from(schema.grantDocumentAgentSuggestions)
      .where(eq(schema.grantDocumentAgentSuggestions.runId, run.id));
    return toRunDto(run, suggestions.sort((left, right) => left.ordinal - right.ordinal));
  });
}

async function resolveCurrentGroundingBinding(input: {
  draftId: string;
  suggestionId: string;
  grantId: string;
  access: CompanyAccess;
}): Promise<string> {
  const db = getCunoteDb();
  const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
    .select({ run: schema.grantDocumentAgentRuns })
    .from(schema.grantDocumentAgentSuggestions)
    .innerJoin(
      schema.grantDocumentAgentRuns,
      eq(schema.grantDocumentAgentSuggestions.runId, schema.grantDocumentAgentRuns.id),
    )
    .where(and(
      eq(schema.grantDocumentAgentSuggestions.id, input.suggestionId),
      eq(schema.grantDocumentAgentSuggestions.draftId, input.draftId),
      eq(schema.grantDocumentAgentSuggestions.createdBy, input.access.userId),
    ))
    .limit(1));
  if (!row) throw new DocumentAgentRunError("suggestion_not_found", "문서 작성 제안을 찾지 못했습니다.", 404);
  const candidate = decodeDocumentEditCandidate(row.run.candidate);
  const grounding = await buildDocumentAgentGrounding({
    grantId: input.grantId,
    companyId: input.access.companyId,
    revisionId: row.run.baseRevisionId,
    candidate,
  });
  return grounding.groundingBindingSha256;
}

export async function listDocumentAgentRuns(input: {
  draftId: string;
  access: CompanyAccess;
  limit?: number;
}): Promise<DocumentAgentRunDto[]> {
  await getGrantDocumentDraft({ draftId: input.draftId, access: input.access });
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  const db = getCunoteDb();
  return withCunoteDbUser(db, input.access.userId, async (tx) => {
    const runs = await tx
      .select()
      .from(schema.grantDocumentAgentRuns)
      .where(and(
        eq(schema.grantDocumentAgentRuns.draftId, input.draftId),
        eq(schema.grantDocumentAgentRuns.createdBy, input.access.userId),
      ))
      .orderBy(desc(schema.grantDocumentAgentRuns.createdAt))
      .limit(limit);
    if (runs.length === 0) return [];
    const suggestions = await tx
      .select()
      .from(schema.grantDocumentAgentSuggestions)
      .where(and(
        inArray(schema.grantDocumentAgentSuggestions.runId, runs.map((run) => run.id)),
        eq(schema.grantDocumentAgentSuggestions.createdBy, input.access.userId),
      ));
    const byRun = new Map<string, typeof suggestions>();
    for (const suggestion of suggestions) {
      const entries = byRun.get(suggestion.runId) ?? [];
      entries.push(suggestion);
      byRun.set(suggestion.runId, entries);
    }
    return runs.map((run) => toRunDto(
      run,
      (byRun.get(run.id) ?? []).sort((left, right) => left.ordinal - right.ordinal),
    ));
  });
}

export async function transitionDocumentAgentSuggestion(input: {
  draftId: string;
  suggestionId: string;
  access: CompanyAccess;
  action: DocumentAgentSuggestionAction;
  expectedStatusVersion: number;
  expectedOperationVersion: number;
  operationClientId?: string;
  documentSha256?: string;
  failureCode?: string;
}): Promise<DocumentAgentSuggestionDto> {
  validateTransitionInput(input);
  const draft = await getGrantDocumentDraft({ draftId: input.draftId, access: input.access });
  const currentGroundingBindingSha256 = input.action === "approve"
    ? await resolveCurrentGroundingBinding({
        draftId: input.draftId,
        suggestionId: input.suggestionId,
        grantId: draft.grantId,
        access: input.access,
      })
    : null;
  const db = getCunoteDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.access.userId}, true)`);
    await tx.execute(sql`
      SELECT id FROM grant_document_agent_suggestions
      WHERE id = ${input.suggestionId}
        AND draft_id = ${input.draftId}
        AND created_by = ${input.access.userId}
      FOR UPDATE
    `);
    const [joined] = await tx
      .select({ suggestion: schema.grantDocumentAgentSuggestions, run: schema.grantDocumentAgentRuns })
      .from(schema.grantDocumentAgentSuggestions)
      .innerJoin(
        schema.grantDocumentAgentRuns,
        eq(schema.grantDocumentAgentSuggestions.runId, schema.grantDocumentAgentRuns.id),
      )
      .where(and(
        eq(schema.grantDocumentAgentSuggestions.id, input.suggestionId),
        eq(schema.grantDocumentAgentSuggestions.draftId, input.draftId),
        eq(schema.grantDocumentAgentSuggestions.createdBy, input.access.userId),
      ))
      .limit(1);
    if (!joined) {
      throw new DocumentAgentRunError("suggestion_not_found", "문서 작성 제안을 찾지 못했습니다.", 404);
    }
    const { suggestion, run } = joined;
    if (
      suggestion.statusVersion !== input.expectedStatusVersion
      || suggestion.operationVersion !== input.expectedOperationVersion
    ) {
      throw new DocumentAgentRunError("suggestion_version_conflict", "제안 상태가 다른 탭에서 변경되었습니다.", 409);
    }
    const headRevisionId = await lockedHeadRevisionId(tx, input.draftId);
    const now = new Date();
    let values: Partial<typeof schema.grantDocumentAgentSuggestions.$inferInsert>;
    let event: string;

    switch (input.action) {
      case "approve":
        assertState(suggestion.status === "pending" && suggestion.operationState === "idle", "approve_not_allowed");
        assertHead(headRevisionId, run.baseRevisionId);
        if (
          !currentGroundingBindingSha256
          || currentGroundingBindingSha256 !== run.groundingBindingSha256
        ) {
          values = staleValues(suggestion, now, null);
          event = "document_agent_suggestion_stale";
          break;
        }
        values = {
          status: "approved",
          statusVersion: suggestion.statusVersion + 1,
          approvedAt: now,
          failureCode: null,
          updatedAt: now,
        };
        event = "document_agent_suggestion_approved";
        break;
      case "dismiss":
        assertState(suggestion.status === "pending" && suggestion.operationState === "idle", "dismiss_not_allowed");
        values = {
          status: "dismissed",
          statusVersion: suggestion.statusVersion + 1,
          updatedAt: now,
        };
        event = "document_agent_suggestion_dismissed";
        break;
      case "stale":
        assertState(
          (suggestion.status === "pending" || suggestion.status === "approved")
            && suggestion.operationState === "idle",
          "stale_not_allowed",
        );
        values = staleValues(suggestion, now, input.failureCode ?? null);
        event = "document_agent_suggestion_stale";
        break;
      case "start_apply":
        assertState(suggestion.status === "approved" && suggestion.operationState === "idle", "start_apply_not_allowed");
        assertHead(headRevisionId, run.baseRevisionId);
        values = startOperationValues(suggestion, "apply_saving", requireClientId(input.operationClientId), now);
        event = "document_agent_apply_started";
        break;
      case "apply_save_failed":
        assertOperation(suggestion, "approved", "apply_saving", input.operationClientId);
        assertHead(headRevisionId, run.baseRevisionId);
        values = failOperationValues(
          suggestion,
          "apply_save_failed",
          requireSha256(input.documentSha256),
          requireFailureCode(input.failureCode),
          now,
          "apply",
        );
        event = "document_agent_apply_save_failed";
        break;
      case "retry_apply_save":
        assertOperation(suggestion, "approved", "apply_save_failed", input.operationClientId);
        assertHead(headRevisionId, run.baseRevisionId);
        assertExpectedSha(suggestion.appliedDocumentSha256, input.documentSha256);
        values = startOperationValues(suggestion, "apply_saving", requireClientId(input.operationClientId), now);
        event = "document_agent_apply_save_retried";
        break;
      case "abandon_apply":
        assertState(
          suggestion.status === "approved"
            && (suggestion.operationState === "apply_saving" || suggestion.operationState === "apply_save_failed"),
          "abandon_apply_not_allowed",
        );
        assertClient(suggestion.operationClientId, input.operationClientId);
        assertHead(headRevisionId, run.baseRevisionId);
        values = {
          ...idleOperationValues(suggestion, requireFailureCode(input.failureCode), now),
          status: "stale",
          statusVersion: suggestion.statusVersion + 1,
        };
        event = "document_agent_apply_abandoned";
        break;
      case "authorize_undo":
        assertState(suggestion.status === "applied" && suggestion.operationState === "idle", "authorize_undo_not_allowed");
        assertHead(headRevisionId, suggestion.appliedRevisionId);
        values = startOperationValues(suggestion, "undo_saving", requireClientId(input.operationClientId), now);
        event = "document_agent_undo_started";
        break;
      case "undo_save_failed":
        assertOperation(suggestion, "applied", "undo_saving", input.operationClientId);
        assertHead(headRevisionId, suggestion.appliedRevisionId);
        values = failOperationValues(
          suggestion,
          "undo_save_failed",
          requireSha256(input.documentSha256),
          requireFailureCode(input.failureCode),
          now,
          "undo",
        );
        event = "document_agent_undo_save_failed";
        break;
      case "retry_undo_save":
        assertOperation(suggestion, "applied", "undo_save_failed", input.operationClientId);
        assertHead(headRevisionId, suggestion.appliedRevisionId);
        assertExpectedSha(suggestion.undoneDocumentSha256, input.documentSha256);
        values = startOperationValues(suggestion, "undo_saving", requireClientId(input.operationClientId), now);
        event = "document_agent_undo_save_retried";
        break;
      case "abandon_undo":
        assertState(
          suggestion.status === "applied"
            && (suggestion.operationState === "undo_saving" || suggestion.operationState === "undo_save_failed"),
          "abandon_undo_not_allowed",
        );
        assertClient(suggestion.operationClientId, input.operationClientId);
        assertHead(headRevisionId, suggestion.appliedRevisionId);
        values = idleOperationValues(suggestion, requireFailureCode(input.failureCode), now);
        event = "document_agent_undo_abandoned";
        break;
      case "recover_operation": {
        assertState(
          suggestion.operationState === "apply_saving" || suggestion.operationState === "undo_saving",
          "recover_operation_not_allowed",
        );
        if (!suggestion.operationStartedAt || now.getTime() - suggestion.operationStartedAt.getTime() < OPERATION_TIMEOUT_MS) {
          throw new DocumentAgentRunError("operation_not_expired", "아직 복구할 수 있는 작업 시간이 지나지 않았습니다.", 409);
        }
        const operation = suggestion.operationState === "apply_saving" ? "apply" : "undo";
        const commandId = operation === "apply" ? suggestion.id : `${suggestion.id}:undo`;
        const [commandRevision] = await tx
          .select({ id: schema.grantDocumentRevisions.id })
          .from(schema.grantDocumentRevisions)
          .where(eq(schema.grantDocumentRevisions.agentCommandId, commandId))
          .limit(1);
        if (commandRevision) {
          throw new DocumentAgentRunError("operation_already_committed", "작업 revision이 이미 저장되었습니다.", 409);
        }
        const recoveredStatus = operation === "apply" && headRevisionId !== run.baseRevisionId
          ? "stale"
          : suggestion.status;
        values = {
          ...idleOperationValues(suggestion, "operation_recovered", now),
          ...(recoveredStatus !== suggestion.status
            ? { status: recoveredStatus, statusVersion: suggestion.statusVersion + 1 }
            : {}),
        };
        event = "document_agent_operation_recovered";
        break;
      }
    }

    const [updated] = await tx
      .update(schema.grantDocumentAgentSuggestions)
      .set(values)
      .where(and(
        eq(schema.grantDocumentAgentSuggestions.id, suggestion.id),
        eq(schema.grantDocumentAgentSuggestions.statusVersion, suggestion.statusVersion),
        eq(schema.grantDocumentAgentSuggestions.operationVersion, suggestion.operationVersion),
      ))
      .returning();
    if (!updated) {
      throw new DocumentAgentRunError("suggestion_version_conflict", "제안 상태가 다른 탭에서 변경되었습니다.", 409);
    }

    await tx.insert(schema.grantDocumentDraftEvents).values({
      draftId: input.draftId,
      actorUserId: input.access.userId,
      event,
      payload: {
        runId: run.id,
        suggestionId: suggestion.id,
        status: updated.status,
        statusVersion: updated.statusVersion,
        operationState: updated.operationState,
        operationVersion: updated.operationVersion,
      },
    });
    return toSuggestionDto(updated);
  });
}

type AgentTx = Parameters<Parameters<ReturnType<typeof getCunoteDb>["transaction"]>[0]>[0];

async function lockedHeadRevisionId(tx: AgentTx, draftId: string): Promise<string | null> {
  const [head] = await tx
    .select({ revisionId: schema.grantDocumentRevisionHeads.revisionId })
    .from(schema.grantDocumentRevisionHeads)
    .where(eq(schema.grantDocumentRevisionHeads.draftId, draftId))
    .limit(1)
    .for("update");
  return head?.revisionId ?? null;
}

function validateTransitionInput(input: {
  draftId: string;
  suggestionId: string;
  expectedStatusVersion: number;
  expectedOperationVersion: number;
}): void {
  if (!isUuid(input.draftId) || !isUuid(input.suggestionId)) {
    throw new DocumentAgentRunError("invalid_suggestion_id", "제안 식별자가 올바르지 않습니다.", 400);
  }
  if (
    !Number.isSafeInteger(input.expectedStatusVersion)
    || input.expectedStatusVersion < 0
    || !Number.isSafeInteger(input.expectedOperationVersion)
    || input.expectedOperationVersion < 0
  ) {
    throw new DocumentAgentRunError("invalid_suggestion_version", "제안 상태 버전이 올바르지 않습니다.", 400);
  }
}

function assertState(condition: boolean, code: string): asserts condition {
  if (!condition) throw new DocumentAgentRunError(code, "현재 제안 상태에서는 이 작업을 실행할 수 없습니다.", 409);
}

function assertOperation(
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect,
  status: string,
  operationState: string,
  operationClientId: string | undefined,
): void {
  assertState(suggestion.status === status && suggestion.operationState === operationState, `${operationState}_not_allowed`);
  assertClient(suggestion.operationClientId, operationClientId);
}

function assertHead(current: string | null, expected: string | null): void {
  if (current !== expected) {
    throw new DocumentAgentRunError("revision_conflict", "문서 최신 revision이 제안 기준과 다릅니다.", 409);
  }
}

function assertClient(current: string | null, expected: string | undefined): void {
  const parsed = requireClientId(expected);
  if (current !== parsed) {
    throw new DocumentAgentRunError("operation_client_conflict", "이 작업을 시작한 편집 탭과 다릅니다.", 409);
  }
}

function requireClientId(value: string | undefined): string {
  if (!value || !isUuid(value)) {
    throw new DocumentAgentRunError("invalid_operation_client", "편집 탭 식별자가 올바르지 않습니다.", 400);
  }
  return value;
}

function requireSha256(value: string | undefined): string {
  if (!value || !SHA256_PATTERN.test(value)) {
    throw new DocumentAgentRunError("invalid_document_sha256", "문서 SHA-256이 올바르지 않습니다.", 400);
  }
  return value;
}

function assertExpectedSha(expected: string | null, actual: string | undefined): void {
  if (!expected || requireSha256(actual) !== expected) {
    throw new DocumentAgentRunError("operation_document_conflict", "저장 재시도 문서가 직전 검증본과 다릅니다.", 409);
  }
}

function requireFailureCode(value: string | undefined): string {
  if (!value || !FAILURE_CODES.has(value)) {
    throw new DocumentAgentRunError("invalid_failure_code", "작업 실패 코드가 올바르지 않습니다.", 400);
  }
  return value;
}

function startOperationValues(
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect,
  operationState: "apply_saving" | "undo_saving",
  operationClientId: string,
  now: Date,
): Partial<typeof schema.grantDocumentAgentSuggestions.$inferInsert> {
  return {
    operationState,
    operationVersion: suggestion.operationVersion + 1,
    operationStartedAt: now,
    operationClientId,
    failureCode: null,
    updatedAt: now,
  };
}

function failOperationValues(
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect,
  operationState: "apply_save_failed" | "undo_save_failed",
  documentSha256: string,
  failureCode: string,
  now: Date,
  operation: "apply" | "undo",
): Partial<typeof schema.grantDocumentAgentSuggestions.$inferInsert> {
  return {
    operationState,
    operationVersion: suggestion.operationVersion + 1,
    operationStartedAt: null,
    failureCode,
    ...(operation === "apply"
      ? { appliedDocumentSha256: documentSha256 }
      : { undoneDocumentSha256: documentSha256 }),
    updatedAt: now,
  };
}

function idleOperationValues(
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect,
  failureCode: string | null,
  now: Date,
): Partial<typeof schema.grantDocumentAgentSuggestions.$inferInsert> {
  return {
    operationState: "idle",
    operationVersion: suggestion.operationVersion + 1,
    operationStartedAt: null,
    operationClientId: null,
    failureCode,
    updatedAt: now,
  };
}

function staleValues(
  suggestion: typeof schema.grantDocumentAgentSuggestions.$inferSelect,
  now: Date,
  failureCode: string | null,
): Partial<typeof schema.grantDocumentAgentSuggestions.$inferInsert> {
  return {
    status: "stale",
    statusVersion: suggestion.statusVersion + 1,
    failureCode,
    updatedAt: now,
  };
}

function toSuggestionDto(row: typeof schema.grantDocumentAgentSuggestions.$inferSelect): DocumentAgentSuggestionDto {
  return {
    id: row.id,
    runId: row.runId,
    ordinal: row.ordinal,
    anchor: row.anchor,
    location: row.location,
    beforeText: row.beforeText,
    afterText: row.afterText,
    format: row.format,
    rationale: row.rationale,
    evidence: row.evidence,
    status: row.status,
    statusVersion: row.statusVersion,
    operationState: row.operationState,
    operationVersion: row.operationVersion,
    operationStartedAt: row.operationStartedAt?.toISOString() ?? null,
    operationClientId: row.operationClientId,
    failureCode: row.failureCode,
    appliedDocumentSha256: row.appliedDocumentSha256,
    undoneDocumentSha256: row.undoneDocumentSha256,
    appliedRevisionId: row.appliedRevisionId,
    undoneRevisionId: row.undoneRevisionId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRunDto(
  row: typeof schema.grantDocumentAgentRuns.$inferSelect,
  suggestions: Array<typeof schema.grantDocumentAgentSuggestions.$inferSelect>,
): DocumentAgentRunDto {
  return {
    id: row.id,
    clientRequestId: row.clientRequestId,
    status: row.status,
    statusVersion: row.statusVersion,
    baseRevisionId: row.baseRevisionId,
    documentSha256: row.documentSha256,
    selectedPage: row.selectedPage,
    candidateId: row.candidateId,
    candidate: decodeDocumentEditCandidate(row.candidate),
    modelVersion: row.modelVersion,
    promptVersion: row.promptVersion,
    failureCode: row.failureCode,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    suggestions: suggestions.map(toSuggestionDto),
  };
}

function validateRunRequest(input: {
  draftId: string;
  clientRequestId: string;
  checkpointRequestId: string;
  baseRevisionId: string;
  selectedPage: number;
  candidateId: string;
  anchor: DocumentEditAnchor;
}): void {
  if (
    !isUuid(input.draftId)
    || !isUuid(input.clientRequestId)
    || !isUuid(input.checkpointRequestId)
    || !isUuid(input.baseRevisionId)
  ) {
    throw new DocumentAgentRunError("invalid_run_request", "문서 제안 요청 식별자가 올바르지 않습니다.", 400);
  }
  if (!Number.isSafeInteger(input.selectedPage) || input.selectedPage < 1 || input.selectedPage > 10_000) {
    throw new DocumentAgentRunError("invalid_selected_page", "선택한 쪽 번호가 올바르지 않습니다.", 400);
  }
  if (!SHA256_PATTERN.test(input.candidateId)) {
    throw new DocumentAgentRunError("invalid_candidate_id", "문서 후보 식별자가 올바르지 않습니다.", 400);
  }
  if (
    input.anchor.kind !== "body_paragraph"
    || !Number.isSafeInteger(input.anchor.section)
    || input.anchor.section < 0
    || !Number.isSafeInteger(input.anchor.paragraph)
    || input.anchor.paragraph < 0
    || input.anchor.charOffset !== 0
    || !Number.isSafeInteger(input.anchor.length)
    || input.anchor.length < 1
    || input.anchor.length > 4_000
  ) {
    throw new DocumentAgentRunError("invalid_candidate_anchor", "문서 후보 위치가 올바르지 않습니다.", 400);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
