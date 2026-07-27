import { DEEP_ANALYSIS_DEFAULT_LIMITS } from "@cunote/contracts";
import { and, eq, ne, sql } from "drizzle-orm";

import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { putImmutableDeepAnalysisArtifact } from "./artifacts";
import {
  AggregateSplitMaterializationError,
  buildAggregateSplitChildDrafts,
  loadValidatedAggregateSplitBundle,
  sealAggregateSplitChildInput,
  type AggregateSplitChildDraft,
  type AggregateSplitCompletedCaseIdentity,
} from "./aggregateSplitMaterializer";
import { stableJson } from "./sourceRevision";

const CHILD_INPUT_RUN_ID = "aggregate-split-preparation";

type AggregateSplitCase = typeof schema.grantAggregateSplitCases.$inferSelect;
type AggregateSplitChild = typeof schema.grantAggregateSplitChildren.$inferSelect;

export interface AggregateSplitMaterializationPolicy {
  leaseSeconds: number;
  maxCasesPerInvocation: number;
  maxChildInputChars: number;
}

export interface AggregateSplitMaterializationResult {
  claimed: number;
  prepared: number;
  retryScheduled: number;
  failed: number;
  lastFailure: {
    caseId: string;
    errorCode: string;
    status: "pending" | "failed";
  } | null;
}

export function resolveAggregateSplitMaterializationPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AggregateSplitMaterializationPolicy {
  return {
    leaseSeconds: integerEnv(
      env.AGGREGATE_SPLIT_MATERIALIZATION_LEASE_SECONDS,
      900,
      60,
      3_600,
    ),
    maxCasesPerInvocation: integerEnv(
      env.AGGREGATE_SPLIT_MATERIALIZATION_MAX_CASES_PER_INVOCATION,
      1,
      1,
      3,
    ),
    maxChildInputChars: integerEnv(
      env.AGGREGATE_SPLIT_MAX_CHILD_INPUT_CHARS,
      DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
      100_000,
      DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
    ),
  };
}

/**
 * E-2 completed와 E-3 materialization queue를 분리한다. claim은 단일 짧은
 * SKIP LOCKED 문장이고 R2 read/write 및 child 봉인은 반환 뒤에 수행한다.
 */
export async function claimAggregateSplitMaterializationCase(
  db: CunoteDbSession,
  input: {
    workerId: string;
    leaseSeconds: number;
    now?: Date;
  },
): Promise<AggregateSplitCase | null> {
  if (!input.workerId.trim()) throw new Error("workerId is required");
  if (
    !Number.isInteger(input.leaseSeconds)
    || input.leaseSeconds < 60
    || input.leaseSeconds > 3_600
  ) {
    throw new Error("leaseSeconds must be an integer between 60 and 3,600");
  }
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1_000);
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE grant_aggregate_split_cases
    SET
      materialization_status = 'processing',
      materialization_leased_at = ${now.toISOString()}::timestamptz,
      materialization_lease_expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
      materialization_worker_id = ${input.workerId},
      materialization_attempt_count = materialization_attempt_count + 1,
      updated_at = ${now.toISOString()}::timestamptz
    WHERE id = (
      SELECT candidate.id
      FROM grant_aggregate_split_cases AS candidate
      WHERE candidate.status = 'completed'
        AND candidate.materialization_attempt_count
          < candidate.materialization_max_attempts
        AND (
          (
            candidate.materialization_status = 'pending'
            AND candidate.materialization_available_at
              <= ${now.toISOString()}::timestamptz
          )
          OR (
            candidate.materialization_status = 'processing'
            AND candidate.materialization_lease_expires_at
              <= ${now.toISOString()}::timestamptz
          )
        )
      ORDER BY
        candidate.materialization_available_at ASC,
        candidate.created_at ASC
      LIMIT 1
      FOR UPDATE OF candidate SKIP LOCKED
    )
    RETURNING id::text AS id
  `);
  const claimedId = claimed[0]?.id;
  if (!claimedId) return null;
  const [splitCase] = await db
    .select()
    .from(schema.grantAggregateSplitCases)
    .where(eq(schema.grantAggregateSplitCases.id, claimedId))
    .limit(1);
  if (!splitCase) {
    throw new Error(`Claimed aggregate split materialization disappeared: ${claimedId}`);
  }
  return splitCase;
}

export async function runAggregateSplitMaterializationInvocation(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  workerId: string;
  policy?: AggregateSplitMaterializationPolicy;
  now?: () => Date;
}): Promise<AggregateSplitMaterializationResult> {
  const policy = input.policy ?? resolveAggregateSplitMaterializationPolicy();
  const now = input.now ?? (() => new Date());
  const result: AggregateSplitMaterializationResult = {
    claimed: 0,
    prepared: 0,
    retryScheduled: 0,
    failed: 0,
    lastFailure: null,
  };
  const exhausted = await failExhaustedAggregateSplitMaterializationLeases(
    input.db,
    now(),
  );
  result.failed += exhausted.length;
  if (exhausted.length > 0) {
    result.lastFailure = {
      caseId: exhausted.at(-1)!.id,
      errorCode: "aggregate_split_materialization_lease_exhausted",
      status: "failed",
    };
  }
  for (let index = 0; index < policy.maxCasesPerInvocation; index += 1) {
    const splitCase = await claimAggregateSplitMaterializationCase(input.db, {
      workerId: input.workerId,
      leaseSeconds: policy.leaseSeconds,
      now: now(),
    });
    if (!splitCase) break;
    result.claimed += 1;
    try {
      await prepareAggregateSplitChildren({
        ...input,
        splitCase,
        policy,
        now,
      });
      result.prepared += 1;
    } catch (error) {
      const failure = await failAggregateSplitMaterialization(input.db, {
        splitCase,
        workerId: input.workerId,
        error,
        now: now(),
      });
      if (failure.status === "pending") result.retryScheduled += 1;
      else result.failed += 1;
      result.lastFailure = {
        caseId: splitCase.id,
        errorCode: failure.errorCode,
        status: failure.status,
      };
    }
  }
  return result;
}

/**
 * 마지막 허용 attempt에서 process가 종료되면 재claim 조건을 만족하지 못한다.
 * 만료 lease를 명시적 failed evidence로 닫아 processing 고착을 방지한다.
 */
export async function failExhaustedAggregateSplitMaterializationLeases(
  db: CunoteDbSession,
  now: Date,
): Promise<Array<{ id: string }>> {
  return db.execute<{ id: string }>(sql`
    UPDATE grant_aggregate_split_cases
    SET
      materialization_status = 'failed',
      materialization_leased_at = NULL,
      materialization_lease_expires_at = NULL,
      materialization_worker_id = NULL,
      materialization_last_error_code =
        'aggregate_split_materialization_lease_exhausted',
      materialization_last_error_message =
        '마지막 허용 시도의 worker lease가 완료 evidence 없이 만료됐습니다.',
      updated_at = ${now.toISOString()}::timestamptz
    WHERE status = 'completed'
      AND materialization_status = 'processing'
      AND materialization_attempt_count >= materialization_max_attempts
      AND materialization_lease_expires_at <= ${now.toISOString()}::timestamptz
    RETURNING id::text AS id
  `);
}

async function prepareAggregateSplitChildren(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  workerId: string;
  splitCase: AggregateSplitCase;
  policy: AggregateSplitMaterializationPolicy;
  now: () => Date;
}): Promise<void> {
  const identity = completedCaseIdentity(input.splitCase);
  const bundle = await loadValidatedAggregateSplitBundle({
    storage: input.storage,
    splitCase: identity,
    maxChildInputChars: input.policy.maxChildInputChars,
  });
  const drafts = buildAggregateSplitChildDrafts({
    splitCase: identity,
    bundle,
  });
  if (drafts.length !== input.splitCase.programCount) {
    throw new AggregateSplitMaterializationError(
      "aggregate_split_child_count_mismatch",
      "파생 공고 draft 수가 검증된 manifest program 수와 다릅니다.",
      false,
    );
  }

  const failures: Array<{
    stableKey: string;
    code: string;
    message: string;
    retryable: boolean;
  }> = [];
  for (const draft of drafts) {
    await renewAggregateSplitMaterializationLease(input.db, {
      caseId: input.splitCase.id,
      workerId: input.workerId,
      leaseSeconds: input.policy.leaseSeconds,
      now: input.now(),
    });
    let child: AggregateSplitChild | null = null;
    try {
      child = await ensureAggregateSplitChildRow(input.db, {
        splitCase: input.splitCase,
        draft,
        now: input.now(),
      });
      const seal = sealAggregateSplitChildInput({
        childGrantId: child.id,
        draft,
        maxTotalChars: input.policy.maxChildInputChars,
      });
      const artifact = await putImmutableDeepAnalysisArtifact({
        storage: input.storage,
        identity: {
          grantId: child.id,
          sourceRevisionSha256: draft.sourceRevisionSha256,
          runId: CHILD_INPUT_RUN_ID,
          kind: "input",
          extension: "json",
        },
        body: seal.inputArtifactBody,
        contentType: "application/json",
      });
      if (artifact.sha256 !== seal.inputSha256) {
        throw new AggregateSplitMaterializationError(
          "aggregate_split_child_input_hash_mismatch",
          `${draft.stableKey} input artifact hash가 seal과 다릅니다.`,
          false,
        );
      }
      const preparedAt = input.now();
      const [prepared] = await input.db
        .update(schema.grantAggregateSplitChildren)
        .set({
          status: "prepared",
          attachmentManifestSha256: seal.attachmentManifestSha256,
          inputArtifactKey: artifact.key,
          inputSha256: artifact.sha256,
          inputChars: seal.totalChars,
          preparedAt,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: preparedAt,
        })
        .where(and(
          eq(schema.grantAggregateSplitChildren.id, child.id),
          eq(schema.grantAggregateSplitChildren.splitCaseId, input.splitCase.id),
          eq(
            schema.grantAggregateSplitChildren.sourceRevisionSha256,
            draft.sourceRevisionSha256,
          ),
        ))
        .returning({ id: schema.grantAggregateSplitChildren.id });
      if (!prepared) {
        throw new Error(`Failed to mark aggregate split child prepared: ${child.id}`);
      }
    } catch (error) {
      const normalized = normalizeMaterializationFailure(error);
      failures.push({
        stableKey: draft.stableKey,
        ...normalized,
      });
      if (child?.status !== "prepared") {
        await recordAggregateSplitChildFailure(input.db, {
          childId: child?.id ?? null,
          splitCaseId: input.splitCase.id,
          stableKey: draft.stableKey,
          errorCode: normalized.code,
          errorMessage: normalized.message,
          now: input.now(),
        });
      }
    }
  }

  const children = await input.db
    .select()
    .from(schema.grantAggregateSplitChildren)
    .where(eq(schema.grantAggregateSplitChildren.splitCaseId, input.splitCase.id));
  const expectedKeys = new Set(drafts.map((draft) => draft.stableKey));
  const preparedChildren = children.filter((child) => (
    expectedKeys.has(child.stableKey)
    && child.status === "prepared"
    && child.manifestSha256 === input.splitCase.manifestSha256
  ));
  if (
    failures.length > 0
    || children.length !== drafts.length
    || preparedChildren.length !== drafts.length
  ) {
    await input.db
      .update(schema.grantAggregateSplitCases)
      .set({
        preparedChildCount: preparedChildren.length,
        updatedAt: input.now(),
      })
      .where(and(
        eq(schema.grantAggregateSplitCases.id, input.splitCase.id),
        eq(schema.grantAggregateSplitCases.materializationStatus, "processing"),
        eq(schema.grantAggregateSplitCases.materializationWorkerId, input.workerId),
      ));
    const retryable = failures.length > 0
      && failures.every((failure) => failure.retryable);
    throw new AggregateSplitMaterializationError(
      "aggregate_split_children_incomplete",
      failures.length > 0
        ? `파생 공고 ${failures.length}개 준비 실패: ${
          failures.map((failure) => `${failure.stableKey}:${failure.code}`).join(", ")
        }`
        : `파생 공고 준비 수가 ${preparedChildren.length}/${drafts.length}입니다.`,
      retryable,
    );
  }

  const completedAt = input.now();
  const [completed] = await input.db
    .update(schema.grantAggregateSplitCases)
    .set({
      materializationStatus: "prepared",
      materializationLeasedAt: null,
      materializationLeaseExpiresAt: null,
      materializationWorkerId: null,
      preparedChildCount: preparedChildren.length,
      childrenPreparedAt: completedAt,
      materializationLastErrorCode: null,
      materializationLastErrorMessage: null,
      promotionStatus: "pending",
      promotionLastErrorCode: null,
      promotionLastErrorMessage: null,
      updatedAt: completedAt,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.splitCase.id),
      eq(schema.grantAggregateSplitCases.status, "completed"),
      eq(schema.grantAggregateSplitCases.materializationStatus, "processing"),
      eq(schema.grantAggregateSplitCases.materializationWorkerId, input.workerId),
    ))
    .returning({ id: schema.grantAggregateSplitCases.id });
  if (!completed) {
    throw new Error("Aggregate split materialization completion lost its lease");
  }
}

async function ensureAggregateSplitChildRow(
  db: CunoteDbSession,
  input: {
    splitCase: AggregateSplitCase;
    draft: AggregateSplitChildDraft;
    now: Date;
  },
): Promise<AggregateSplitChild> {
  const [inserted] = await db
    .insert(schema.grantAggregateSplitChildren)
    .values({
      splitCaseId: input.splitCase.id,
      parentGrantId: input.splitCase.grantId,
      stableKey: input.draft.stableKey,
      ordinal: input.draft.ordinal,
      source: input.draft.source,
      sourceId: input.draft.sourceId,
      title: input.draft.title,
      agencyPrimary: input.draft.agencyPrimary,
      grantProjection: input.draft.grantProjection,
      grantProjectionSha256: input.draft.grantProjectionSha256,
      manifestSha256: input.draft.manifestSha256,
      sourceRevisionSha256: input.draft.sourceRevisionSha256,
      rawPayloadSha256: input.draft.rawPayloadSha256,
      updatedAt: input.now,
    })
    .onConflictDoNothing({
      target: [
        schema.grantAggregateSplitChildren.splitCaseId,
        schema.grantAggregateSplitChildren.stableKey,
      ],
    })
    .returning();
  const child = inserted ?? (await db
    .select()
    .from(schema.grantAggregateSplitChildren)
    .where(and(
      eq(schema.grantAggregateSplitChildren.splitCaseId, input.splitCase.id),
      eq(schema.grantAggregateSplitChildren.stableKey, input.draft.stableKey),
    ))
    .limit(1))[0];
  if (!child) {
    throw new Error(`Aggregate split child upsert disappeared: ${input.draft.stableKey}`);
  }
  const immutableIdentity = {
    parentGrantId: child.parentGrantId,
    ordinal: child.ordinal,
    source: child.source,
    sourceId: child.sourceId,
    title: child.title,
    agencyPrimary: child.agencyPrimary,
    grantProjectionSha256: child.grantProjectionSha256,
    manifestSha256: child.manifestSha256,
    sourceRevisionSha256: child.sourceRevisionSha256,
    rawPayloadSha256: child.rawPayloadSha256,
  };
  const expectedIdentity = {
    parentGrantId: input.splitCase.grantId,
    ordinal: input.draft.ordinal,
    source: input.draft.source,
    sourceId: input.draft.sourceId,
    title: input.draft.title,
    agencyPrimary: input.draft.agencyPrimary,
    grantProjectionSha256: input.draft.grantProjectionSha256,
    manifestSha256: input.draft.manifestSha256,
    sourceRevisionSha256: input.draft.sourceRevisionSha256,
    rawPayloadSha256: input.draft.rawPayloadSha256,
  };
  if (stableJson(immutableIdentity) !== stableJson(expectedIdentity)) {
    throw new AggregateSplitMaterializationError(
      "aggregate_split_child_identity_conflict",
      `${input.draft.stableKey} 기존 파생 공고 identity가 manifest와 다릅니다.`,
      false,
    );
  }
  return child;
}

async function recordAggregateSplitChildFailure(
  db: CunoteDbSession,
  input: {
    childId: string | null;
    splitCaseId: string;
    stableKey: string;
    errorCode: string;
    errorMessage: string;
    now: Date;
  },
): Promise<void> {
  if (!input.childId) return;
  await db
    .update(schema.grantAggregateSplitChildren)
    .set({
      status: "failed",
      lastErrorCode: input.errorCode,
      lastErrorMessage: input.errorMessage.slice(0, 2_000),
      updatedAt: input.now,
    })
    .where(and(
      eq(schema.grantAggregateSplitChildren.id, input.childId),
      eq(schema.grantAggregateSplitChildren.splitCaseId, input.splitCaseId),
      eq(schema.grantAggregateSplitChildren.stableKey, input.stableKey),
      ne(schema.grantAggregateSplitChildren.status, "prepared"),
    ));
}

async function renewAggregateSplitMaterializationLease(
  db: CunoteDbSession,
  input: {
    caseId: string;
    workerId: string;
    leaseSeconds: number;
    now: Date;
  },
): Promise<void> {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseSeconds * 1_000);
  const [renewed] = await db
    .update(schema.grantAggregateSplitCases)
    .set({
      materializationLeaseExpiresAt: leaseExpiresAt,
      updatedAt: input.now,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.caseId),
      eq(schema.grantAggregateSplitCases.materializationStatus, "processing"),
      eq(schema.grantAggregateSplitCases.materializationWorkerId, input.workerId),
    ))
    .returning({ id: schema.grantAggregateSplitCases.id });
  if (!renewed) throw new Error("Aggregate split materialization worker lost its lease");
}

async function failAggregateSplitMaterialization(
  db: CunoteDbSession,
  input: {
    splitCase: AggregateSplitCase;
    workerId: string;
    error: unknown;
    now: Date;
  },
): Promise<{ status: "pending" | "failed"; errorCode: string }> {
  const failure = normalizeMaterializationFailure(input.error);
  const status = failure.retryable
    && input.splitCase.materializationAttemptCount
      < input.splitCase.materializationMaxAttempts
    ? "pending"
    : "failed";
  const retryDelayMinutes = Math.min(
    30,
    2 ** Math.max(0, input.splitCase.materializationAttemptCount - 1),
  );
  const [failed] = await db
    .update(schema.grantAggregateSplitCases)
    .set({
      materializationStatus: status,
      materializationAvailableAt: status === "pending"
        ? new Date(input.now.getTime() + retryDelayMinutes * 60_000)
        : input.splitCase.materializationAvailableAt,
      materializationLeasedAt: null,
      materializationLeaseExpiresAt: null,
      materializationWorkerId: null,
      materializationLastErrorCode: failure.code,
      materializationLastErrorMessage: failure.message.slice(0, 2_000),
      updatedAt: input.now,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.splitCase.id),
      eq(schema.grantAggregateSplitCases.materializationStatus, "processing"),
      eq(schema.grantAggregateSplitCases.materializationWorkerId, input.workerId),
    ))
    .returning({ id: schema.grantAggregateSplitCases.id });
  if (!failed) throw new Error("Aggregate split materialization failure lost its lease");
  return { status, errorCode: failure.code };
}

function completedCaseIdentity(
  splitCase: AggregateSplitCase,
): AggregateSplitCompletedCaseIdentity {
  if (
    splitCase.status !== "completed"
    || !splitCase.inputArtifactKey
    || !splitCase.inputSha256
    || !splitCase.manifestArtifactKey
    || !splitCase.manifestSha256
    || !splitCase.model
    || splitCase.segmentCount === null
    || splitCase.programCount === null
  ) {
    throw new AggregateSplitMaterializationError(
      "aggregate_split_case_not_completed",
      "E-2 완료 evidence가 없는 통합공고 case는 파생 공고를 준비할 수 없습니다.",
      false,
    );
  }
  return {
    id: splitCase.id,
    grantId: splitCase.grantId,
    sourceRevisionSha256: splitCase.sourceRevisionSha256,
    inputArtifactKey: splitCase.inputArtifactKey,
    inputSha256: splitCase.inputSha256,
    manifestArtifactKey: splitCase.manifestArtifactKey,
    manifestSha256: splitCase.manifestSha256,
    model: splitCase.model,
    segmentCount: splitCase.segmentCount,
    programCount: splitCase.programCount,
  };
}

function normalizeMaterializationFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof AggregateSplitMaterializationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "aggregate_split_materialization_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function integerEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected integer between ${min} and ${max}, received ${raw}`);
  }
  return parsed;
}
