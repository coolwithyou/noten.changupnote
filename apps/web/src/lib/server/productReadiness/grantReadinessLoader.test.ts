import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGrantReadinessReport,
  isCurrentKstApplicationWindow,
  normalizeGrantReadinessEvidence,
  selectUniqueLatestPromotionRows,
  type GrantReadinessEvidenceRow,
} from "./grantReadinessLoader";
import { classifyGrantReadiness } from "./grantReadiness";

const revision = "a".repeat(64);
const raw = "b".repeat(64);
const attachments = "c".repeat(64);

function fixture(overrides: Partial<GrantReadinessEvidenceRow> = {}): GrantReadinessEvidenceRow {
  const grant = {
    id: "grant-fixture",
    status: "open",
    servingState: "visible",
    applyStart: new Date("2026-09-20T00:00:00+09:00"),
    applyEnd: new Date("2026-09-22T23:59:59+09:00"),
    ...overrides.grant,
  };
  const source = {
    rawRowPresent: true,
    rawSha256: raw,
    collectedAt: new Date("2026-09-21T08:00:00Z"),
    hasAttachments: true,
    sourceRevisionSha256: revision,
    ...overrides.source,
  };
  const criteria = overrides.criteria ?? [{ stableKey: "criterion:location", needsReview: false }];
  const questions = overrides.questions ?? [{
    criterionStableKey: "criterion:location",
    evaluationContractVersion: "confirmation-evaluation-v2",
    invalidatedAt: null,
    sourceRevisionSha256: revision,
    sourceRawSha256: raw,
    runtimeBindingEligible: true,
  }];
  const promotion = overrides.promotion === undefined ? {
    runId: "run-current",
    sourceRevisionSha256: revision,
    attachmentManifestSha256: attachments,
    reviewState: "human_reviewed",
    plannedCriterionStableKeys: ["criterion:location"],
    plannedV2QuestionStableKeys: ["criterion:location"],
  } : overrides.promotion;
  return { grant, source, criteria, questions, promotion };
}

test("actual evidence adapter maps an active reviewed promotion to A without reading prompts or raw payload", () => {
  const input = normalizeGrantReadinessEvidence(fixture());
  assert.equal(classifyGrantReadiness(input).category, "A");
  assert.deepEqual(input.analysis.eligibleQuestionCriterionStableKeys, ["criterion:location"]);
});

test("new ingestion without a promotion is D, and reviewed source/criteria with a missing planned v2 question is B", () => {
  assert.equal(classifyGrantReadiness(normalizeGrantReadinessEvidence(fixture({ promotion: null }))).category, "D");
  const missingQuestion = normalizeGrantReadinessEvidence(fixture({ questions: [] }));
  assert.deepEqual(classifyGrantReadiness(missingQuestion).blockerCodes, ["eligible_question_missing"]);
});

test("unreviewed criteria and invalid release binding fail closed before question completeness", () => {
  const incomplete = normalizeGrantReadinessEvidence(fixture({
    criteria: [{ stableKey: "criterion:location", needsReview: true }],
    promotion: { ...fixture().promotion!, reviewState: "ai_audit_concur" },
    questions: [],
  }));
  const readiness = classifyGrantReadiness(incomplete);
  assert.equal(readiness.category, "C");
  assert.ok(readiness.blockerCodes.includes("criteria_review_incomplete"));
  assert.ok(readiness.blockerCodes.includes("eligible_question_missing"));
});

test("runtime에서 답할 수 없는 v2 질문은 version과 source hash가 맞아도 A가 아니다", () => {
  const malformedQuestion = normalizeGrantReadinessEvidence(fixture({
    questions: [{
      ...fixture().questions[0]!,
      runtimeBindingEligible: false,
    }],
  }));
  const readiness = classifyGrantReadiness(malformedQuestion);
  assert.equal(readiness.category, "B");
  assert.ok(readiness.blockerCodes.includes("active_question_unreviewed"));
});

test("latest promotion은 유일한 최신 시각만 선택하고 손상 시 과거 행으로 폴백할 후보를 만들지 않는다", () => {
  const older = { grantId: "grant-a", appliedAt: new Date("2026-09-20T00:00:00Z"), valid: true };
  const newestInvalid = { grantId: "grant-a", appliedAt: new Date("2026-09-21T00:00:00Z"), valid: false };
  const selected = selectUniqueLatestPromotionRows([older, newestInvalid]);
  assert.equal(selected.get("grant-a"), newestInvalid);
  const tied = selectUniqueLatestPromotionRows([
    newestInvalid,
    { ...newestInvalid, valid: true },
  ]);
  assert.equal(tied.has("grant-a"), false);
});

test("KST window includes either endpoint date and excludes grants outside that date", () => {
  const row = fixture().grant;
  assert.equal(isCurrentKstApplicationWindow(row, new Date("2026-09-19T15:00:00Z")), true); // 20th KST
  assert.equal(isCurrentKstApplicationWindow(row, new Date("2026-09-22T14:59:59Z")), true); // 22nd KST
  assert.equal(isCurrentKstApplicationWindow(row, new Date("2026-09-22T15:00:00Z")), false); // 23rd KST
});

test("report has primary A/B/C/D counts and bounded ID-only blocker samples", () => {
  const rows = [fixture(), fixture({ grant: { ...fixture().grant, id: "grant-b" }, questions: [] })]
    .map((evidence) => {
      const input = normalizeGrantReadinessEvidence(evidence);
      return { grantId: input.grantId!, input, readiness: classifyGrantReadiness(input) };
    });
  const report = buildGrantReadinessReport({ asOf: new Date("2026-09-21T00:00:00Z"), rows, sampleLimit: 1 });
  assert.deepEqual(report.summary.categories, { A: 1, B: 1, C: 0, D: 0 });
  assert.deepEqual(report.blockerSamples.eligible_question_missing, ["grant-b"]);
  assert.equal("title" in report, false);
});

console.log("grant readiness loader: DB evidence normalization and bounded report fixtures passed");
