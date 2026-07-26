import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_AGGREGATE_SPLIT_DEFAULT_MAX_COST_USD,
  DEEP_ANALYSIS_PRIMARY_MODELS,
  isAllowedDeepAnalysisPrimaryModel,
} from "@cunote/contracts";
import { and, eq, sql } from "drizzle-orm";

import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  putImmutableAggregateSplitArtifact,
} from "./artifacts";
import {
  AGGREGATE_SPLIT_MAP_PROMPT_VERSION,
  AGGREGATE_SPLIT_SYNTHESIS_PROMPT_VERSION,
  AggregateSplitManifestError,
  buildAggregateSplitManifest,
  runAggregateSplitModel,
  type AggregateSplitModelPass,
  type AggregateSplitModelRunner,
} from "./aggregateSplitManifest";
import { prepareDeepAnalysisInput } from "./prepareInput";
import { stableJson } from "./sourceRevision";

type AggregateSplitCase = typeof schema.grantAggregateSplitCases.$inferSelect;

export interface AggregateSplitWorkerPolicy {
  model: string;
  leaseSeconds: number;
  maxCasesPerInvocation: number;
  maxCostUsd: number;
  maxChildInputChars: number;
}

export interface AggregateSplitWorkerResult {
  claimed: number;
  completed: number;
  retryScheduled: number;
  failed: number;
  lastFailure: {
    caseId: string;
    errorCode: string;
    status: "approved" | "failed";
  } | null;
}

export function resolveAggregateSplitWorkerPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AggregateSplitWorkerPolicy {
  const model = env.AGGREGATE_SPLIT_MODEL?.trim() || DEEP_ANALYSIS_PRIMARY_MODELS[0];
  if (!isAllowedDeepAnalysisPrimaryModel(model)) {
    throw new Error(`AGGREGATE_SPLIT_MODEL is not allowlisted: ${model}`);
  }
  return {
    model,
    leaseSeconds: integerEnv(env.AGGREGATE_SPLIT_LEASE_SECONDS, 3_600, 300, 7_200),
    maxCasesPerInvocation: integerEnv(
      env.AGGREGATE_SPLIT_MAX_CASES_PER_INVOCATION,
      1,
      1,
      3,
    ),
    maxCostUsd: numberEnv(
      env.AGGREGATE_SPLIT_MAX_COST_USD,
      DEEP_ANALYSIS_AGGREGATE_SPLIT_DEFAULT_MAX_COST_USD,
      1,
      100,
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
 * 승인된 case 하나만 짧은 SKIP LOCKED 문장으로 claim한다. 외부 R2/LLM 호출은
 * 반환 뒤에 수행하며 만료된 processing lease만 재claim할 수 있다.
 */
export async function claimApprovedAggregateSplitCase(
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
    || input.leaseSeconds < 300
    || input.leaseSeconds > 7_200
  ) {
    throw new Error("leaseSeconds must be an integer between 300 and 7,200");
  }
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1_000);
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE grant_aggregate_split_cases
    SET
      status = 'processing',
      leased_at = ${now.toISOString()}::timestamptz,
      lease_expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
      worker_id = ${input.workerId},
      processing_started_at = COALESCE(
        processing_started_at,
        ${now.toISOString()}::timestamptz
      ),
      attempt_count = attempt_count + 1,
      updated_at = ${now.toISOString()}::timestamptz
    WHERE id = (
      SELECT candidate.id
      FROM grant_aggregate_split_cases candidate
      WHERE candidate.attempt_count < candidate.max_attempts
        AND (
          (
            candidate.status = 'approved'
            AND candidate.available_at <= ${now.toISOString()}::timestamptz
          )
          OR (
            candidate.status = 'processing'
            AND candidate.lease_expires_at <= ${now.toISOString()}::timestamptz
          )
        )
      ORDER BY candidate.available_at ASC, candidate.created_at ASC
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
  if (!splitCase) throw new Error(`Claimed aggregate split case disappeared: ${claimedId}`);
  return splitCase;
}

export async function runAggregateSplitWorkerInvocation(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  apiKey: string;
  workerId: string;
  policy?: AggregateSplitWorkerPolicy;
  runModel?: AggregateSplitModelRunner;
  now?: () => Date;
}): Promise<AggregateSplitWorkerResult> {
  const policy = input.policy ?? resolveAggregateSplitWorkerPolicy();
  const now = input.now ?? (() => new Date());
  const result: AggregateSplitWorkerResult = {
    claimed: 0,
    completed: 0,
    retryScheduled: 0,
    failed: 0,
    lastFailure: null,
  };
  for (let index = 0; index < policy.maxCasesPerInvocation; index += 1) {
    const splitCase = await claimApprovedAggregateSplitCase(input.db, {
      workerId: input.workerId,
      leaseSeconds: policy.leaseSeconds,
      now: now(),
    });
    if (!splitCase) break;
    result.claimed += 1;
    try {
      await processAggregateSplitCase({
        ...input,
        policy,
        splitCase,
        runModel: input.runModel ?? runAggregateSplitModel,
        now,
      });
      result.completed += 1;
    } catch (error) {
      const failure = await failAggregateSplitCase(input.db, {
        splitCase,
        workerId: input.workerId,
        error,
        now: now(),
      });
      if (failure.status === "approved") result.retryScheduled += 1;
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

async function processAggregateSplitCase(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  apiKey: string;
  workerId: string;
  policy: AggregateSplitWorkerPolicy;
  splitCase: AggregateSplitCase;
  runModel: AggregateSplitModelRunner;
  now: () => Date;
}): Promise<void> {
  const seal = await prepareDeepAnalysisInput({
    db: input.db,
    storage: input.storage,
    grantId: input.splitCase.grantId,
    maxTotalChars: input.splitCase.inputCapChars,
  });
  if (seal.sourceRevisionSha256 !== input.splitCase.sourceRevisionSha256) {
    throw new AggregateSplitManifestError(
      "aggregate_split_source_changed",
      "승인 뒤 원문 revision이 바뀌어 분리 실행을 중단했습니다.",
      false,
    );
  }
  if (seal.totalChars !== input.splitCase.inputChars) {
    throw new AggregateSplitManifestError(
      "aggregate_split_input_changed",
      "승인한 입력 크기와 현재 입력 크기가 달라 분리 실행을 중단했습니다.",
      false,
    );
  }

  const inputArtifact = await putImmutableAggregateSplitArtifact({
    storage: input.storage,
    identity: {
      grantId: input.splitCase.grantId,
      sourceRevisionSha256: input.splitCase.sourceRevisionSha256,
      caseId: input.splitCase.id,
      kind: "input",
    },
    body: seal.inputArtifactBody,
  });
  if (inputArtifact.sha256 !== seal.inputSha256) {
    throw new Error("Aggregate split input artifact hash does not match sealed input");
  }
  const [inputRecorded] = await input.db
    .update(schema.grantAggregateSplitCases)
    .set({
      inputArtifactKey: inputArtifact.key,
      inputSha256: inputArtifact.sha256,
      updatedAt: input.now(),
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.splitCase.id),
      eq(schema.grantAggregateSplitCases.status, "processing"),
      eq(schema.grantAggregateSplitCases.workerId, input.workerId),
    ))
    .returning({ id: schema.grantAggregateSplitCases.id });
  if (!inputRecorded) throw new Error("Aggregate split input artifact lost its lease");

  const observedPasses: AggregateSplitModelPass[] = [];
  let build: Awaited<ReturnType<typeof buildAggregateSplitManifest>>;
  try {
    const approvedCostCapUsd = Number(input.splitCase.costCapUsd);
    const effectiveCostCapUsd = Math.min(
      input.policy.maxCostUsd,
      approvedCostCapUsd,
    );
    const remainingCostUsd = effectiveCostCapUsd
      - Number(input.splitCase.costUsd ?? 0);
    if (remainingCostUsd <= 0) {
      throw new AggregateSplitManifestError(
        "aggregate_split_budget_exceeded",
        "이 분리 케이스가 누적 비용 상한을 이미 소진했습니다.",
        false,
      );
    }
    build = await buildAggregateSplitManifest({
      caseId: input.splitCase.id,
      seal,
      apiKey: input.apiKey,
      model: input.policy.model,
      maxChildInputChars: input.policy.maxChildInputChars,
      maxCostUsd: remainingCostUsd,
      runModel: async (request) => {
        await renewAggregateSplitLease(input.db, {
          caseId: input.splitCase.id,
          workerId: input.workerId,
          leaseSeconds: input.policy.leaseSeconds,
          now: input.now(),
        });
        const result = await input.runModel(request);
        observedPasses.push(result.pass);
        return result;
      },
    });
  } catch (error) {
    await persistAggregateSplitFailureEvidence({
      db: input.db,
      storage: input.storage,
      splitCase: input.splitCase,
      workerId: input.workerId,
      model: input.policy.model,
      passes: observedPasses,
      error,
      now: input.now(),
    });
    throw error;
  }
  const rawArtifactBody = `${stableJson({
    schema: "aggregate-split-raw-passes-v1",
    caseId: input.splitCase.id,
    grantId: input.splitCase.grantId,
    sourceRevisionSha256: input.splitCase.sourceRevisionSha256,
    model: input.policy.model,
    passes: build.passes,
  })}\n`;
  const rawArtifact = await putImmutableAggregateSplitArtifact({
    storage: input.storage,
    identity: {
      grantId: input.splitCase.grantId,
      sourceRevisionSha256: input.splitCase.sourceRevisionSha256,
      caseId: input.splitCase.id,
      kind: "raw-response",
    },
    body: rawArtifactBody,
  });
  const manifestArtifactBody = `${stableJson(build.manifest)}\n`;
  const manifestArtifact = await putImmutableAggregateSplitArtifact({
    storage: input.storage,
    identity: {
      grantId: input.splitCase.grantId,
      sourceRevisionSha256: input.splitCase.sourceRevisionSha256,
      caseId: input.splitCase.id,
      kind: "manifest",
    },
    body: manifestArtifactBody,
  });
  const completedAt = input.now();
  const [completed] = await input.db
    .update(schema.grantAggregateSplitCases)
    .set({
      status: "completed",
      leasedAt: null,
      leaseExpiresAt: null,
      workerId: null,
      completedAt,
      model: input.policy.model,
      promptVersion: [
        AGGREGATE_SPLIT_MAP_PROMPT_VERSION,
        AGGREGATE_SPLIT_SYNTHESIS_PROMPT_VERSION,
      ].join("+"),
      manifestArtifactKey: manifestArtifact.key,
      manifestSha256: manifestArtifact.sha256,
      rawResponseArtifactKey: rawArtifact.key,
      rawResponseSha256: rawArtifact.sha256,
      segmentCount: build.manifest.coverage.segmentCount,
      programCount: build.manifest.programs.length,
      externalCallsMade: (input.splitCase.externalCallsMade ?? 0)
        + build.manifest.execution.externalCallsMade,
      inputTokens: (input.splitCase.inputTokens ?? 0)
        + (build.manifest.execution.usage?.inputTokens ?? 0),
      outputTokens: (input.splitCase.outputTokens ?? 0)
        + (build.manifest.execution.usage?.outputTokens ?? 0),
      costUsd: (
        Number(input.splitCase.costUsd ?? 0)
        + (build.manifest.execution.actualCostUsd ?? 0)
      ).toFixed(6),
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: completedAt,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.splitCase.id),
      eq(schema.grantAggregateSplitCases.status, "processing"),
      eq(schema.grantAggregateSplitCases.workerId, input.workerId),
    ))
    .returning({ id: schema.grantAggregateSplitCases.id });
  if (!completed) {
    throw new Error("Aggregate split completion lost its lease");
  }
}

async function persistAggregateSplitFailureEvidence(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  splitCase: AggregateSplitCase;
  workerId: string;
  model: string;
  passes: AggregateSplitModelPass[];
  error: unknown;
  now: Date;
}): Promise<void> {
  const errorExternalCalls = input.error instanceof AggregateSplitManifestError
    ? input.error.externalCallsMade
    : 0;
  const externalCallsMade = input.passes.reduce(
    (sum, pass) => sum + pass.externalCallsMade,
    errorExternalCalls,
  );
  if (externalCallsMade === 0 && input.passes.length === 0) return;
  const body = `${stableJson({
    schema: "aggregate-split-raw-passes-v1",
    state: "failed",
    caseId: input.splitCase.id,
    grantId: input.splitCase.grantId,
    sourceRevisionSha256: input.splitCase.sourceRevisionSha256,
    model: input.model,
    passes: input.passes,
    error: {
      code: input.error instanceof AggregateSplitManifestError
        ? input.error.code
        : "aggregate_split_worker_failed",
      message: (input.error instanceof Error
        ? input.error.message
        : String(input.error)).slice(0, 2_000),
    },
  })}\n`;
  const artifact = await putImmutableAggregateSplitArtifact({
    storage: input.storage,
    identity: {
      grantId: input.splitCase.grantId,
      sourceRevisionSha256: input.splitCase.sourceRevisionSha256,
      caseId: input.splitCase.id,
      kind: "raw-response",
    },
    body,
  });
  const usage = input.passes.reduce((total, pass) => ({
    inputTokens: total.inputTokens + (pass.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (pass.usage?.outputTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0 });
  const costs = input.passes
    .map((pass) => pass.costUsd)
    .filter((cost): cost is number => cost !== null);
  const [recorded] = await input.db
    .update(schema.grantAggregateSplitCases)
    .set({
      model: input.model,
      promptVersion: [
        AGGREGATE_SPLIT_MAP_PROMPT_VERSION,
        AGGREGATE_SPLIT_SYNTHESIS_PROMPT_VERSION,
      ].join("+"),
      rawResponseArtifactKey: artifact.key,
      rawResponseSha256: artifact.sha256,
      externalCallsMade: (input.splitCase.externalCallsMade ?? 0) + externalCallsMade,
      inputTokens: (input.splitCase.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (input.splitCase.outputTokens ?? 0) + usage.outputTokens,
      costUsd: costs.length === 0
        ? input.splitCase.costUsd
        : (
          Number(input.splitCase.costUsd ?? 0)
          + costs.reduce((sum, cost) => sum + cost, 0)
        ).toFixed(6),
      updatedAt: input.now,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.splitCase.id),
      eq(schema.grantAggregateSplitCases.status, "processing"),
      eq(schema.grantAggregateSplitCases.workerId, input.workerId),
    ))
    .returning({ id: schema.grantAggregateSplitCases.id });
  if (!recorded) throw new Error("Aggregate split failure evidence lost its lease");
}

async function renewAggregateSplitLease(
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
      leaseExpiresAt,
      updatedAt: input.now,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.caseId),
      eq(schema.grantAggregateSplitCases.status, "processing"),
      eq(schema.grantAggregateSplitCases.workerId, input.workerId),
    ))
    .returning({ id: schema.grantAggregateSplitCases.id });
  if (!renewed) throw new Error("Aggregate split worker lost its lease");
}

async function failAggregateSplitCase(
  db: CunoteDbSession,
  input: {
    splitCase: AggregateSplitCase;
    workerId: string;
    error: unknown;
    now: Date;
  },
): Promise<{ status: "approved" | "failed"; errorCode: string }> {
  const errorCode = input.error instanceof AggregateSplitManifestError
    ? input.error.code
    : "aggregate_split_worker_failed";
  const retryable = !(input.error instanceof AggregateSplitManifestError)
    || input.error.retryable;
  const status = retryable && input.splitCase.attemptCount < input.splitCase.maxAttempts
    ? "approved"
    : "failed";
  const retryDelayMinutes = Math.min(30, 2 ** Math.max(0, input.splitCase.attemptCount - 1));
  const [failed] = await db
    .update(schema.grantAggregateSplitCases)
    .set({
      status,
      availableAt: status === "approved"
        ? new Date(input.now.getTime() + retryDelayMinutes * 60_000)
        : input.splitCase.availableAt,
      leasedAt: null,
      leaseExpiresAt: null,
      workerId: null,
      lastErrorCode: errorCode,
      lastErrorMessage: (
        input.error instanceof Error ? input.error.message : String(input.error)
      ).slice(0, 2_000),
      updatedAt: input.now,
    })
    .where(and(
      eq(schema.grantAggregateSplitCases.id, input.splitCase.id),
      eq(schema.grantAggregateSplitCases.status, "processing"),
      eq(schema.grantAggregateSplitCases.workerId, input.workerId),
    ))
    .returning({ id: schema.grantAggregateSplitCases.id });
  if (!failed) throw new Error("Aggregate split failure handler lost its lease");
  return { status, errorCode };
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

function numberEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected number between ${min} and ${max}, received ${raw}`);
  }
  return parsed;
}
