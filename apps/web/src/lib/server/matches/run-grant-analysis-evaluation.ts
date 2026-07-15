import { createHash } from "node:crypto";
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";

export const GRANT_ANALYSIS_EVALUATION_RUN_VERSION =
  "grant-analysis-evaluation-gate1-v1";
export const GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION =
  "RUN_GRANT_ANALYSIS_EVALUATION_PAID";
export const GRANT_ANALYSIS_EVALUATION_ABSOLUTE_MAX_CALLS = 200;

export const GRANT_ANALYSIS_EVALUATION_STAGES = [
  "extract_b",
  "extract_c",
  "judge_1",
  "judge_2",
  "judge_3",
] as const;
export type GrantAnalysisEvaluationStage =
  (typeof GRANT_ANALYSIS_EVALUATION_STAGES)[number];

export interface GrantAnalysisEvaluationRunGrant {
  grantKey: string;
  sourceRevision: string;
  inputOrder: readonly string[];
  apiInputSha256: string;
  attachmentInputSha256: string;
  estimatedInputTokens: Readonly<Record<GrantAnalysisEvaluationStage, number>>;
}

export interface GrantAnalysisEvaluationRunFingerprintInput {
  runVersion: string;
  manifestSha256: string;
  inputLimitsSha256: string;
  converter: { version: string; policySha256: string };
  extractor: { model: string; promptSha256: string; schemaSha256: string };
  judges: {
    judge1: { model: string; promptSha256: string; schemaSha256: string };
    judge2: { model: string; promptSha256: string; schemaSha256: string };
    judge3: { model: string; promptSha256: string; schemaSha256: string };
  };
}

export interface GrantAnalysisEvaluationStageCheckpoint {
  status: "running" | "success" | "failed" | "skipped";
  attempts: number;
  result?: unknown;
  lastError?: string;
  eligibleAxes?: readonly CriterionDimension[];
  reusedFrom?: GrantAnalysisEvaluationStage;
}

export interface GrantAnalysisEvaluationGrantCheckpoint {
  grantKey: string;
  sourceRevision: string;
  stages: Partial<Record<GrantAnalysisEvaluationStage, GrantAnalysisEvaluationStageCheckpoint>>;
}

export interface GrantAnalysisEvaluationRunCheckpoint {
  recordType: "grant_analysis_evaluation_run_checkpoint";
  schemaVersion: 1;
  fingerprint: string;
  fingerprintInput: GrantAnalysisEvaluationRunFingerprintInput;
  grantsFingerprint: string;
  grants: Record<string, GrantAnalysisEvaluationGrantCheckpoint>;
  databaseWriteMode: false;
}

export interface GrantAnalysisEvaluationCheckpointStore {
  read(): Promise<GrantAnalysisEvaluationRunCheckpoint | null>;
  write(checkpoint: GrantAnalysisEvaluationRunCheckpoint): Promise<void>;
}

export interface GrantAnalysisEvaluationStageContext {
  grant: GrantAnalysisEvaluationRunGrant;
  stage: GrantAnalysisEvaluationStage;
  attempt: number;
  eligibleAxes: readonly CriterionDimension[];
  priorStages: Readonly<
    Partial<Record<GrantAnalysisEvaluationStage, GrantAnalysisEvaluationStageCheckpoint>>
  >;
}

export interface GrantAnalysisEvaluationRunnerDependencies {
  checkpointStore: GrantAnalysisEvaluationCheckpointStore;
  executeStage(context: GrantAnalysisEvaluationStageContext): Promise<unknown>;
  judge3EligibleAxes(options: {
    grant: GrantAnalysisEvaluationRunGrant;
    judge1Result: unknown;
    judge2Result: unknown;
  }): readonly CriterionDimension[];
}

export interface GrantAnalysisEvaluationCostRate {
  inputPerMillion: number;
  outputPerMillion: number;
  estimatedOutputTokens: number;
}

export interface GrantAnalysisEvaluationRunPlan {
  mode: "plan";
  fingerprint: string;
  grantCount: number;
  maximumCalls: number;
  callsByStage: Record<GrantAnalysisEvaluationStage, number>;
  estimatedInputTokensByStage: Record<GrantAnalysisEvaluationStage, number>;
  estimatedCostByStage: Record<GrantAnalysisEvaluationStage, number | null>;
  databaseWriteMode: false;
  externalCallsMade: 0;
}

export interface GrantAnalysisEvaluationRunReceipt {
  mode: "paid";
  fingerprint: string;
  checkpoint: GrantAnalysisEvaluationRunCheckpoint;
  attempts: number;
  successes: number;
  failures: number;
  skipped: number;
  databaseWriteMode: false;
}

export function grantAnalysisEvaluationRunFingerprint(options: {
  fingerprintInput: GrantAnalysisEvaluationRunFingerprintInput;
  grants: readonly GrantAnalysisEvaluationRunGrant[];
}): { fingerprint: string; grantsFingerprint: string } {
  validateRunInputs(options.fingerprintInput, options.grants);
  const grantsFingerprint = sha256(stableStringify(options.grants.map((grant) => ({
    grantKey: grant.grantKey,
    sourceRevision: grant.sourceRevision,
    inputOrder: [...grant.inputOrder],
    apiInputSha256: grant.apiInputSha256,
    attachmentInputSha256: grant.attachmentInputSha256,
    estimatedInputTokens: grant.estimatedInputTokens,
  }))));
  return {
    grantsFingerprint,
    fingerprint: sha256(stableStringify({
      fingerprintInput: options.fingerprintInput,
      grantsFingerprint,
    })),
  };
}

export function planGrantAnalysisEvaluationRun(options: {
  fingerprintInput: GrantAnalysisEvaluationRunFingerprintInput;
  grants: readonly GrantAnalysisEvaluationRunGrant[];
  costRates?: Partial<Record<GrantAnalysisEvaluationStage, GrantAnalysisEvaluationCostRate>>;
}): GrantAnalysisEvaluationRunPlan {
  const { fingerprint } = grantAnalysisEvaluationRunFingerprint(options);
  const callsByStage = emptyStageNumbers();
  const estimatedInputTokensByStage = emptyStageNumbers();
  for (const grant of options.grants) {
    callsByStage.extract_b += 1;
    callsByStage.extract_c += grant.apiInputSha256 === grant.attachmentInputSha256 ? 0 : 1;
    callsByStage.judge_1 += 1;
    callsByStage.judge_2 += 1;
    callsByStage.judge_3 += 1; // deterministic upper bound: every axis could disagree
    for (const stage of GRANT_ANALYSIS_EVALUATION_STAGES) {
      if (stage !== "extract_c" || grant.apiInputSha256 !== grant.attachmentInputSha256) {
        estimatedInputTokensByStage[stage] += grant.estimatedInputTokens[stage];
      }
    }
  }
  const estimatedCostByStage = Object.fromEntries(
    GRANT_ANALYSIS_EVALUATION_STAGES.map((stage) => {
      const rate = options.costRates?.[stage];
      if (!rate) return [stage, null];
      const cost = (estimatedInputTokensByStage[stage] / 1_000_000) * rate.inputPerMillion +
        (callsByStage[stage] * rate.estimatedOutputTokens / 1_000_000) * rate.outputPerMillion;
      return [stage, Math.round(cost * 1_000_000) / 1_000_000];
    }),
  ) as Record<GrantAnalysisEvaluationStage, number | null>;
  return {
    mode: "plan",
    fingerprint,
    grantCount: options.grants.length,
    maximumCalls: sum(Object.values(callsByStage)),
    callsByStage,
    estimatedInputTokensByStage,
    estimatedCostByStage,
    databaseWriteMode: false,
    externalCallsMade: 0,
  };
}

export async function runGrantAnalysisEvaluation(options: {
  mode: "plan" | "paid";
  confirmation?: string;
  maxCalls: number;
  fingerprintInput: GrantAnalysisEvaluationRunFingerprintInput;
  grants: readonly GrantAnalysisEvaluationRunGrant[];
  dependencies: GrantAnalysisEvaluationRunnerDependencies;
  costRates?: Partial<Record<GrantAnalysisEvaluationStage, GrantAnalysisEvaluationCostRate>>;
}): Promise<GrantAnalysisEvaluationRunPlan | GrantAnalysisEvaluationRunReceipt> {
  const plan = planGrantAnalysisEvaluationRun(options);
  if (options.mode === "plan") return plan;
  if (options.confirmation !== GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION) {
    throw new Error(
      `Paid mode requires confirmation ${GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION}.`,
    );
  }
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 0 ||
      options.maxCalls > GRANT_ANALYSIS_EVALUATION_ABSOLUTE_MAX_CALLS) {
    throw new Error(`maxCalls must be an integer between 0 and ${GRANT_ANALYSIS_EVALUATION_ABSOLUTE_MAX_CALLS}.`);
  }

  const ids = grantAnalysisEvaluationRunFingerprint(options);
  let checkpoint = await options.dependencies.checkpointStore.read();
  if (checkpoint) {
    assertReusableCheckpoint(checkpoint, options.fingerprintInput, ids, options.grants);
  } else {
    checkpoint = {
      recordType: "grant_analysis_evaluation_run_checkpoint",
      schemaVersion: 1,
      fingerprint: ids.fingerprint,
      fingerprintInput: clone(options.fingerprintInput),
      grantsFingerprint: ids.grantsFingerprint,
      grants: Object.fromEntries(options.grants.map((grant) => [grant.grantKey, {
        grantKey: grant.grantKey,
        sourceRevision: grant.sourceRevision,
        stages: {},
      }])),
      databaseWriteMode: false,
    };
    await options.dependencies.checkpointStore.write(checkpoint);
  }

  for (const grant of options.grants) {
    const grantCheckpoint = checkpoint.grants[grant.grantKey];
    if (!grantCheckpoint || grantCheckpoint.sourceRevision !== grant.sourceRevision) {
      throw new Error(`${grant.grantKey}: checkpoint grant identity/revision mismatch.`);
    }
    for (const stage of GRANT_ANALYSIS_EVALUATION_STAGES) {
      const existing = grantCheckpoint.stages[stage];
      if (existing?.status === "success" || existing?.status === "skipped") continue;
      if ((existing?.attempts ?? 0) >= 2) continue;

      if (stage === "extract_c" && grant.apiInputSha256 === grant.attachmentInputSha256) {
        const b = grantCheckpoint.stages.extract_b;
        if (b?.status !== "success") continue;
        grantCheckpoint.stages.extract_c = {
          status: "skipped",
          attempts: 0,
          result: b.result,
          reusedFrom: "extract_b",
        };
        await options.dependencies.checkpointStore.write(checkpoint);
        continue;
      }

      let eligibleAxes: readonly CriterionDimension[] = [];
      if (stage === "judge_3") {
        const judge1 = grantCheckpoint.stages.judge_1;
        const judge2 = grantCheckpoint.stages.judge_2;
        if (judge1?.status !== "success" || judge2?.status !== "success") continue;
        eligibleAxes = [...new Set(options.dependencies.judge3EligibleAxes({
          grant,
          judge1Result: judge1.result,
          judge2Result: judge2.result,
        }))];
        const invalidAxes = eligibleAxes.filter((axis) => !CRITERION_DIMENSIONS.includes(axis));
        if (invalidAxes.length > 0) {
          throw new Error(`Judge 3 eligibility returned unknown axes: ${invalidAxes.join(", ")}.`);
        }
        if (eligibleAxes.length === 0) {
          grantCheckpoint.stages.judge_3 = {
            status: "skipped",
            attempts: 0,
            result: { reason: "judge_1_2_agreement", eligibleAxes: [] },
            eligibleAxes: [],
          };
          await options.dependencies.checkpointStore.write(checkpoint);
          continue;
        }
      }

      if (countAttempts(checkpoint) >= options.maxCalls) {
        throw new Error(`maxCalls=${options.maxCalls} reached; refusing the next external call.`);
      }
      const attempt = (existing?.attempts ?? 0) + 1;
      grantCheckpoint.stages[stage] = {
        status: "running",
        attempts: attempt,
        ...(eligibleAxes.length > 0 ? { eligibleAxes } : {}),
      };
      // Persist before the call so interruption still consumes the attempt budget.
      await options.dependencies.checkpointStore.write(checkpoint);
      try {
        const result = await options.dependencies.executeStage({
          grant,
          stage,
          attempt,
          eligibleAxes,
          priorStages: grantCheckpoint.stages,
        });
        grantCheckpoint.stages[stage] = {
          status: "success",
          attempts: attempt,
          result,
          ...(eligibleAxes.length > 0 ? { eligibleAxes } : {}),
        };
      } catch (error) {
        grantCheckpoint.stages[stage] = {
          status: "failed",
          attempts: attempt,
          lastError: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
          ...(eligibleAxes.length > 0 ? { eligibleAxes } : {}),
        };
      }
      await options.dependencies.checkpointStore.write(checkpoint);
    }
  }

  const stages = Object.values(checkpoint.grants).flatMap((grant) => Object.values(grant.stages));
  return {
    mode: "paid",
    fingerprint: checkpoint.fingerprint,
    checkpoint,
    attempts: countAttempts(checkpoint),
    successes: stages.filter((stage) => stage?.status === "success").length,
    failures: stages.filter((stage) => stage?.status === "failed").length,
    skipped: stages.filter((stage) => stage?.status === "skipped").length,
    databaseWriteMode: false,
  };
}

function assertReusableCheckpoint(
  checkpoint: GrantAnalysisEvaluationRunCheckpoint,
  expectedInput: GrantAnalysisEvaluationRunFingerprintInput,
  expected: { fingerprint: string; grantsFingerprint: string },
  expectedGrants: readonly GrantAnalysisEvaluationRunGrant[],
): void {
  if (checkpoint.recordType !== "grant_analysis_evaluation_run_checkpoint" ||
      checkpoint.schemaVersion !== 1 || checkpoint.databaseWriteMode !== false) {
    throw new Error("Checkpoint contract mismatch; refusing reuse.");
  }
  if (checkpoint.fingerprint !== expected.fingerprint ||
      checkpoint.grantsFingerprint !== expected.grantsFingerprint ||
      stableStringify(checkpoint.fingerprintInput) !== stableStringify(expectedInput)) {
    throw new Error("Checkpoint fingerprint mismatch; refusing reuse.");
  }
  const expectedKeys = expectedGrants.map((grant) => grant.grantKey).sort();
  const checkpointKeys = Object.keys(checkpoint.grants).sort();
  if (stableStringify(checkpointKeys) !== stableStringify(expectedKeys)) {
    throw new Error("Checkpoint grant set mismatch; refusing reuse.");
  }
  for (const grant of expectedGrants) {
    const saved = checkpoint.grants[grant.grantKey];
    if (!saved || saved.grantKey !== grant.grantKey || saved.sourceRevision !== grant.sourceRevision) {
      throw new Error(`${grant.grantKey}: checkpoint grant identity/revision mismatch.`);
    }
    for (const stage of Object.values(saved.stages)) {
      if (!stage || !Number.isInteger(stage.attempts) || stage.attempts < 0 || stage.attempts > 2) {
        throw new Error(`${grant.grantKey}: invalid checkpoint stage attempt ledger.`);
      }
    }
  }
}

function validateRunInputs(
  input: GrantAnalysisEvaluationRunFingerprintInput,
  grants: readonly GrantAnalysisEvaluationRunGrant[],
): void {
  if (input.runVersion !== GRANT_ANALYSIS_EVALUATION_RUN_VERSION) {
    throw new Error(`runVersion must be ${GRANT_ANALYSIS_EVALUATION_RUN_VERSION}.`);
  }
  for (const [label, value] of Object.entries({
    manifestSha256: input.manifestSha256,
    inputLimitsSha256: input.inputLimitsSha256,
    converterVersion: input.converter.version,
    converterPolicy: input.converter.policySha256,
    extractorModel: input.extractor.model,
    extractorPrompt: input.extractor.promptSha256,
    extractorSchema: input.extractor.schemaSha256,
    judge1Model: input.judges.judge1.model,
    judge1Prompt: input.judges.judge1.promptSha256,
    judge1Schema: input.judges.judge1.schemaSha256,
    judge2Model: input.judges.judge2.model,
    judge2Prompt: input.judges.judge2.promptSha256,
    judge2Schema: input.judges.judge2.schemaSha256,
    judge3Model: input.judges.judge3.model,
    judge3Prompt: input.judges.judge3.promptSha256,
    judge3Schema: input.judges.judge3.schemaSha256,
  })) {
    if (!value.trim()) throw new Error(`${label} must be non-empty.`);
  }
  if (grants.length > 40) throw new Error("Evaluation runner accepts at most 40 grants.");
  const keys = new Set<string>();
  for (const grant of grants) {
    if (!grant.grantKey.trim() || !grant.sourceRevision.trim()) {
      throw new Error("Every evaluation grant requires grantKey and sourceRevision.");
    }
    if (keys.has(grant.grantKey)) throw new Error(`Duplicate evaluation grant: ${grant.grantKey}.`);
    keys.add(grant.grantKey);
    if (new Set(grant.inputOrder).size !== grant.inputOrder.length) {
      throw new Error(`${grant.grantKey}: inputOrder must not contain duplicates.`);
    }
    for (const stage of GRANT_ANALYSIS_EVALUATION_STAGES) {
      const tokens = grant.estimatedInputTokens[stage];
      if (!Number.isInteger(tokens) || tokens < 0) {
        throw new Error(`${grant.grantKey}:${stage}: estimatedInputTokens must be non-negative integers.`);
      }
    }
  }
}

function countAttempts(checkpoint: GrantAnalysisEvaluationRunCheckpoint): number {
  return sum(Object.values(checkpoint.grants).flatMap((grant) =>
    Object.values(grant.stages).map((stage) => stage?.attempts ?? 0)));
}

function emptyStageNumbers(): Record<GrantAnalysisEvaluationStage, number> {
  return { extract_b: 0, extract_c: 0, judge_1: 0, judge_2: 0, judge_3: 0 };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
