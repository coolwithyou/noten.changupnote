import assert from "node:assert/strict";
import test from "node:test";
import type { GrantReadinessInput } from "./grantReadiness";
import {
  createGrantNextWorkSnapshot,
  executeGrantNextWork,
  type GrantNextWorkAdapter,
  type GrantNextWorkSnapshot,
} from "./grantNextWorkExecution";

const GRANT_ID = "10000000-0000-4000-8000-000000000001";
const REVISION = "a".repeat(64);
const RAW = "b".repeat(64);

function readinessInput(input: {
  questionPresent?: boolean;
  analysisPresent?: boolean;
} = {}): GrantReadinessInput {
  const analysisPresent = input.analysisPresent ?? true;
  return {
    grantId: GRANT_ID,
    source: {
      availability: "available",
      revisionSha256: REVISION,
      rawSha256: RAW,
      attachmentStatus: "not_required",
      attachmentManifestSha256: null,
    },
    analysis: analysisPresent ? {
      status: "present",
      sourceRevisionSha256: REVISION,
      sourceRawSha256: RAW,
      attachmentManifestSha256: null,
      structure: "complete",
      criteriaReview: "reviewed",
      eligibleQuestionCriterionStableKeys: ["criterion:location"],
    } : {
      status: "missing",
      sourceRevisionSha256: null,
      sourceRawSha256: null,
      attachmentManifestSha256: null,
      structure: "incomplete",
      criteriaReview: "incomplete",
      eligibleQuestionCriterionStableKeys: [],
    },
    questions: input.questionPresent ? [{
      criterionStableKey: "criterion:location",
      evaluationContractVersion: "confirmation-evaluation-v2",
      reviewed: true,
      invalidated: false,
      sourceRevisionSha256: REVISION,
      sourceRawSha256: RAW,
    }] : [],
  };
}

function snapshot(questionPresent = false): GrantNextWorkSnapshot {
  return createGrantNextWorkSnapshot({
    grantId: GRANT_ID,
    readinessInput: readinessInput({ questionPresent }),
  });
}

function adapter(execute: GrantNextWorkAdapter["execute"]): GrantNextWorkAdapter {
  return { action: "question_preparation", execute };
}

test("exact snapshot이 바뀌면 adapter를 호출하지 않는다", async () => {
  let calls = 0;
  const current = snapshot();
  await assert.rejects(() => executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: "f".repeat(64),
    loadSnapshot: async () => current,
    adapters: new Map([["question_preparation", adapter(async () => {
      calls += 1;
      throw new Error("호출되면 안 됩니다");
    })]]),
  }), /grant_next_work_snapshot_drift/u);
  assert.equal(calls, 0);
});

test("snapshot 내부 readiness 입력이 hash 생성 뒤 바뀌면 adapter 전에 거부한다", async () => {
  const current = snapshot();
  const tampered = {
    ...current,
    readinessInput: {
      ...current.readinessInput,
      analysis: {
        ...current.readinessInput.analysis,
        eligibleQuestionCriterionStableKeys: ["criterion:tampered"],
      },
    },
  };
  await assert.rejects(() => executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: current.evidenceSha256,
    loadSnapshot: async () => tampered,
    adapters: new Map(),
  }), /grant_next_work_snapshot_integrity_invalid/u);
});

test("다른 raw revision의 변경 영향 영수증으로 실행 snapshot을 만들지 않는다", () => {
  assert.throws(() => createGrantNextWorkSnapshot({
    grantId: GRANT_ID,
    readinessInput: readinessInput(),
    sourceChangeImpact: {
      schema: "grant-source-change-impact-v2",
      classification: "evidence_refresh",
      changedDomains: ["raw"],
      previousRawSha256: "c".repeat(64),
      currentRawSha256: "d".repeat(64),
      requiresModelRun: false,
    },
  }), /grant_next_work_source_impact_drift/u);
});

test("모델 실행 작업과 미등록 작업은 관측 가능한 blocked로 닫는다", async () => {
  const model = createGrantNextWorkSnapshot({
    grantId: GRANT_ID,
    readinessInput: readinessInput({ analysisPresent: false }),
  });
  const modelResult = await executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: model.evidenceSha256,
    loadSnapshot: async () => model,
    adapters: new Map(),
  });
  assert.equal(modelResult.status, "blocked");
  assert.equal(modelResult.reason, "model_run_requires_separate_authority");
  assert.equal(modelResult.modelCalls, 0);

  const missing = snapshot();
  const missingResult = await executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: missing.evidenceSha256,
    loadSnapshot: async () => missing,
    adapters: new Map(),
  });
  assert.equal(missingResult.status, "blocked");
  assert.equal(missingResult.reason, "next_work_adapter_unavailable");
});

test("adapter 처리 뒤 readiness가 다음 작업으로 이동해야 완료한다", async () => {
  const before = snapshot(false);
  const after = snapshot(true);
  let loadCount = 0;
  const actual = await executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: before.evidenceSha256,
    loadSnapshot: async () => loadCount++ === 0 ? before : after,
    adapters: new Map([["question_preparation", adapter(async (input) => {
      assert.equal(input.expectedEvidenceSha256, before.evidenceSha256);
      return {
        action: "question_preparation",
        receiptSha256: "c".repeat(64),
        modelCalls: 0,
        externalWrites: 1,
      };
    })]]),
  });
  assert.equal(actual.status, "completed");
  assert.equal(actual.action, "question_preparation");
  assert.equal(actual.nextAction, "reuse_ready");
  assert.equal(actual.adapterReceiptSha256, "c".repeat(64));
  assert.equal(actual.externalWrites, 1);
});

test("모델 불필요 adapter의 모델 호출과 진전 없는 처리를 완료로 가장하지 않는다", async () => {
  const current = snapshot();
  await assert.rejects(() => executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: current.evidenceSha256,
    loadSnapshot: async () => current,
    adapters: new Map([["question_preparation", adapter(async () => ({
      action: "question_preparation",
      receiptSha256: "d".repeat(64),
      modelCalls: 1,
      externalWrites: 0,
    }))]]),
  }), /grant_next_work_unexpected_model_call/u);

  const stalled = await executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: current.evidenceSha256,
    loadSnapshot: async () => current,
    adapters: new Map([["question_preparation", adapter(async () => ({
      action: "question_preparation",
      receiptSha256: "e".repeat(64),
      modelCalls: 0,
      externalWrites: 0,
    }))]]),
  });
  assert.equal(stalled.status, "stalled");
  assert.equal(stalled.reason, "readiness_did_not_advance");
});

test("같은 작업 안의 진전과 준비도 회귀를 완료와 구분한다", async () => {
  const before = snapshot();
  const partialBase = readinessInput();
  const partialInput: GrantReadinessInput = {
    ...partialBase,
    questions: [...partialBase.questions, {
    criterionStableKey: "criterion:location",
    evaluationContractVersion: null,
    reviewed: false,
    invalidated: false,
    sourceRevisionSha256: REVISION,
    sourceRawSha256: RAW,
    }],
  };
  const partial = createGrantNextWorkSnapshot({ grantId: GRANT_ID, readinessInput: partialInput });
  let partialLoads = 0;
  const partialResult = await executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: before.evidenceSha256,
    loadSnapshot: async () => partialLoads++ === 0 ? before : partial,
    adapters: new Map([["question_preparation", adapter(async () => ({
      action: "question_preparation",
      receiptSha256: "1".repeat(64),
      modelCalls: 0,
      externalWrites: 1,
    }))]]),
  });
  assert.equal(partialResult.status, "partial");
  assert.equal(partialResult.nextAction, "question_preparation");

  const regressed = createGrantNextWorkSnapshot({
    grantId: GRANT_ID,
    readinessInput: readinessInput({ analysisPresent: false }),
  });
  let regressedLoads = 0;
  const regressedResult = await executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: before.evidenceSha256,
    loadSnapshot: async () => regressedLoads++ === 0 ? before : regressed,
    adapters: new Map([["question_preparation", adapter(async () => ({
      action: "question_preparation",
      receiptSha256: "2".repeat(64),
      modelCalls: 0,
      externalWrites: 1,
    }))]]),
  });
  assert.equal(regressedResult.status, "regressed");
  assert.equal(regressedResult.reason, "readiness_regressed");
});

test("이미 준비된 공고는 adapter 없이 멱등 완료한다", async () => {
  const ready = snapshot(true);
  const actual = await executeGrantNextWork({
    grantId: GRANT_ID,
    expectedEvidenceSha256: ready.evidenceSha256,
    loadSnapshot: async () => ready,
    adapters: new Map(),
  });
  assert.equal(actual.status, "already_complete");
  assert.equal(actual.nextAction, "reuse_ready");
  assert.equal(actual.externalWrites, 0);
});

console.log("grant next work execution: exact admission, model boundary, and post-readiness verification passed");
