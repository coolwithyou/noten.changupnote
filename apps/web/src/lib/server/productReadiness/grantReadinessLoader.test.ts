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
import { planGrantNextWork } from "./grantNextWork";

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
    attachmentStatus: "complete" as const,
    attachmentManifestSha256: attachments,
    sourceRevisionSha256: revision,
    ...overrides.source,
  };
  const criteria = overrides.criteria ?? [{
    stableKey: "criterion:location",
    dimension: "other",
    kind: "required",
    operator: "text_only",
    value: { note: "시흥시 소재 기업" },
    sourceSpan: "시흥시 관내 기업",
    needsReview: false,
  }];
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

test("검수 조건에서 질문 수요를 도출하고 current reviewed v2 질문이 있으면 A다", () => {
  const input = normalizeGrantReadinessEvidence(fixture());
  assert.equal(classifyGrantReadiness(input).category, "A");
  assert.deepEqual(input.analysis.eligibleQuestionCriterionStableKeys, ["criterion:location"]);
});

test("DB 조건이 있으면 발행 전에도 분석 존재로 보며, 조건도 없을 때만 분석 없음이다", () => {
  const unpublished = classifyGrantReadiness(normalizeGrantReadinessEvidence(fixture({ promotion: null })));
  assert.equal(unpublished.category, "C");
  assert.ok(unpublished.blockerCodes.includes("analysis_source_binding_missing"));
  const unanalysed = classifyGrantReadiness(normalizeGrantReadinessEvidence(fixture({ promotion: null, criteria: [] })));
  assert.equal(unanalysed.category, "D");
  assert.ok(unanalysed.blockerCodes.includes("analysis_missing"));
  const missingQuestion = normalizeGrantReadinessEvidence(fixture({ questions: [] }));
  assert.deepEqual(classifyGrantReadiness(missingQuestion).blockerCodes, ["eligible_question_missing"]);
});

test("검수 전 조건은 질문 수요를 추정하지 않고 원문 검수 단계에서 닫는다", () => {
  const incomplete = normalizeGrantReadinessEvidence(fixture({
    criteria: [{ ...fixture().criteria[0]!, needsReview: true }],
    promotion: { ...fixture().promotion!, reviewState: "ai_audit_concur" },
    questions: [],
  }));
  const readiness = classifyGrantReadiness(incomplete);
  assert.equal(readiness.category, "C");
  assert.ok(readiness.blockerCodes.includes("criteria_review_incomplete"));
  assert.ok(!readiness.blockerCodes.includes("eligible_question_missing"));
});

test("promotion 질문 계획이 비어 있어도 검수된 필수 text_only에서 누락 질문을 찾는다", () => {
  const input = normalizeGrantReadinessEvidence(fixture({
    promotion: { ...fixture().promotion!, plannedV2QuestionStableKeys: [] },
    questions: [],
  }));
  assert.deepEqual(input.analysis.eligibleQuestionCriterionStableKeys, ["criterion:location"]);
  assert.deepEqual(classifyGrantReadiness(input).blockerCodes, ["eligible_question_missing"]);
});

test("구조화 회사 비교와 우대 text_only는 자격 질문 artifact를 요구하지 않는다", () => {
  const criteria = [
    {
      ...fixture().criteria[0]!,
      stableKey: "criterion:region",
      dimension: "region" as const,
      operator: "in" as const,
      value: { regions: ["41"] },
    },
    {
      ...fixture().criteria[0]!,
      stableKey: "criterion:preferred",
      kind: "preferred" as const,
    },
  ];
  const input = normalizeGrantReadinessEvidence(fixture({
    criteria,
    questions: [],
    promotion: {
      ...fixture().promotion!,
      plannedCriterionStableKeys: criteria.map((criterion) => criterion.stableKey),
      plannedV2QuestionStableKeys: [],
    },
  }));
  assert.deepEqual(input.analysis.eligibleQuestionCriterionStableKeys, []);
  assert.equal(classifyGrantReadiness(input).category, "A");
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
      const readiness = classifyGrantReadiness(input);
      return { grantId: input.grantId!, input, readiness, nextWork: planGrantNextWork(readiness) };
    });
  const report = buildGrantReadinessReport({ asOf: new Date("2026-09-21T00:00:00Z"), rows, sampleLimit: 1 });
  assert.deepEqual(report.summary.categories, { A: 1, B: 1, C: 0, D: 0 });
  assert.equal(report.nextWorkCounts.reuse_ready, 1);
  assert.equal(report.nextWorkCounts.question_preparation, 1);
  assert.deepEqual(report.blockerSamples.eligible_question_missing, ["grant-b"]);
  assert.equal("title" in report, false);
});

console.log("grant readiness loader: DB evidence normalization and bounded report fixtures passed");
