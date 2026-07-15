import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CriterionDimension } from "@cunote/contracts";
import {
  FROZEN_GRANT_ANALYSIS_PILOT_COHORT,
  frozenGrantAnalysisPilotKey,
  type FrozenGrantAnalysisPilotEntry,
} from "../ingestion/grantAnalysisPilotCohort";
import {
  GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  GRANT_ANALYSIS_EVALUATION_RUN_VERSION,
  grantAnalysisEvaluationRunFingerprint,
  planGrantAnalysisEvaluationRun,
  runGrantAnalysisEvaluation,
  type GrantAnalysisEvaluationCheckpointStore,
  type GrantAnalysisEvaluationRunCheckpoint,
  type GrantAnalysisEvaluationRunFingerprintInput,
  type GrantAnalysisEvaluationRunGrant,
  type GrantAnalysisEvaluationStageContext,
} from "./run-grant-analysis-evaluation";

// Minimal, network-free input shapes bound to three legacy pilot entries. No
// sealed 40-grant identity is used here.
const frozen = {
  attachmentFailure: frozenEntry("kstartup_attachment_failure"),
  attachmentComplete: frozenEntry("unstructured_attachment_complete"),
  structuredControl: frozenEntry("structured_control"),
};
const grantKeys = {
  attachmentFailure: frozenGrantAnalysisPilotKey(frozen.attachmentFailure),
  attachmentComplete: frozenGrantAnalysisPilotKey(frozen.attachmentComplete),
  structuredControl: frozenGrantAnalysisPilotKey(frozen.structuredControl),
};
const grants: GrantAnalysisEvaluationRunGrant[] = [
  grant(frozen.attachmentFailure, "api-sparse", "api-sparse"),
  grant(frozen.attachmentComplete, "api-attachment", "api-plus-attachment"),
  grant(frozen.structuredControl, "api-control", "api-control"),
];
assert.deepEqual(
  grants.map(({ grantKey, sourceRevision }) => [grantKey, sourceRevision]),
  Object.values(frozen).map((entry) => [frozenGrantAnalysisPilotKey(entry), entry.sourceRevision]),
);
const fingerprintInput = config();

const plan = planGrantAnalysisEvaluationRun({ fingerprintInput, grants });
assert.equal(plan.mode, "plan");
assert.equal(plan.grantCount, 3);
assert.deepEqual(plan.callsByStage, {
  extract_b: 3,
  extract_c: 1,
  judge_1: 3,
  judge_2: 3,
  judge_3: 3,
});
assert.equal(plan.maximumCalls, 13);
assert.equal(plan.externalCallsMade, 0);
assert.equal(plan.databaseWriteMode, false);

let calls: GrantAnalysisEvaluationStageContext[] = [];
const guardStore = memoryStore();
await assert.rejects(
  () => runGrantAnalysisEvaluation({
    mode: "paid",
    confirmation: "wrong",
    maxCalls: 20,
    fingerprintInput,
    grants,
    dependencies: dependencies(guardStore, calls),
  }),
  /Paid mode requires confirmation/,
);
assert.equal(calls.length, 0);
assert.equal(await guardStore.read(), null);

const store = memoryStore();
let attachmentCFailures = 0;
const injected = dependencies(store, calls, async (context) => {
  if (context.grant.grantKey === grantKeys.attachmentComplete &&
      context.stage === "extract_c" && attachmentCFailures++ === 0) {
    throw new Error("fixture converter/provider failure");
  }
  return { stage: context.stage, grantKey: context.grant.grantKey, attempt: context.attempt };
});
const first = await runGrantAnalysisEvaluation({
  mode: "paid",
  confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  maxCalls: 20,
  fingerprintInput,
  grants,
  dependencies: injected,
});
assert.equal(first.mode, "paid");
if (first.mode !== "paid") throw new Error("expected paid receipt");
assert.equal(first.checkpoint.grants[grantKeys.attachmentComplete]?.stages.extract_b?.status, "success");
assert.equal(first.checkpoint.grants[grantKeys.attachmentComplete]?.stages.extract_c?.status, "failed");
assert.equal(first.checkpoint.grants[grantKeys.attachmentComplete]?.stages.extract_c?.attempts, 1);
assert.equal(first.checkpoint.grants[grantKeys.attachmentFailure]?.stages.extract_c?.reusedFrom, "extract_b");
assert.equal(first.checkpoint.grants[grantKeys.attachmentFailure]?.stages.judge_3?.status, "skipped");
assert.equal(first.checkpoint.grants[grantKeys.structuredControl]?.stages.judge_3?.status, "success");
assert.deepEqual(first.checkpoint.grants[grantKeys.structuredControl]?.stages.judge_3?.eligibleAxes, ["industry"]);
assert.equal(calls.filter((call) => call.stage === "judge_3").length, 1);

const callsBeforeResume = calls.length;
const second = await runGrantAnalysisEvaluation({
  mode: "paid",
  confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  maxCalls: 20,
  fingerprintInput,
  grants,
  dependencies: injected,
});
assert.equal(second.mode, "paid");
if (second.mode !== "paid") throw new Error("expected paid receipt");
assert.equal(calls.length, callsBeforeResume + 1, "resume retries only the failed C stage");
assert.equal(second.checkpoint.grants[grantKeys.attachmentComplete]?.stages.extract_c?.status, "success");
assert.equal(second.checkpoint.grants[grantKeys.attachmentComplete]?.stages.extract_c?.attempts, 2);
assert.equal(second.checkpoint.grants[grantKeys.attachmentComplete]?.stages.extract_b?.attempts, 1);

const dynamicJudge3SchemaSha256 = createHash("sha256").update("judge3-industry-subset-schema").digest("hex");
const dynamicStore = memoryStore();
const dynamicCalls: GrantAnalysisEvaluationStageContext[] = [];
const dynamicDependencies = dependencies(dynamicStore, dynamicCalls);
const dynamicReceipt = await runGrantAnalysisEvaluation({
  mode: "paid",
  confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  maxCalls: 20,
  fingerprintInput,
  grants,
  dependencies: {
    ...dynamicDependencies,
    stageOutputSchemaSha256({ stage }) {
      return stage === "judge_3"
        ? dynamicJudge3SchemaSha256
        : fingerprintInput.stages[stage].schemaSha256;
    },
  },
});
assert.equal(dynamicReceipt.mode, "paid");
if (dynamicReceipt.mode !== "paid") throw new Error("expected paid receipt");
assert.equal(
  dynamicReceipt.checkpoint.grants[grantKeys.structuredControl]?.stages.judge_3?.outputSchemaSha256,
  dynamicJudge3SchemaSha256,
);
assert.equal(
  dynamicCalls.find((call) => call.stage === "judge_3")?.reservation.outputSchemaSha256,
  dynamicJudge3SchemaSha256,
  "exact dynamic Judge 3 subset schema hash is persisted before executeStage",
);

const beforeMismatch = calls.length;
for (const changedConfig of [
  {
    ...fingerprintInput,
    converter: { ...fingerprintInput.converter, version: "converter-drift" },
  },
  {
    ...fingerprintInput,
    provider: { ...fingerprintInput.provider, apiVersion: "provider-api-drift" },
  },
  {
    ...fingerprintInput,
    responseNormalizerVersion: "normalizer-drift",
  },
  {
    ...fingerprintInput,
    stages: {
      ...fingerprintInput.stages,
      judge_1: { ...fingerprintInput.stages.judge_1, maxOutputTokens: 101 },
    },
  },
]) {
  await assert.rejects(() => runGrantAnalysisEvaluation({
    mode: "paid",
    confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
    maxCalls: 20,
    fingerprintInput: changedConfig,
    grants,
    dependencies: injected,
  }), /Checkpoint fingerprint mismatch/);
}
const changedGrants = grants.map((entry, index) => index === 0 ? {
  ...entry,
  packetSha256: {
    ...entry.packetSha256,
    extract_b: createHash("sha256").update("packet-drift").digest("hex"),
  },
} : entry);
await assert.rejects(() => runGrantAnalysisEvaluation({
  mode: "paid",
  confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  maxCalls: 20,
  fingerprintInput,
  grants: changedGrants,
  dependencies: injected,
}), /Checkpoint fingerprint mismatch/);
assert.equal(calls.length, beforeMismatch);

const cappedStore = memoryStore();
const cappedCalls: GrantAnalysisEvaluationStageContext[] = [];
const cappedConfig = { ...fingerprintInput, retry: { ...fingerprintInput.retry, maxCalls: 0 } };
await assert.rejects(
  () => runGrantAnalysisEvaluation({
    mode: "paid",
    confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
    maxCalls: 0,
    fingerprintInput: cappedConfig,
    grants,
    dependencies: dependencies(cappedStore, cappedCalls),
  }),
  /maxCalls=0 reached/,
);
assert.equal(cappedCalls.length, 0);

const runningStore = memoryStore();
const interrupted = initialCheckpoint(fingerprintInput, grants);
interrupted.grants[grantKeys.attachmentFailure]!.stages.extract_b = {
  status: "running",
  attempts: 2,
  reservationId: createHash("sha256").update("interrupted-reservation").digest("hex"),
  packetSha256: grants[0]!.packetSha256.extract_b,
  outputSchemaSha256: fingerprintInput.stages.extract_b.schemaSha256,
};
await runningStore.write(interrupted);
const interruptedCalls: GrantAnalysisEvaluationStageContext[] = [];
const recovered = await runGrantAnalysisEvaluation({
  mode: "paid",
  confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  maxCalls: 20,
  fingerprintInput,
  grants,
  dependencies: dependencies(runningStore, interruptedCalls),
});
assert.equal(recovered.mode, "paid");
if (recovered.mode !== "paid") throw new Error("expected paid receipt");
assert.equal(
  interruptedCalls.some((call) => call.grant.grantKey === grantKeys.attachmentFailure && call.stage === "extract_b"),
  false,
  "two recorded attempts fail closed instead of making a third call",
);

console.log("run-grant-analysis-evaluation.test.ts: all assertions passed");

function frozenEntry(stratum: string): FrozenGrantAnalysisPilotEntry {
  const entry = FROZEN_GRANT_ANALYSIS_PILOT_COHORT.find((candidate) => candidate.stratum === stratum);
  assert.ok(entry, `missing frozen pilot fixture for ${stratum}`);
  return entry;
}

function grant(
  entry: FrozenGrantAnalysisPilotEntry,
  apiInputSha256: string,
  attachmentInputSha256: string,
): GrantAnalysisEvaluationRunGrant {
  const apiHash = createHash("sha256").update(apiInputSha256).digest("hex");
  const attachmentHash = createHash("sha256").update(attachmentInputSha256).digest("hex");
  return {
    grantKey: frozenGrantAnalysisPilotKey(entry),
    sourceRevision: entry.sourceRevision,
    inputOrderByStage: {
      extract_b: ["api#paragraph:p1"],
      extract_c: ["api#paragraph:p1", ...(apiHash === attachmentHash ? [] : ["attachment#page:1"])],
      judge_1: ["api#paragraph:p1"],
      judge_2: ["api#paragraph:p1"],
      judge_3: ["api#paragraph:p1"],
    },
    packetSha256: Object.fromEntries([
      "extract_b", "extract_c", "judge_1", "judge_2", "judge_3",
    ].map((stage) => [stage, createHash("sha256").update(`${entry.sourceId}:${stage}`).digest("hex")])) as GrantAnalysisEvaluationRunGrant["packetSha256"],
    apiInputSha256: apiHash,
    attachmentInputSha256: attachmentHash,
    judgeInputSha256: createHash("sha256").update("judge-input").digest("hex"),
    estimatedInputTokens: {
      extract_b: 100,
      extract_c: 150,
      judge_1: 160,
      judge_2: 160,
      judge_3: 80,
    },
  };
}

function config(): GrantAnalysisEvaluationRunFingerprintInput {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const stages = Object.fromEntries([
    "extract_b", "extract_c", "judge_1", "judge_2", "judge_3",
  ].map((stage) => [stage, {
    model: "assigned-model",
    maxOutputTokens: 100,
    promptSha256: hash(`${stage}-prompt`),
    schemaSha256: hash(`${stage}-schema`),
  }])) as GrantAnalysisEvaluationRunFingerprintInput["stages"];
  return {
    runVersion: GRANT_ANALYSIS_EVALUATION_RUN_VERSION,
    manifestSha256: hash("manifest-sha"),
    inputLimitsSha256: hash("limits-sha"),
    converter: { version: "converter-v1", policySha256: hash("converter-policy-sha") },
    provider: {
      boundaryVersion: "boundary-v1",
      apiVersion: "2023-06-01",
      endpoint: "https://api.anthropic.com/v1/messages",
      effort: "high",
      thinkingPolicy: "adaptive",
      stopPolicy: "end-turn-only",
    },
    responseNormalizerVersion: "normalizer-v1",
    groundingVersion: "grounding-v1",
    stages,
    judge3SchemaFactorySha256: hash("judge3-factory-sha"),
    modelAccessReceiptSha256: hash("model-access-sha"),
    modelAccess: { "assigned-model": true },
    retry: { maxAttemptsPerStage: 2, maxCalls: 20, globalAbsoluteCap: 200 },
  };
}

function dependencies(
  checkpointStore: GrantAnalysisEvaluationCheckpointStore,
  seen: GrantAnalysisEvaluationStageContext[],
  execute: (context: GrantAnalysisEvaluationStageContext) => Promise<unknown> = async (context) => ({ stage: context.stage }),
) {
  return {
    checkpointStore,
    async executeStage(context: GrantAnalysisEvaluationStageContext) {
      seen.push(context);
      return execute(context);
    },
    judge3EligibleAxes({ grant }: { grant: GrantAnalysisEvaluationRunGrant }): readonly CriterionDimension[] {
      return grant.grantKey === grantKeys.structuredControl ? ["industry"] : [];
    },
    stagePacketSha256({ grant, stage }: { grant: GrantAnalysisEvaluationRunGrant; stage: keyof GrantAnalysisEvaluationRunGrant["packetSha256"] }) {
      return grant.packetSha256[stage];
    },
    stageOutputSchemaSha256({ stage }: { stage: keyof GrantAnalysisEvaluationRunFingerprintInput["stages"] }) {
      return fingerprintInput.stages[stage].schemaSha256;
    },
  };
}

function memoryStore(): GrantAnalysisEvaluationCheckpointStore {
  let value: GrantAnalysisEvaluationRunCheckpoint | null = null;
  return {
    async read() {
      return value ? structuredClone(value) : null;
    },
    async write(checkpoint) {
      value = structuredClone(checkpoint);
    },
  };
}

function initialCheckpoint(
  input: GrantAnalysisEvaluationRunFingerprintInput,
  runGrants: GrantAnalysisEvaluationRunGrant[],
): GrantAnalysisEvaluationRunCheckpoint {
  const { fingerprint, grantsFingerprint } = grantAnalysisEvaluationRunFingerprint({
    fingerprintInput: input,
    grants: runGrants,
  });
  return {
    recordType: "grant_analysis_evaluation_run_checkpoint",
    schemaVersion: 1,
    fingerprint,
    fingerprintInput: structuredClone(input),
    grantsFingerprint,
    grants: Object.fromEntries(runGrants.map((entry) => [entry.grantKey, {
      grantKey: entry.grantKey,
      sourceRevision: entry.sourceRevision,
      stages: {},
    }])),
    databaseWriteMode: false,
  };
}
