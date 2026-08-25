import assert from "node:assert/strict";
import type { LabRun } from "./lab-contract";
import {
  classifyAuthoringGuideAdoptionCandidate,
  createAuthoringGuideAdoptionManifest,
  hashAuthoringGuideAdoptionManifest,
  isExplicitAuthoringGuideAdoptionRun,
  type AuthoringGuideAdoptionCandidate,
} from "./authoring-guide-adoption";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

const run = {
  runId: "run-2026-08-25T000000.000Z-ab12cd",
  grantId: "00000000-0000-4000-8000-000000000001",
  source: "bizinfo",
  sourceId: "source-1",
  title: "테스트 공고",
  model: "claude-opus-4-1",
  promptVersion: "test-v1",
  startedAt: "2026-08-25T00:00:00.000Z",
  durationMs: 1,
  inputBlocks: [],
  inputTotalChars: 1,
  inputSha256: A,
  attachmentManifestSha256: B,
  usage: null,
  costUsd: null,
  analysisMarkdown: "분석",
  programIntent: {
    oneLiner: "목적",
    targetProfile: "대상",
    evaluationFocus: ["평가"],
    benefitSummary: "혜택",
    cautionNotes: ["주의"],
  },
  criteria: [{
    dimension: "region",
    kind: "required",
    operator: "in",
    value: ["서울"],
    confidence: 0.9,
    sourceSpan: "서울 소재 기업",
    spanVerified: true,
    note: null,
  }],
  axisAssessments: [],
  taxonomyProposals: [],
  dimensionDiffs: [],
  primaryValidationOutcome: "publishable",
  matchingReadiness: "ready",
  error: null,
} as LabRun;

function candidate(overrides: Partial<AuthoringGuideAdoptionCandidate> = {}): AuthoringGuideAdoptionCandidate {
  return {
    grantId: run.grantId,
    source: run.source,
    sourceId: run.sourceId,
    title: run.title,
    run,
    runArtifactPath: "spike-out/analysis-lab/bizinfo__source-1/run.json",
    runArtifactSha256: D,
    current: {
      inputSha256: A,
      attachmentManifestSha256: B,
      sourceRevisionSha256: C,
      sourceSealed: true,
      operationalInputSha256: A,
      operationalAttachmentManifestSha256: B,
      sourceBlockers: [],
    },
    ...overrides,
  };
}

const ready = classifyAuthoringGuideAdoptionCandidate(candidate());
assert.equal(ready.disposition, "projection_ready");
assert.deepEqual(ready.reasons, []);
assert.equal(ready.requiresReleaseValidation, true);
assert.equal(ready.advisoryPreviewOnly, true);
assert.equal(ready.authoringGuidePreview?.source.sourceRevisionSha256, C);
assert.equal(run.sourceRevisionSha256, undefined, "historical run은 수정하지 않아야 한다");
assert.equal(isExplicitAuthoringGuideAdoptionRun(run), true);
assert.equal(isExplicitAuthoringGuideAdoptionRun({ error: null }), false, "구형 호환 런은 제외한다");

const inputDrift = classifyAuthoringGuideAdoptionCandidate(candidate({
  current: {
    inputSha256: D,
    attachmentManifestSha256: B,
    sourceRevisionSha256: C,
    sourceSealed: true,
    operationalInputSha256: D,
    operationalAttachmentManifestSha256: B,
    sourceBlockers: [],
  },
}));
assert.equal(inputDrift.disposition, "rerun_required");
assert.ok(inputDrift.reasons.includes("input_sha256_drift"));
assert.equal(inputDrift.authoringGuidePreview, null);

const attachmentDrift = classifyAuthoringGuideAdoptionCandidate(candidate({
  current: {
    inputSha256: A,
    attachmentManifestSha256: D,
    sourceRevisionSha256: C,
    sourceSealed: true,
    operationalInputSha256: A,
    operationalAttachmentManifestSha256: D,
    sourceBlockers: [],
  },
}));
assert.equal(attachmentDrift.disposition, "rerun_required");
assert.ok(attachmentDrift.reasons.includes("attachment_manifest_sha256_drift"));

const sourceRecovery = classifyAuthoringGuideAdoptionCandidate(candidate({
  current: {
    inputSha256: A,
    attachmentManifestSha256: B,
    sourceRevisionSha256: C,
    sourceSealed: false,
    operationalInputSha256: A,
    operationalAttachmentManifestSha256: B,
    sourceBlockers: [{
      code: "blocked_conversion",
      attachmentId: "attachment-1",
      message: "첨부 텍스트 변환 필요",
    }],
  },
}));
assert.equal(sourceRecovery.disposition, "source_recovery_required");
assert.deepEqual(sourceRecovery.reasons, ["current_source_unsealed"]);
assert.equal(sourceRecovery.authoringGuidePreview, null);

const missingCriteriaRun = { ...run, criteria: [] };
const review = classifyAuthoringGuideAdoptionCandidate(candidate({ run: missingCriteriaRun }));
assert.equal(review.disposition, "review_required");
assert.deepEqual(review.reasons, ["criteria_missing"]);
assert.equal(review.authoringGuidePreview?.evidenceChecklist.length, 0);

const missingIntent = classifyAuthoringGuideAdoptionCandidate(candidate({
  run: { ...run, programIntent: null },
}));
assert.equal(missingIntent.disposition, "rerun_required");
assert.ok(missingIntent.reasons.includes("program_intent_missing"));

const manifest = createAuthoringGuideAdoptionManifest({
  preparedAt: new Date("2026-08-25T01:00:00.000Z"),
  asOfKst: "2026-08-25",
  strictEligibleGrantCount: 559,
  candidates: [candidate(), candidate({
    grantId: "00000000-0000-4000-8000-000000000002",
    run: { ...run, grantId: "00000000-0000-4000-8000-000000000002", criteria: [] },
  })],
});
assert.deepEqual(manifest.summary, {
  projectionReady: 1,
  reviewRequired: 1,
  sourceRecoveryRequired: 0,
  rerunRequired: 0,
});
assert.equal(manifest.execution.modelCallsMade, 0);
assert.equal(manifest.execution.databaseWritesMade, 0);
assert.equal(manifest.execution.promotionAuthorized, false);
assert.equal(hashAuthoringGuideAdoptionManifest(manifest), hashAuthoringGuideAdoptionManifest(manifest));

console.log("authoring-guide-adoption tests passed");
