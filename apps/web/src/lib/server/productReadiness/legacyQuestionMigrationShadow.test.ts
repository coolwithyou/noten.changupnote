import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLegacyQuestionMigrationShadowReport,
  classifyLegacyQuestionMigration,
  type LegacyQuestionMigrationShadowInput,
} from "./legacyQuestionMigrationShadow";

const sha = (value: string) => value.repeat(64).slice(0, 64);
function row(overrides: Partial<LegacyQuestionMigrationShadowInput> = {}): LegacyQuestionMigrationShadowInput {
  return {
    questionId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
    criterionId: crypto.randomUUID(),
    criterionStableKey: "criterion:region:1",
    evaluationContractVersion: null,
    sourceRevisionSha256: null,
    sourceRawSha256: null,
    definitionSha256: "legacy-v0",
    answerType: "single",
    options: [
      { value: "yes", label: "해당", disqualifies: false },
      { value: "no", label: "비해당", disqualifies: true },
    ],
    reusable: "per_notice",
    conditionKey: null,
    provenance: { runId: "legacy" },
    criterion: {
      dimension: "other",
      kind: "required",
      operator: "text_only",
      value: { note: "시흥시 소재 기업" },
      confidence: 1,
      sourceSpan: "시흥시 소재 기업",
      needsReview: false,
    },
    currentSource: { sourceRevisionSha256: sha("a"), sourceRawSha256: sha("b") },
    legacyVisible: true,
    strictV2Visible: false,
    answerCount: 0,
    answeringCompanyCount: 0,
    ...overrides,
  };
}

test("legacy 질문은 구조가 충분해도 자동 이관하지 않고 사람 검수 후보로 둔다", () => {
  const actual = classifyLegacyQuestionMigration(row());
  assert.equal(actual.disposition, "legacy_review_candidate");
  assert.equal(actual.difference, "intentional_change");
  assert.equal(actual.automaticMigrationAllowed, false);
  assert.deepEqual(actual.blockers, ["manual_polarity_and_scope_review_required"]);
});

test("기존 답변이 있으면 의미 mapping과 답변 보존 검수를 별도 요구한다", () => {
  const actual = classifyLegacyQuestionMigration(row({ answerCount: 3, answeringCompanyCount: 2 }));
  assert.equal(actual.disposition, "legacy_answer_preservation_review");
  assert.deepEqual(actual.blockers, ["existing_answers_require_semantic_mapping"]);
  assert.equal(actual.answerCount, 3);
  assert.equal(actual.answeringCompanyCount, 2);
});

test("stable key, source, 원문 근거가 부족한 legacy 질문은 구조 수리로 격리한다", () => {
  const actual = classifyLegacyQuestionMigration(row({
    criterionStableKey: null,
    currentSource: null,
    criterion: { ...row().criterion, sourceSpan: null, needsReview: true },
  }));
  assert.equal(actual.disposition, "legacy_structure_repair");
  assert.deepEqual(actual.blockers, [
    "criterion_review_incomplete",
    "criterion_source_span_missing",
    "criterion_stable_key_missing",
    "current_source_binding_missing",
  ]);
});

test("current v2 binding만 엄격 노출로 인정하고 application 전용 조건은 이관하지 않는다", () => {
  const verified = classifyLegacyQuestionMigration(row({
    evaluationContractVersion: "confirmation-evaluation-v2",
    sourceRevisionSha256: sha("a"),
    sourceRawSha256: sha("b"),
    legacyVisible: true,
    strictV2Visible: true,
  }));
  assert.equal(verified.disposition, "verified_v2");
  assert.equal(verified.difference, "unchanged");

  const application = classifyLegacyQuestionMigration(row({
    criterion: {
      ...row().criterion,
      kind: "exclusion",
      operator: "text_only",
      sourceSpan: "접수 마감일까지 계획서 등 제반서류를 제출 완료하지 않은 경우",
    },
    legacyVisible: false,
  }));
  assert.equal(application.disposition, "not_applicable");
  assert.equal(application.difference, "unchanged");
});

test("회사 프로필로 판정할 구조화 조건의 legacy 질문 제거는 개선으로 분류한다", () => {
  const actual = classifyLegacyQuestionMigration(row({
    criterion: {
      ...row().criterion,
      dimension: "region",
      operator: "in",
      value: { regions: ["41"] },
      sourceSpan: "경기도 소재 기업",
    },
  }));
  assert.equal(actual.disposition, "not_applicable");
  assert.deepEqual(actual.blockers, ["resolved_by_company_profile"]);
  assert.equal(actual.difference, "improvement");
});

test("report는 정렬에 독립적인 exact snapshot과 수량 보존을 제공한다", () => {
  const first = row({ questionId: "00000000-0000-4000-8000-000000000002" });
  const second = row({
    questionId: "00000000-0000-4000-8000-000000000001",
    answerCount: 1,
    answeringCompanyCount: 1,
  });
  const observedAt = new Date("2026-09-22T00:00:00.000Z");
  const left = buildLegacyQuestionMigrationShadowReport({ observedAt, rows: [first, second] });
  const right = buildLegacyQuestionMigrationShadowReport({ observedAt, rows: [second, first] });
  assert.equal(left.snapshotSha256, right.snapshotSha256);
  assert.equal(left.questionCount, 2);
  assert.equal(Object.values(left.dispositionCounts).reduce((sum, count) => sum + count, 0), 2);
  assert.equal(Object.values(left.differenceCounts).reduce((sum, count) => sum + count, 0), 2);
  assert.deepEqual(left.authority, {
    readOnly: true,
    modelCallsMade: 0,
    databaseWritesMade: 0,
    migrationAuthorized: false,
  });
  assert.throws(() => buildLegacyQuestionMigrationShadowReport({ observedAt, rows: [first, first] }), /중복/);
});
