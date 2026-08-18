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
import {
  isLabAuditCompleteForRun,
  mergeAuditedReview,
  type AuditedAiReviewInput,
} from "./audited-reviews";
import { assessPromotionReviewRisk } from "./promotion-review-risk";
import type { LabAudit, LabAuditItem, LabRun } from "@/lib/server/analysis-lab/lab-contract";

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
        {
          dimension: "revenue",
          verdict: "missed_condition",
          matchImpact: "ranking",
          note: "매출 요건 실재",
        },
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
    aiAdjudicatedCount: 0,
    aiAuditModel: null,
    aiAdjudicationModel: null,
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
      aiAdjudicatedCount: 0,
      aiAuditModel: null,
      aiAdjudicationModel: null,
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
      aiAdjudicatedCount: 0,
      aiAuditModel: "claude-sonnet-5",
      aiAdjudicationModel: null,
    },
    "provenance — 사람/AI 감사 갈래 분리 집계",
  );
  console.log("✅ AI 블라인드 감사 — concur 자동 완료·병합 결과 불변·provenance 집계");
}

// ── ⑥ 제품 계약 결정 규칙 — 현재 동일 사업 중복참여를 과거 수혜로 오해한 검수만 해소 ──
{
  const run: LabRun = {
    runId: "run-deterministic-same-project",
    grantId: "00000000-0000-4000-8000-000000000777",
    source: "bizinfo",
    sourceId: "PBLN_DETERMINISTIC",
    title: "동일 사업 중복참여 테스트",
    model: "claude-opus-5",
    promptVersion: "lab-deep-v9",
    startedAt: "2026-08-07T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: "0".repeat(64),
    usage: null,
    costUsd: null,
    analysisMarkdown: "",
    programIntent: null,
    criteria: [{
      dimension: "prior_award",
      kind: "exclusion",
      operator: "exists",
      value: { scope: "self", self_kind: "same_project", channel: "general" },
      confidence: 0.9,
      sourceSpan: "(중복참여불가) 동일 사업 내 타 운영기관 중복 참여 불가",
      spanVerified: true,
      note: null,
    }],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    error: null,
  };
  const review: AuditedAiReviewInput = {
    grantId: run.grantId,
    runId: run.runId,
    model: "claude-fable-5",
    promptVersion: "ai-review-v5",
    criterionReviews: [{
      criterionIndex: 0,
      verdict: "needs_edit",
      note: "동시 중복 참여 조건인데 prior_award이면 과거 수혜 이력까지 배제한다.",
    }],
    axisReviews: [],
  };
  const audit: LabAudit = {
    schema: "lab-audit-v1",
    grantId: run.grantId,
    runId: run.runId,
    model: review.model,
    aiPromptVersion: review.promptVersion,
    aiAuditModel: "claude-sonnet-5",
    aiAuditPromptVersion: "ai-audit-v4",
    auditorEmail: null,
    createdAt: "2026-08-07T00:01:00.000Z",
    updatedAt: "2026-08-07T00:01:00.000Z",
    items: [{
      kind: "criterion",
      criterionIndex: 0,
      reason: "ai_non_correct",
      aiVerdict: "needs_edit",
      aiNote: review.criterionReviews[0]!.note,
      humanVerdict: null,
      note: null,
      aiAuditVerdict: "correct",
      aiAuditNote: "same_project 계약과 일치",
    }],
    overallNote: null,
  };

  assert.equal(isLabAuditComplete(audit), false, "일반 감사 규칙에서는 불일치가 계속 대기한다");
  assert.equal(
    isLabAuditCompleteForRun(run, audit),
    true,
    "원문·criterion·오지적 사유·독립 감사 모두 일치할 때만 계약 규칙으로 완료한다",
  );
  const merged = mergeAuditedReview(review, audit, run);
  assert.equal(merged.review.criterionReviews[0]?.verdict, "correct");
  assert.deepEqual(merged.provenance.deterministicResolvedCriterionIndexes, [0]);

  const unrelated = {
    ...audit,
    items: [{ ...audit.items[0]!, aiNote: "값을 다시 확인해야 한다." }],
  } satisfies LabAudit;
  assert.equal(
    isLabAuditCompleteForRun(run, unrelated),
    false,
    "과거 수혜로 오해한 지적이 아니면 같은 criterion도 자동 해소하지 않는다",
  );
  console.log("✅ 결정 규칙 — same_project 과거수혜 오해만 자동 해소·나머지는 대기");
}

// ── ⑦ 공식 신청대상과 서식 기재란 혼동 — 제품 계약으로만 자동 해소 ──
{
  const run: LabRun = {
    runId: "run-deterministic-structured-target",
    grantId: "00000000-0000-4000-8000-000000000779",
    source: "bizinfo",
    sourceId: "PBLN_STRUCTURED_TARGET",
    title: "공식 신청대상 필드 테스트",
    model: "claude-opus-5",
    promptVersion: "lab-deep-v9",
    startedAt: "2026-08-09T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: "2".repeat(64),
    usage: null,
    costUsd: null,
    analysisMarkdown: "",
    programIntent: null,
    criteria: [{
      dimension: "size",
      kind: "required",
      operator: "in",
      value: { sizes: ["중소기업"] },
      confidence: 0.7,
      sourceSpan: "지원대상: 중소기업 (source_field: trgetNm)",
      spanVerified: true,
      note: "Bizinfo 공식 신청대상 필드 기준. 신청서의 기업 유형은 기재란(정보 수집)이므로 자격 근거로 사용하지 않음.",
    }],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    error: null,
  };
  const review: AuditedAiReviewInput = {
    grantId: run.grantId,
    runId: run.runId,
    model: "claude-fable-5",
    promptVersion: "ai-review-v7",
    criterionReviews: [{
      criterionIndex: 0,
      verdict: "needs_edit",
      note: "근거가 trgetNm뿐이고 신청서 서식의 기업 유형에 스타트업 / 중소기업 / 중견기업 / 그외를 병기해 비중소기업도 상정했다.",
    }],
    axisReviews: [],
  };
  const audit: LabAudit = {
    schema: "lab-audit-v1",
    grantId: run.grantId,
    runId: run.runId,
    model: review.model,
    aiPromptVersion: review.promptVersion,
    aiAuditModel: "claude-sonnet-5",
    aiAuditPromptVersion: "ai-audit-v6",
    auditorEmail: null,
    createdAt: "2026-08-09T00:01:00.000Z",
    updatedAt: "2026-08-09T00:01:00.000Z",
    items: [{
      kind: "criterion",
      criterionIndex: 0,
      reason: "ai_non_correct",
      aiVerdict: "needs_edit",
      aiNote: review.criterionReviews[0]!.note,
      humanVerdict: null,
      note: null,
      aiAuditVerdict: "correct",
      aiAuditNote: null,
    }],
    overallNote: null,
  };

  assert.equal(
    isLabAuditCompleteForRun(run, audit),
    true,
    "공식 신청대상과 서식 기재란만 혼동한 경우 계약 규칙으로 완료한다",
  );
  const merged = mergeAuditedReview(review, audit, run);
  assert.equal(merged.review.criterionReviews[0]?.verdict, "correct");
  assert.deepEqual(merged.provenance.deterministicResolvedCriterionIndexes, [0]);

  const noStructuredEvidence: LabRun = {
    ...run,
    runId: "run-no-structured-target",
    criteria: [{ ...run.criteria[0]!, sourceSpan: "지원대상: 중소기업" }],
  };
  assert.equal(
    isLabAuditCompleteForRun(noStructuredEvidence, { ...audit, runId: noStructuredEvidence.runId }),
    false,
    "trgetNm 근거가 봉인되지 않으면 자동 해소하지 않는다",
  );
  const unrelatedFinding = {
    ...audit,
    items: [{ ...audit.items[0]!, aiNote: "trgetNm 값 자체가 원문과 다르다." }],
  } satisfies LabAudit;
  assert.equal(
    isLabAuditCompleteForRun(run, unrelatedFinding),
    false,
    "서식 기재란 혼동이 아닌 지적은 자동 해소하지 않는다",
  );
  console.log("✅ 공식 신청대상 — trgetNm과 서식 기재란 혼동만 자동 해소");
}

// ── ⑧ preferred 불일치 — 오류 근거가 있는 우대조건만 억제하고 자격은 유지 ──
{
  const run: LabRun = {
    runId: "run-preferred-disagreement",
    grantId: "00000000-0000-4000-8000-000000000778",
    source: "bizinfo",
    sourceId: "PBLN_PREFERRED_DISAGREEMENT",
    title: "우대조건 불일치 테스트",
    model: "claude-opus-5",
    promptVersion: "lab-deep-v9",
    startedAt: "2026-08-07T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: "1".repeat(64),
    usage: null,
    costUsd: null,
    analysisMarkdown: "",
    programIntent: null,
    criteria: [{
      dimension: "certification",
      kind: "preferred",
      operator: "exists",
      value: { certs: ["수출유망중소기업"] },
      confidence: 0.9,
      sourceSpan: "수출유망중소기업 등 해외진출 준비기업 우대",
      spanVerified: true,
      note: "예시 대상을 정확히 모두 구조화했는지 검수 필요",
    }],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    error: null,
  };
  const review: AuditedAiReviewInput = {
    grantId: run.grantId,
    runId: run.runId,
    model: "claude-fable-5",
    promptVersion: "ai-review-v7",
    criterionReviews: [{ criterionIndex: 0, verdict: "correct", note: null }],
    axisReviews: [],
  };
  const audit: LabAudit = {
    schema: "lab-audit-v1",
    grantId: run.grantId,
    runId: run.runId,
    model: review.model,
    aiPromptVersion: review.promptVersion,
    aiAuditModel: "claude-sonnet-5",
    aiAuditPromptVersion: "ai-audit-v6",
    auditorEmail: null,
    createdAt: "2026-08-07T00:01:00.000Z",
    updatedAt: "2026-08-07T00:01:00.000Z",
    items: [{
      kind: "criterion",
      criterionIndex: 0,
      reason: "correct_sample",
      aiVerdict: "correct",
      aiNote: null,
      humanVerdict: null,
      note: null,
      aiAuditVerdict: "needs_edit",
      aiAuditNote: "원문의 추가 지정기업이 certs 목록에 누락됐다.",
    }],
    overallNote: null,
  };

  assert.equal(
    isLabAuditCompleteForRun(run, audit),
    true,
    "구체적 오류가 있는 preferred 불일치는 보수적 억제로 종결한다",
  );
  const merged = mergeAuditedReview(review, audit, run);
  assert.equal(merged.review.criterionReviews[0]?.verdict, "needs_edit");
  assert.deepEqual(merged.provenance.deterministicResolvedCriterionIndexes, [0]);
  const risk = assessPromotionReviewRisk({ run, review: merged.review });
  assert.equal(risk.disposition, "conditional", "우대조건 억제는 자격 차단이 아니다");
  assert.deepEqual(risk.suppressedCriterionIndexes, [0]);
  assert.equal(risk.blockers.length, 0);

  const hardCriterionRun: LabRun = {
    ...run,
    runId: "run-required-disagreement",
    criteria: [{ ...run.criteria[0]!, kind: "required" }],
  };
  assert.equal(
    isLabAuditCompleteForRun(hardCriterionRun, { ...audit, runId: hardCriterionRun.runId }),
    false,
    "같은 불일치라도 required는 자동 해소하지 않는다",
  );
  const evidenceMissing = {
    ...audit,
    items: [{ ...audit.items[0]!, aiAuditNote: null }],
  } satisfies LabAudit;
  assert.equal(
    isLabAuditCompleteForRun(run, evidenceMissing),
    false,
    "비정확 판정에 구체적 note가 없으면 preferred도 자동 해소하지 않는다",
  );
  const unsure = {
    ...audit,
    items: [{ ...audit.items[0]!, aiAuditVerdict: "unsure" as const }],
  } satisfies LabAudit;
  assert.equal(
    isLabAuditCompleteForRun(run, unsure),
    false,
    "unsure는 근거 부족이므로 자동 해소하지 않는다",
  );
  console.log("✅ preferred 불일치 — 근거 있는 우대조건만 억제·자격 불변");
}

console.log("\naudited-reviews 테스트 전부 통과");
