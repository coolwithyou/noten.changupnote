import assert from "node:assert/strict";
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

const beforeMismatch = calls.length;
await assert.rejects(
  () => runGrantAnalysisEvaluation({
    mode: "paid",
    confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
    maxCalls: 20,
    fingerprintInput: {
      ...fingerprintInput,
      converter: { ...fingerprintInput.converter, version: "converter-drift" },
    },
    grants,
    dependencies: injected,
  }),
  /Checkpoint fingerprint mismatch/,
);
assert.equal(calls.length, beforeMismatch);

const cappedStore = memoryStore();
const cappedCalls: GrantAnalysisEvaluationStageContext[] = [];
await assert.rejects(
  () => runGrantAnalysisEvaluation({
    mode: "paid",
    confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
    maxCalls: 0,
    fingerprintInput,
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
  return {
    grantKey: frozenGrantAnalysisPilotKey(entry),
    sourceRevision: entry.sourceRevision,
    inputOrder: ["api#paragraph:p1", ...(apiInputSha256 === attachmentInputSha256 ? [] : ["attachment#page:1"])],
    apiInputSha256,
    attachmentInputSha256,
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
  return {
    runVersion: GRANT_ANALYSIS_EVALUATION_RUN_VERSION,
    manifestSha256: "manifest-sha",
    inputLimitsSha256: "limits-sha",
    converter: { version: "converter-v1", policySha256: "converter-policy-sha" },
    extractor: { model: "extractor-model", promptSha256: "extractor-prompt", schemaSha256: "extractor-schema" },
    judges: {
      judge1: { model: "judge-model-1", promptSha256: "judge-prompt-1", schemaSha256: "judge-schema-1" },
      judge2: { model: "judge-model-2", promptSha256: "judge-prompt-2", schemaSha256: "judge-schema-2" },
      judge3: { model: "judge-model-3", promptSha256: "judge-prompt-3", schemaSha256: "judge-schema-3" },
    },
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
