// audited-reviews·audit-store 픽스처 단위 테스트 (순수 함수 — DB·네트워크·API 미사용).
// 실행: pnpm lab:audit:test
// 검증: ① 감사 대상 결정론 — buildAuditItemsForRun 이 CLI --audit-list(selectAuditTargets
// 풀 전체) 대상의 런 필터와 정확히 일치 ② 병합 — 동의/뒤집기/비감사 항목의 verdict·note
// 규칙과 provenance 집계 ③ 완료 판정(전 항목 humanVerdict ≠ null, 대상 0건은 공허 완료)
// ④ 미완료 감사의 병합 규칙(미판정 항목은 AI 판정 유지 — 로더는 완료 감사만 확정 편입).
import assert from "node:assert/strict";
import {
  AUDIT_SAMPLE_RATIO,
  AUDIT_SEED,
  selectAuditTargets,
  type AiReviewForAudit,
} from "./ai-review-compare";
import { buildAuditItemsForRun, isLabAuditComplete } from "./audit-store";
import { mergeAuditedReview, type AuditedAiReviewInput } from "./audited-reviews";
import type { LabAudit, LabAuditItem } from "@/features/dev/analysis-lab/contract";

// ── 픽스처 — ai-review-compare.test.ts 의 감사 표본 픽스처와 같은 구조 ─────────────
function auditPoolFixture(): AiReviewForAudit[] {
  return [
    {
      grantId: "g1",
      runId: "run-1",
      title: "공고 1",
      criterionReviews: [
        { criterionIndex: 0, verdict: "correct", note: null },
        { criterionIndex: 1, verdict: "correct", note: null },
        { criterionIndex: 2, verdict: "needs_edit", note: "값 축약 수정" },
        { criterionIndex: 3, verdict: "correct", note: null },
        { criterionIndex: 4, verdict: "unsure", note: "붙임 미포함" },
      ],
      axisReviews: [
        { dimension: "biz_age", verdict: "confirmed_absent", note: null },
        { dimension: "revenue", verdict: "missed_condition", note: "매출 요건 실재" },
      ],
    },
    {
      grantId: "g2",
      runId: "run-2",
      title: "공고 2",
      criterionReviews: [
        { criterionIndex: 0, verdict: "wrong", note: "원문에 없는 요건" },
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
}

// ── ① 대상 결정론 — CLI(--audit-list) 풀 전체 선정의 런 필터와 일치 ────────────────
{
  const pool = auditPoolFixture();
  const cliSelection = selectAuditTargets(pool, { seed: AUDIT_SEED, sampleRatio: AUDIT_SAMPLE_RATIO });

  for (const runId of ["run-1", "run-2"]) {
    const items = buildAuditItemsForRun(pool, runId);
    const cliTargets = cliSelection.targets.filter((target) => target.runId === runId);
    assert.equal(items.length, cliTargets.length, `${runId}: 항목 수가 CLI 대상 수와 일치`);
    assert.deepEqual(
      items.map((item) => [item.kind, item.criterionIndex ?? null, item.dimension ?? null, item.reason, item.aiVerdict]),
      cliTargets.map((target) => [
        target.criterionIndex !== undefined ? "criterion" : "axis",
        target.criterionIndex ?? null,
        target.dimension ?? null,
        target.kind,
        target.aiVerdict,
      ]),
      `${runId}: 항목·순서가 CLI 대상과 동일(§9 결정론)`,
    );
  }
  // 두 런의 항목 합 = 풀 전체 대상 수(비-correct 4 + 플래그 1 + correct 표본 ceil(9×0.2)=2).
  const totalItems = buildAuditItemsForRun(pool, "run-1").length + buildAuditItemsForRun(pool, "run-2").length;
  assert.equal(totalItems, cliSelection.targets.length);
  // 입력 순서와 무관 — 풀을 뒤집어도 같은 대상.
  assert.deepEqual(
    buildAuditItemsForRun([...pool].reverse(), "run-1"),
    buildAuditItemsForRun(pool, "run-1"),
    "풀 입력 순서 무관 결정론",
  );
  // 생성 직후 항목은 전부 미판정이다.
  for (const item of buildAuditItemsForRun(pool, "run-1")) {
    assert.equal(item.humanVerdict, null);
    assert.equal(item.note, null);
  }
  console.log("✅ buildAuditItemsForRun — CLI --audit-list 대상과 결정론 일치");
}

// ── ② 병합 — 동의/뒤집기/비감사 항목 규칙 + provenance ─────────────────────────────
function auditFixture(items: LabAuditItem[]): LabAudit {
  return {
    schema: "lab-audit-v1",
    grantId: "g1",
    runId: "run-1",
    model: "claude-fable-5",
    aiPromptVersion: "ai-review-v2",
    auditorEmail: "human@example.com",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T01:00:00.000Z",
    items,
    overallNote: "감사 총평",
  };
}

const aiReviewFixture: AuditedAiReviewInput = {
  grantId: "g1",
  runId: "run-1",
  model: "claude-fable-5",
  promptVersion: "ai-review-v2",
  criterionReviews: [
    { criterionIndex: 0, verdict: "correct", note: null }, // 비감사 — AI 그대로
    { criterionIndex: 1, verdict: "needs_edit", note: "AI 지적" }, // 감사: 동의
    { criterionIndex: 2, verdict: "needs_edit", note: "AI 오지적" }, // 감사: 뒤집기 → correct
    { criterionIndex: 3, verdict: "correct", note: null }, // 감사(표본): 뒤집기 → wrong
  ],
  axisReviews: [
    { dimension: "biz_age", verdict: "confirmed_absent", note: null }, // 비감사 — AI 그대로
    { dimension: "revenue", verdict: "missed_condition", note: "AI 플래그" }, // 감사: 뒤집기 → 없음 확인
  ],
};

{
  const audit = auditFixture([
    {
      kind: "criterion",
      criterionIndex: 1,
      reason: "ai_non_correct",
      aiVerdict: "needs_edit",
      aiNote: "AI 지적",
      humanVerdict: "needs_edit", // 동의 — note 없음 → AI note 유지
      note: null,
    },
    {
      kind: "criterion",
      criterionIndex: 2,
      reason: "ai_non_correct",
      aiVerdict: "needs_edit",
      aiNote: "AI 오지적",
      humanVerdict: "correct", // 뒤집기
      note: "원문 확인 — AI 가 §0 리트머스를 놓침",
    },
    {
      kind: "criterion",
      criterionIndex: 3,
      reason: "correct_sample",
      aiVerdict: "correct",
      aiNote: null,
      humanVerdict: "wrong", // 뒤집기
      note: "원문에 없는 요건",
    },
    {
      kind: "axis",
      dimension: "revenue",
      reason: "missed_condition_flag",
      aiVerdict: "missed_condition",
      aiNote: "AI 플래그",
      humanVerdict: "confirmed_absent", // 뒤집기
      note: "다른 축 criterion 으로 이미 포착",
    },
  ]);

  const merged = mergeAuditedReview(aiReviewFixture, audit);
  const byIndex = new Map(merged.review.criterionReviews.map((item) => [item.criterionIndex, item]));

  // 비감사 항목 — AI verdict·note 그대로(§9 표본 감사 설계).
  assert.deepEqual(byIndex.get(0), { criterionIndex: 0, verdict: "correct", note: null });
  // 동의 — verdict 유지, note 는 human note ?? AI note.
  assert.deepEqual(byIndex.get(1), { criterionIndex: 1, verdict: "needs_edit", note: "AI 지적" });
  // 뒤집기 — humanVerdict 반영, human note 우선.
  assert.deepEqual(byIndex.get(2), {
    criterionIndex: 2,
    verdict: "correct",
    note: "원문 확인 — AI 가 §0 리트머스를 놓침",
  });
  assert.deepEqual(byIndex.get(3), { criterionIndex: 3, verdict: "wrong", note: "원문에 없는 요건" });
  // 빈 축 — 비감사 유지 + 뒤집기 반영.
  assert.deepEqual(merged.review.axisReviews, [
    { dimension: "biz_age", verdict: "confirmed_absent", note: null },
    { dimension: "revenue", verdict: "confirmed_absent", note: "다른 축 criterion 으로 이미 포착" },
  ]);
  // LabReview 호환 메타 — 감사자가 검수자다.
  assert.equal(merged.review.reviewerEmail, "human@example.com");
  assert.equal(merged.review.updatedAt, "2026-07-23T01:00:00.000Z");
  assert.equal(merged.review.overallNote, "감사 총평");
  // provenance — 감사 4건 중 뒤집힘 3건(공고당 >1건 → §9 신뢰 재평가 신호). AI 블라인드
  // 감사 미실행 파일이므로 aiAudit* 카운트는 전부 0/null(하위 호환).
  assert.deepEqual(merged.provenance, {
    source: "ai_plus_audit",
    model: "claude-fable-5",
    aiPromptVersion: "ai-review-v2",
    auditedCount: 4,
    overturnedCount: 3,
    aiAuditedCount: 0,
    aiConcurCount: 0,
    aiDisagreeCount: 0,
    aiAuditModel: null,
  });
  console.log("✅ mergeAuditedReview — 동의/뒤집기/비감사·note 규칙·provenance");
}

// ── ③ 완료 판정 + ④ 미완료 감사의 병합 규칙 ───────────────────────────────────────
{
  const complete = auditFixture([
    {
      kind: "criterion",
      criterionIndex: 1,
      reason: "ai_non_correct",
      aiVerdict: "needs_edit",
      aiNote: null,
      humanVerdict: "needs_edit",
      note: null,
    },
  ]);
  assert.equal(isLabAuditComplete(complete), true, "전 항목 판정 → 완료");

  const incomplete = auditFixture([
    {
      kind: "criterion",
      criterionIndex: 1,
      reason: "ai_non_correct",
      aiVerdict: "needs_edit",
      aiNote: "AI 지적",
      humanVerdict: null, // 미판정
      note: null,
    },
    {
      kind: "criterion",
      criterionIndex: 2,
      reason: "ai_non_correct",
      aiVerdict: "needs_edit",
      aiNote: "AI 오지적",
      humanVerdict: "correct",
      note: "뒤집기 사유",
    },
  ]);
  assert.equal(isLabAuditComplete(incomplete), false, "미판정 1건 → 미완료(로더는 감사 대기로 분류·집계 제외)");

  const empty = auditFixture([]);
  assert.equal(isLabAuditComplete(empty), true, "대상 0건은 공허 완료(감사 없이 확정 편입)");

  // 미완료 감사를 병합해도 미판정 항목은 AI 판정 유지 — 판정분만 반영된다.
  const partialMerged = mergeAuditedReview(aiReviewFixture, incomplete);
  const byIndex = new Map(partialMerged.review.criterionReviews.map((item) => [item.criterionIndex, item]));
  assert.deepEqual(byIndex.get(1), { criterionIndex: 1, verdict: "needs_edit", note: "AI 지적" });
  assert.deepEqual(byIndex.get(2), { criterionIndex: 2, verdict: "correct", note: "뒤집기 사유" });
  assert.deepEqual(
    partialMerged.provenance,
    {
      source: "ai_plus_audit",
      model: "claude-fable-5",
      aiPromptVersion: "ai-review-v2",
      auditedCount: 1,
      overturnedCount: 1,
      aiAuditedCount: 0,
      aiConcurCount: 0,
      aiDisagreeCount: 0,
      aiAuditModel: null,
    },
    "미판정 항목은 audited/overturned 집계에서 제외",
  );

  // 병합은 대상 정합을 강제한다 — 다른 런의 감사를 섞으면 즉시 실패.
  assert.throws(
    () => mergeAuditedReview({ ...aiReviewFixture, runId: "run-999" }, complete),
    /감사 병합 대상 불일치/,
  );
  console.log("✅ isLabAuditComplete·부분 병합 — 완료 판정·미판정 AI 유지·대상 정합 가드");
}

// ── ⑤ AI 블라인드 감사(§9 완화 개정) — concur 자동 완료·병합 불변·provenance ─────────
{
  const aiAudited = auditFixture([
    {
      kind: "criterion",
      criterionIndex: 1,
      reason: "ai_non_correct",
      aiVerdict: "needs_edit",
      aiNote: "AI 지적",
      humanVerdict: null,
      note: null,
      aiAuditVerdict: "needs_edit", // 정확 일치 — 자동 확정
      aiAuditNote: "독립 재판정도 동일 지적",
    },
    {
      kind: "criterion",
      criterionIndex: 3,
      reason: "correct_sample",
      aiVerdict: "correct",
      aiNote: null,
      humanVerdict: "wrong", // 불일치 후 사람이 판정
      note: "원문에 없는 요건",
      aiAuditVerdict: "wrong",
      aiAuditNote: "원문 근거 없음",
    },
  ]);
  aiAudited.aiAuditModel = "claude-sonnet-5";
  aiAudited.aiAuditPromptVersion = "ai-audit-v1";
  aiAudited.aiAuditedAt = "2026-07-23T10:00:00.000Z";
  aiAudited.auditorEmail = "human@example.com";

  assert.equal(isLabAuditComplete(aiAudited), true, "concur + 사람 판정 조합 → 완료");

  const merged = mergeAuditedReview(aiReviewFixture, aiAudited);
  const byIndex = new Map(merged.review.criterionReviews.map((item) => [item.criterionIndex, item]));
  // concur 항목은 humanVerdict 가 없으므로 병합 결과는 기존 AI 검수 판정 그대로(불변).
  assert.deepEqual(byIndex.get(1), { criterionIndex: 1, verdict: "needs_edit", note: "AI 지적" });
  // 사람 판정 항목은 사람이 우선.
  assert.deepEqual(byIndex.get(3), { criterionIndex: 3, verdict: "wrong", note: "원문에 없는 요건" });
  assert.deepEqual(
    merged.provenance,
    {
      source: "ai_plus_audit",
      model: "claude-fable-5",
      aiPromptVersion: "ai-review-v2",
      auditedCount: 1,
      overturnedCount: 1,
      aiAuditedCount: 2,
      aiConcurCount: 1, // #1 — 사람 판정 없는 정확 일치만 자동 확정으로 센다
      aiDisagreeCount: 1, // #3 — 불일치(사람 판정이 뒤따랐어도 불일치 기록은 유지)
      aiAuditModel: "claude-sonnet-5",
    },
    "provenance — 사람/AI 감사 갈래 분리 집계",
  );
  console.log("✅ AI 블라인드 감사 — concur 자동 완료·병합 결과 불변·provenance 집계");
}

console.log("\naudited-reviews 테스트 전부 통과");
