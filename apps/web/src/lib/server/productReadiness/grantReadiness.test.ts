import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGrantReadiness,
  CONFIRMATION_EVALUATION_V2,
  summarizeGrantReadiness,
  type GrantReadinessInput,
} from "./grantReadiness";

const revision = "a".repeat(64);
const raw = "b".repeat(64);
const attachments = "c".repeat(64);

function fixture(overrides: Partial<GrantReadinessInput> = {}): GrantReadinessInput {
  const source = { availability: "available" as const, collectedAt: "2026-09-21T00:00:00.000Z", revisionSha256: revision, rawSha256: raw,
    attachmentStatus: "complete" as const, attachmentManifestSha256: attachments, ...overrides.source };
  const analysis = { status: "present" as const, sourceRevisionSha256: revision, sourceRawSha256: raw,
    attachmentManifestSha256: attachments, structure: "complete" as const, criteriaReview: "reviewed" as const,
    eligibleQuestionCriterionStableKeys: ["criterion:location"], ...overrides.analysis };
  const questions = overrides.questions ?? [{ criterionStableKey: "criterion:location", evaluationContractVersion: CONFIRMATION_EVALUATION_V2,
    reviewed: true, invalidated: false, sourceRevisionSha256: revision, sourceRawSha256: raw }];
  return { grantId: "fixture", source, analysis, questions };
}

test("A: 현재 검수 조건과 current reviewed v2 질문이 모두 있으면 준비됨", () => {
  const actual = classifyGrantReadiness(fixture());
  assert.equal(actual.category, "A");
  assert.deepEqual(actual.blockerCodes, []);
  assert.equal(actual.eligibleQuestionCount, 1);
  assert.equal(actual.eligibleQuestionCoveredCount, 1);
});

test("B: 검수된 source/criteria에서 질문이 없거나 v2·검수·freshness가 부족하면 질문 보완 대상", () => {
  assert.deepEqual(classifyGrantReadiness(fixture({ questions: [] })), {
    schema: "grant-product-readiness-v1",
    category: "B",
    blockerCodes: ["eligible_question_missing"],
    eligibleQuestionCount: 1,
    eligibleQuestionCoveredCount: 0,
  });
  const stale = classifyGrantReadiness(fixture({ questions: [{ criterionStableKey: "criterion:location", evaluationContractVersion: CONFIRMATION_EVALUATION_V2,
    reviewed: false, invalidated: false, sourceRevisionSha256: revision, sourceRawSha256: raw }] }));
  assert.equal(stale.category, "B");
  assert.deepEqual(stale.blockerCodes, ["active_question_unreviewed", "eligible_question_missing"]);
});

test("C: source와 analysis가 있어도 structure/review가 미완료면 질문보다 먼저 보완한다", () => {
  const actual = classifyGrantReadiness(fixture({
    analysis: { ...fixture().analysis, structure: "incomplete", criteriaReview: "incomplete" },
    questions: [],
  }));
  assert.equal(actual.category, "C");
  assert.deepEqual(actual.blockerCodes, ["criteria_review_incomplete", "criteria_structure_incomplete", "eligible_question_missing"]);
});

test("D: 원문/첨부/분석의 결속 문제는 C/B blocker가 함께 있어도 우선한다", () => {
  const actual = classifyGrantReadiness(fixture({
    source: { ...fixture().source, attachmentStatus: "missing" },
    analysis: { ...fixture().analysis, status: "missing", structure: "incomplete" },
    questions: [],
  }));
  assert.equal(actual.category, "D");
  assert.deepEqual(actual.blockerCodes, ["analysis_missing", "attachments_missing", "eligible_question_missing"]);
});

test("revision/raw/attachment 내용 변경은 D이며 collectedAt metadata 변경만으로는 stale하지 않다", () => {
  const baseline = classifyGrantReadiness(fixture());
  const metadataOnly = classifyGrantReadiness(fixture({ source: { ...fixture().source, collectedAt: "2026-09-21T12:00:00.000Z" } }));
  assert.deepEqual(metadataOnly, baseline);
  const changed = classifyGrantReadiness(fixture({ source: { ...fixture().source, rawSha256: "d".repeat(64) } }));
  assert.equal(changed.category, "D");
  assert.deepEqual(changed.blockerCodes, ["active_question_source_stale", "eligible_question_missing", "source_raw_changed"]);
});

test("중복 expected key는 한 질문으로 커버하지만 빈 stable key는 C로 fail-closed한다", () => {
  const duplicate = classifyGrantReadiness(fixture({ analysis: { ...fixture().analysis, eligibleQuestionCriterionStableKeys: ["criterion:location", "criterion:location"] } }));
  assert.equal(duplicate.category, "A");
  assert.equal(duplicate.eligibleQuestionCount, 1);
  const malformed = classifyGrantReadiness(fixture({ analysis: { ...fixture().analysis, eligibleQuestionCriterionStableKeys: [""] } }));
  assert.equal(malformed.category, "C");
  assert.deepEqual(malformed.blockerCodes, ["eligible_question_key_missing"]);
});

test("전체 집계는 primary category 하나씩만 세고 secondary blocker는 별도로 센다", () => {
  const summary = summarizeGrantReadiness([
    fixture(),
    fixture({ questions: [] }),
    fixture({ analysis: { ...fixture().analysis, criteriaReview: "incomplete" } }),
    fixture({ analysis: { ...fixture().analysis, status: "missing" }, questions: [] }),
  ]);
  assert.deepEqual(summary.categories, { A: 1, B: 1, C: 1, D: 1 });
  assert.equal(summary.total, 4);
  assert.equal(summary.blockerCounts.analysis_missing, 1);
  assert.equal(summary.blockerCounts.eligible_question_missing, 2);
});

console.log("grant readiness: A/B/C/D priority, question coverage, source binding, and totals passed");
