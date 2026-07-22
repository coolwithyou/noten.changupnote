// ai-review-compare 픽스처 단위 테스트 (순수 함수 — DB·네트워크·API 미사용).
// 실행: pnpm lab:ai-review:test
// 검증: confusion matrix 집계·정확 일치·correct→wrong 방향 오검출·빈 축 일치·추가
// missed_condition 플래그(사람 미확인 후보) 분리, §9 채택 기준 경계값 판정,
// 감사 표본 추출의 결정론(시드 고정)·전수 포함·표본 크기.
import assert from "node:assert/strict";
import {
  CALIBRATION_ADOPTION_CRITERIA,
  CRITERION_VERDICT_ORDER,
  compareCalibration,
  judgeAdoption,
  selectAuditTargets,
  type AiReviewForAudit,
  type RunComparisonInput,
} from "./ai-review-compare";

function comparisonFixture(): RunComparisonInput[] {
  return [
    {
      grantId: "g1",
      runId: "run-1",
      title: "공고 1",
      humanCriterionReviews: [
        { criterionIndex: 0, verdict: "correct", note: null },
        { criterionIndex: 1, verdict: "correct", note: null },
        { criterionIndex: 2, verdict: "needs_edit", note: "식품관련 분야를 표시" },
        { criterionIndex: 3, verdict: "correct", note: null },
      ],
      humanAxisReviews: [
        { dimension: "biz_age", verdict: "confirmed_absent", note: null },
        { dimension: "revenue", verdict: "confirmed_absent", note: null },
        { dimension: "premises", verdict: "confirmed_absent", note: null },
      ],
      aiCriterionReviews: [
        { criterionIndex: 0, verdict: "correct", note: null },
        { criterionIndex: 1, verdict: "wrong", note: "원문에 없는 요건" }, // 사람 correct → AI wrong
        { criterionIndex: 2, verdict: "needs_edit", note: "목록 불완전" }, // 일치
        { criterionIndex: 3, verdict: "unsure", note: "붙임 미포함" }, // 불일치(오검출 아님)
      ],
      aiAxisReviews: [
        { dimension: "biz_age", verdict: "confirmed_absent", note: null },
        { dimension: "revenue", verdict: "missed_condition", note: "매출 10억 이하 문구 실재" }, // 사람 확인 축 불일치
        { dimension: "premises", verdict: "confirmed_absent", note: null },
        // 사람 미판정 축의 플래그 — 후보로만 기록되어야 한다(파일럿 export_performance 시나리오).
        { dimension: "export_performance", verdict: "missed_condition", note: "수출실적 가점 실재" },
      ],
    },
    {
      grantId: "g2",
      runId: "run-2",
      title: "공고 2",
      humanCriterionReviews: [
        { criterionIndex: 0, verdict: "correct", note: null },
        { criterionIndex: 1, verdict: "wrong", note: "창조된 요건" },
      ],
      humanAxisReviews: [
        { dimension: "ip", verdict: "confirmed_absent", note: null },
        { dimension: "investment", verdict: "missed_condition", note: "투자유치 요건 누락" }, // §9 분모 밖
      ],
      aiCriterionReviews: [
        { criterionIndex: 0, verdict: "correct", note: null },
        { criterionIndex: 1, verdict: "wrong", note: "원문 부재" }, // 일치
      ],
      aiAxisReviews: [
        { dimension: "ip", verdict: "confirmed_absent", note: null },
        { dimension: "investment", verdict: "missed_condition", note: "투자유치 실재" },
      ],
    },
  ];
}

// ── compareCalibration ─────────────────────────────────────────────────────────────
{
  const report = compareCalibration(comparisonFixture());

  assert.equal(report.criterionTotal, 6, "양쪽 판정 criterion 6건");
  assert.equal(report.exactMatches, 4, "정확 일치 4건 (g1 #0·#2, g2 #0·#1)");
  assert.equal(report.correctToWrong, 1, "사람 correct → AI wrong 1건 (g1 #1)");
  assert.equal(report.humanOnlyCriterionCount, 0);
  assert.equal(report.criterionMismatches.length, 2);
  assert.deepEqual(
    report.criterionMismatches.map((m) => [m.runId, m.criterionIndex, m.humanVerdict, m.aiVerdict]),
    [
      ["run-1", 1, "correct", "wrong"],
      ["run-1", 3, "correct", "unsure"],
    ],
  );

  // confusion matrix — 행: 사람, 열: AI (correct, needs_edit, wrong, unsure).
  const row = (verdict: (typeof CRITERION_VERDICT_ORDER)[number]) =>
    report.confusion[CRITERION_VERDICT_ORDER.indexOf(verdict)]!;
  assert.deepEqual(row("correct"), [2, 0, 1, 1], "사람 correct 4건의 AI 분포");
  assert.deepEqual(row("needs_edit"), [0, 1, 0, 0]);
  assert.deepEqual(row("wrong"), [0, 0, 1, 0]);
  assert.deepEqual(row("unsure"), [0, 0, 0, 0]);
  const matrixSum = report.confusion.flat().reduce((sum, n) => sum + n, 0);
  assert.equal(matrixSum, report.criterionTotal, "matrix 총합 = 비교 분모");

  // 빈 축: 사람 confirmed_absent 4건 중 3건 일치(revenue 불일치), missed 1건은 분모 밖.
  assert.equal(report.axisHumanConfirmedTotal, 4);
  assert.equal(report.axisAgreement, 3);
  assert.deepEqual(
    report.axisMismatches.map((m) => [m.dimension, m.aiVerdict]),
    [["revenue", "missed_condition"]],
  );
  assert.deepEqual(
    report.humanMissedAxes.map((m) => [m.dimension, m.aiVerdict]),
    [["investment", "missed_condition"]],
  );
  // 사람 미판정 축의 AI 플래그는 실격이 아니라 후보 목록으로 분리.
  assert.deepEqual(
    report.extraMissedFlags.map((f) => [f.runId, f.dimension]),
    [["run-1", "export_performance"]],
  );
  console.log("✅ compareCalibration — confusion matrix·일치·오검출·빈 축·플래그 분리");
}

// ── judgeAdoption — §9 경계값 ──────────────────────────────────────────────────────
{
  const base = {
    criterionTotal: CALIBRATION_ADOPTION_CRITERIA.expectedCriterionTotal, // 28
    exactMatches: CALIBRATION_ADOPTION_CRITERIA.minCriterionExactMatches, // 24 — 경계 통과
    correctToWrong: CALIBRATION_ADOPTION_CRITERIA.maxCorrectToWrong, // 2 — 경계 통과
    axisHumanConfirmedTotal: CALIBRATION_ADOPTION_CRITERIA.expectedAxisHumanConfirmedTotal, // 46
    axisAgreement: CALIBRATION_ADOPTION_CRITERIA.minAxisAgreement, // 42 — 경계 통과
  };
  assert.equal(judgeAdoption(base).pass, true, "24/28 ∧ 2건 ∧ 42/46 은 충족(경계 포함)");
  assert.equal(judgeAdoption(base).totalsWarning, null);

  assert.equal(judgeAdoption({ ...base, exactMatches: 23 }).pass, false, "23/28 미달");
  assert.equal(judgeAdoption({ ...base, correctToWrong: 3 }).pass, false, "오검출 3건 미달");
  assert.equal(judgeAdoption({ ...base, axisAgreement: 41 }).pass, false, "빈 축 41/46 미달");

  const warned = judgeAdoption({ ...base, criterionTotal: 27 });
  assert.ok(warned.totalsWarning !== null, "분모가 28/46 과 다르면 경고");
  assert.equal(warned.pass, true, "경고는 판정 자체를 바꾸지 않는다(절대 건수 기준)");

  const failLines = judgeAdoption({ ...base, exactMatches: 0, correctToWrong: 9, axisAgreement: 0 }).lines;
  assert.deepEqual(failLines.map((line) => line.pass), [false, false, false]);
  console.log("✅ judgeAdoption — §9 경계값·미달·분모 경고");
}

// ── selectAuditTargets — 결정론·전수 포함·표본 크기 ────────────────────────────────
{
  const reviews: AiReviewForAudit[] = [
    {
      grantId: "g1",
      runId: "run-1",
      title: "공고 1",
      criterionReviews: [
        { criterionIndex: 0, verdict: "correct", note: null },
        { criterionIndex: 1, verdict: "correct", note: null },
        { criterionIndex: 2, verdict: "needs_edit", note: "수정" },
        { criterionIndex: 3, verdict: "correct", note: null },
        { criterionIndex: 4, verdict: "unsure", note: "모호" },
      ],
      axisReviews: [
        { dimension: "biz_age", verdict: "confirmed_absent", note: null },
        { dimension: "revenue", verdict: "missed_condition", note: "실재" },
      ],
    },
    {
      grantId: "g2",
      runId: "run-2",
      title: "공고 2",
      criterionReviews: [
        { criterionIndex: 0, verdict: "wrong", note: "창조" },
        { criterionIndex: 1, verdict: "correct", note: null },
        { criterionIndex: 2, verdict: "correct", note: null },
        { criterionIndex: 3, verdict: "correct", note: null },
        { criterionIndex: 4, verdict: "correct", note: null },
        { criterionIndex: 5, verdict: "correct", note: null },
        { criterionIndex: 6, verdict: "correct", note: null },
      ],
      axisReviews: [{ dimension: "ip", verdict: "confirmed_absent", note: null }],
    },
  ];

  const first = selectAuditTargets(reviews, { seed: 42, sampleRatio: 0.2 });
  const second = selectAuditTargets([...reviews].reverse(), { seed: 42, sampleRatio: 0.2 });
  assert.deepEqual(first, second, "같은 시드·같은 데이터면 입력 순서와 무관하게 동일 표본");

  const nonCorrect = first.targets.filter((t) => t.kind === "ai_non_correct");
  const flags = first.targets.filter((t) => t.kind === "missed_condition_flag");
  const samples = first.targets.filter((t) => t.kind === "correct_sample");
  assert.deepEqual(
    nonCorrect.map((t) => [t.runId, t.criterionIndex, t.aiVerdict]),
    [
      ["run-1", 2, "needs_edit"],
      ["run-1", 4, "unsure"],
      ["run-2", 0, "wrong"],
    ],
    "비-correct 판정 전수 포함(정렬 순)",
  );
  assert.deepEqual(flags.map((t) => [t.runId, t.dimension]), [["run-1", "revenue"]], "플래그 전수 포함");
  assert.equal(first.correctTotal, 9);
  assert.equal(first.sampledCorrectCount, Math.ceil(9 * 0.2), "correct 표본 = ceil(9×0.2) = 2");
  assert.equal(samples.length, first.sampledCorrectCount);
  for (const sample of samples) assert.equal(sample.aiVerdict, "correct");

  const differentSeed = selectAuditTargets(reviews, { seed: 7, sampleRatio: 0.2 });
  assert.equal(differentSeed.sampledCorrectCount, 2, "시드가 달라도 표본 크기는 동일");
  console.log("✅ selectAuditTargets — 결정론·전수 포함·표본 크기");
}

console.log("\nai-review-compare 테스트 전부 통과");
