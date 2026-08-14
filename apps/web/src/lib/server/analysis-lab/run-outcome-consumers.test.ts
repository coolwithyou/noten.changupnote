import assert from "node:assert/strict";
import type { LabAudit, LabReview, LabRun } from "@/features/dev/analysis-lab/contract";
import { runAiAdjudication } from "./ai-adjudication";
import { runAiAudit } from "./ai-audit";
import { runAiReview } from "./ai-review";
import { runConfirmations } from "./confirmations";
import { dedupeReviewedRuns } from "./reviewed-runs";

function heldRun(): LabRun {
  return {
    runId: "run-2026-08-14T000000.000Z-a0b0c0",
    grantId: "held-grant",
    source: "bizinfo",
    sourceId: "HELD_1",
    title: "보류 공고",
    model: "extractor-model",
    transport: "claude-cli",
    promptVersion: "lab-deep-v17",
    startedAt: "2026-08-14T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: "0".repeat(64),
    usage: null,
    costUsd: 0,
    analysisMarkdown: "보류 분석",
    programIntent: null,
    criteria: [],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    primaryValidationOutcome: "held",
    error: null,
  };
}

await assert.rejects(
  runAiReview({
    run: heldRun(),
    model: "review-model",
    apiKey: "test",
    fetchImpl: async () => {
      throw new Error("held 검수에서 모델 호출 금지");
    },
  }),
  /발행 가능한 런이 아닙니다/,
);

console.log("✅ outcome consumer — held 런 AI 검수 fail-closed");

const emptyAudit: LabAudit = {
  schema: "lab-audit-v1",
  grantId: "held-grant",
  runId: "run-2026-08-14T000000.000Z-a0b0c0",
  model: "review-model",
  aiPromptVersion: "ai-review-v7",
  auditorEmail: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  items: [],
  overallNote: null,
};

await assert.rejects(
  runAiAudit({
    run: heldRun(),
    audit: emptyAudit,
    auditModel: "audit-model",
    apiKey: "test",
  }),
  /발행 가능한 런이 아닙니다/,
);

console.log("✅ outcome consumer — held 런 AI 감사 fail-closed");

await assert.rejects(
  runAiAdjudication({
    run: heldRun(),
    audit: emptyAudit,
    model: "adjudication-model",
    apiKey: "test",
    transport: "claude-cli",
  }),
  /발행 가능한 런이 아닙니다/,
);

console.log("✅ outcome consumer — held 런 3차 판정 fail-closed");

const emptyReview: LabReview = {
  grantId: "held-grant",
  runId: "run-2026-08-14T000000.000Z-a0b0c0",
  reviewerEmail: "sw@noten.im",
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  criterionReviews: [],
  axisReviews: [],
  overallNote: null,
};

await assert.rejects(
  runConfirmations({
    run: heldRun(),
    review: emptyReview,
    model: "confirmation-model",
    apiKey: "test",
    sidecarPath: "/tmp/held-run-confirmations-should-not-exist.json",
  }),
  /발행 가능한 런이 아닙니다/,
);

console.log("✅ outcome consumer — held 런 확정 질문 fail-closed");

const originalWarn = console.warn;
console.warn = () => {};
try {
  assert.deepEqual(
    dedupeReviewedRuns([{ run: heldRun(), review: emptyReview }]),
    [],
    "held 검수 파일이 있어도 확정 검수 집계에서 제외한다",
  );
} finally {
  console.warn = originalWarn;
}

console.log("✅ outcome consumer — held 런 검수 집계 제외");
