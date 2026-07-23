// 승격 파이프라인(Phase B-4) 계획 수립 단위 테스트 (실 DB 쓰기·네트워크 미사용 — 쓰기는 페이크 포트).
// 실행: pnpm lab:promote:test
// 검증: ① 대상 dedupe(사람 우선·grantId 정렬) ② correct 만 편입 + 변환 드롭 무은폐 +
// criterionIndex 매핑(드롭 후 위치 이동 안전) ③ 질문 연결(인라인 우선·사이드카 보강·범위 밖
// 드롭·앵커 상실 집계) ④ provenance/auditState 판별 + sourceSpanHash 정규화
// ⑤ 발행 가드(답변 보존·계약 실패·빈 발행) ⑥ 실행 모드 게이트(--write --confirm-go 동시 요구)
// ⑦ 쓰기 오케스트레이션(페이크 포트 — per-grant 격리).
import assert from "node:assert/strict";
import type { CriterionDimension } from "@cunote/contracts";
import type {
  LabCriterion,
  LabCriterionConfirmation,
  LabReview,
  LabRun,
} from "@/features/dev/analysis-lab/contract";
import { LAB_CONFIRMATIONS_SCHEMA, type LabConfirmationsFile } from "./confirmations";
import {
  applyPublishGuards,
  dedupePromotionSources,
  executePromotionWrites,
  planGrantPromotion,
  resolvePromotionMode,
  sourceSpanHash,
  type GrantPromotionPlan,
  type PromotionGrantWriteResult,
} from "./promote";

// ---- 픽스처 (shadow-convert.test / confirmations.test 관행) ---------------------------

function criterion(
  input: Partial<LabCriterion> & Pick<LabCriterion, "dimension" | "kind" | "operator" | "value">,
): LabCriterion {
  return {
    confidence: 0.9,
    sourceSpan: null,
    spanVerified: false,
    note: null,
    ...input,
  };
}

function confirmation(prompt: string, conditionKey: string | null = null): LabCriterionConfirmation {
  return {
    prompt,
    options: [
      { value: "yes", label: "해당돼요", disqualifies: true },
      { value: "no", label: "해당되지 않아요", disqualifies: false },
    ],
    answerType: "single",
    reusable: conditionKey ? "company_fact" : "per_notice",
    conditionKey,
  };
}

function fixtureRun(criteria: LabCriterion[], overrides: Partial<LabRun> = {}): LabRun {
  return {
    runId: "run-2026-07-23T000000.000Z-b4test",
    grantId: "00000000-0000-4000-8000-0000000000b4",
    source: "bizinfo",
    sourceId: "PBLN_B4_1",
    title: "승격 테스트 공고",
    model: "claude-opus-4-8",
    promptVersion: "lab-deep-v3",
    startedAt: "2026-07-23T00:00:00.000Z",
    durationMs: 1000,
    inputBlocks: [],
    inputTotalChars: 1000,
    inputSha256: "0".repeat(64),
    usage: null,
    costUsd: null,
    analysisMarkdown: "",
    programIntent: null,
    criteria,
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    error: null,
    ...overrides,
  };
}

function fixtureReview(
  criterionReviews: LabReview["criterionReviews"],
  overrides: Partial<LabReview> = {},
): LabReview {
  return {
    grantId: "00000000-0000-4000-8000-0000000000b4",
    runId: "run-2026-07-23T000000.000Z-b4test",
    reviewerEmail: "sw@noten.im",
    createdAt: "2026-07-23T01:00:00.000Z",
    updatedAt: "2026-07-23T01:00:00.000Z",
    criterionReviews,
    axisReviews: [],
    overallNote: null,
    ...overrides,
  };
}

function fixtureSidecar(
  items: LabConfirmationsFile["items"],
  overrides: Partial<LabConfirmationsFile> = {},
): LabConfirmationsFile {
  return {
    schema: LAB_CONFIRMATIONS_SCHEMA,
    grantId: "00000000-0000-4000-8000-0000000000b4",
    runId: "run-2026-07-23T000000.000Z-b4test",
    model: "claude-sonnet-5",
    promptVersion: "confirmations-v1",
    createdAt: "2026-07-23T02:00:00.000Z",
    usage: null,
    costUsd: null,
    items,
    ...overrides,
  };
}

// ---- ① 대상 dedupe — 사람 우선·grantId 정렬 -------------------------------------------

{
  const humanRun = fixtureRun([], { grantId: "g-b", runId: "run-human" });
  const auditedSameGrant = fixtureRun([], { grantId: "g-b", runId: "run-audited-dup" });
  const auditedOnly = fixtureRun([], { grantId: "g-a", runId: "run-audited-only" });
  const sources = dedupePromotionSources(
    [{ run: humanRun, review: fixtureReview([], { grantId: "g-b", runId: "run-human" }) }],
    [
      { run: auditedSameGrant, review: fixtureReview([], { grantId: "g-b", runId: "run-audited-dup" }) },
      { run: auditedOnly, review: fixtureReview([], { grantId: "g-a", runId: "run-audited-only" }) },
    ],
  );
  assert.equal(sources.length, 2, "grantId 중복은 1건으로 dedupe 돼야 한다");
  assert.deepEqual(
    sources.map((source) => [source.run.grantId, source.origin, source.run.runId]),
    [
      ["g-a", "audited", "run-audited-only"],
      ["g-b", "human", "run-human"],
    ],
    "같은 공고는 사람 검수 우선, 출력은 grantId 정렬이어야 한다",
  );
}

// ---- ②③④ 승격 계획 — 기준 시나리오 ---------------------------------------------------
// criteria 5건: #0 required(질문 비대상) / #1 exclusion(사이드카 보강 대상)
// #2 exclusion + v3 인라인(사이드카와 충돌 — 인라인 우선) / #3 exclusion needs_edit(미편입)
// #4 required wrong(미편입). 사이드카에는 범위 밖(#99) 항목도 섞는다.

const baseRun = fixtureRun([
  criterion({
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["서울특별시"] },
    sourceSpan: "서울 소재 기업",
    spanVerified: true,
  }),
  criterion({
    dimension: "prior_award",
    kind: "exclusion",
    operator: "exists",
    value: { scope: "self", self_kind: "current_similar", channel: "general" },
    sourceSpan: "타 정부지원사업에서 기 지원받은 경우",
    spanVerified: true,
  }),
  criterion({
    dimension: "sanction",
    kind: "exclusion",
    operator: "exists",
    value: { flags: ["participation_restricted"] },
    sourceSpan: "참여제한 중인 기업 제외",
    spanVerified: true,
    confirmation: confirmation("현재 정부지원사업 참여제한 상태인가요?", "sanction_participation_restricted"),
  }),
  criterion({
    dimension: "credit_status",
    kind: "exclusion",
    operator: "exists",
    value: { flags: ["default_on_debt"] },
    sourceSpan: "채무불이행 기업 제외",
  }),
  criterion({
    dimension: "employees",
    kind: "required",
    operator: "gte",
    value: { min: 5 },
    sourceSpan: "상시근로자 5인 이상",
  }),
]);
const baseReview = fixtureReview([
  { criterionIndex: 0, verdict: "correct", note: null },
  { criterionIndex: 1, verdict: "correct", note: null },
  { criterionIndex: 2, verdict: "correct", note: null },
  { criterionIndex: 3, verdict: "needs_edit", note: "값 재확인" },
  { criterionIndex: 4, verdict: "wrong", note: "원문에 없음" },
]);
const baseSidecar = fixtureSidecar([
  { criterionIndex: 1, confirmation: confirmation("타 정부지원사업에서 지원받은 적이 있나요?", "prior_award_general") },
  { criterionIndex: 2, confirmation: confirmation("사이드카 충돌 질문 — 채택되면 안 된다") },
  { criterionIndex: 99, confirmation: confirmation("범위 밖 — 드롭돼야 한다") },
]);

{
  const plan = planGrantPromotion({ run: baseRun, review: baseReview, origin: "human", sidecar: baseSidecar });

  // ② correct 만 편입 — needs_edit/wrong 은 발행에서 제외, verdict 집계는 무은폐.
  assert.equal(plan.criteria.length, 3, "correct 3건만 발행돼야 한다");
  assert.deepEqual(plan.conversion.verdicts, { correct: 3, needs_edit: 1, wrong: 1, unsure: 0 });
  assert.equal(plan.conversion.dropped, 0);
  assert.deepEqual(plan.criterionIndexByPosition, [0, 1, 2], "발행 위치 → 런 criterionIndex 매핑");
  assert.deepEqual(
    plan.criteria.map((item) => item.dimension),
    ["region", "prior_award", "sanction"],
  );

  // ③ 질문 연결 — 발행 exclusion 중 confirmation 보유분만: #1(사이드카)·#2(인라인 우선).
  assert.equal(plan.questions.length, 2, "required(#0)와 미확정(#3)에는 질문이 없어야 한다");
  const [q1, q2] = plan.questions;
  assert.ok(q1 && q2);
  assert.equal(q1.criterionIndex, 1);
  assert.equal(q1.criteriaPosition, 1);
  assert.equal(q1.inline, false);
  assert.equal(q1.promptVer, "confirmations-v1", "사이드카 질문은 confirmations-v1 이어야 한다");
  assert.equal(q1.prompt, "타 정부지원사업에서 지원받은 적이 있나요?");
  assert.equal(q1.conditionKey, "prior_award_general");
  assert.equal(q2.criterionIndex, 2);
  assert.equal(q2.inline, true);
  assert.equal(q2.promptVer, "lab-deep-v3", "인라인 질문은 런의 promptVersion 이어야 한다");
  assert.equal(q2.prompt, "현재 정부지원사업 참여제한 상태인가요?", "인라인이 사이드카 충돌 항목보다 우선해야 한다");
  assert.equal(plan.droppedQuestionCandidates, 0);

  // ④ provenance/criterionRef — 발행 criterion 기준 + 정규화 span 해시.
  assert.deepEqual(q1.provenance, {
    runId: baseRun.runId,
    auditState: "human_reviewed",
    criterionIndex: 1,
  });
  assert.deepEqual(q1.criterionRef, {
    dimension: "prior_award",
    kind: "exclusion",
    sourceSpanHash: sourceSpanHash("타 정부지원사업에서 기 지원받은 경우"),
  });
  assert.equal(plan.auditState, "human_reviewed");

  // 감사 병합 출처는 ai_audit_concur 로 기록된다.
  const auditedPlan = planGrantPromotion({ run: baseRun, review: baseReview, origin: "audited", sidecar: baseSidecar });
  assert.equal(auditedPlan.auditState, "ai_audit_concur");
  assert.equal(auditedPlan.questions[0]?.provenance.auditState, "ai_audit_concur");
}

// ---- ② 변환 드롭 무은폐 + 매핑의 위치 이동 안전 ---------------------------------------
// #0 은 비정상 dimension 으로 normalize 가 탈락시킨다(질문 후보였으므로 앵커 상실도 집계).

{
  const dropRun = fixtureRun([
    criterion({
      dimension: "not_a_dimension" as CriterionDimension,
      kind: "exclusion",
      operator: "exists",
      value: {},
      sourceSpan: "가짜 축",
      confirmation: confirmation("탈락 앵커 질문 — 발행되면 안 된다"),
    }),
    criterion({
      dimension: "prior_award",
      kind: "exclusion",
      operator: "exists",
      value: { scope: "self", self_kind: "current_similar", channel: "general" },
      sourceSpan: "기 지원받은 경우 제외",
      confirmation: confirmation("지원받은 적이 있나요?"),
    }),
  ]);
  const dropReview = fixtureReview([
    { criterionIndex: 0, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "correct", note: null },
  ]);
  const plan = planGrantPromotion({ run: dropRun, review: dropReview, origin: "human", sidecar: null });
  assert.equal(plan.conversion.dropped, 1, "탈락은 은폐되지 않아야 한다");
  assert.equal(plan.criteria.length, 1);
  assert.deepEqual(
    plan.criterionIndexByPosition,
    [1],
    "앞 row 가 탈락해도 남은 발행분은 원래 criterionIndex 로 역산돼야 한다(id llm-<n> 계약)",
  );
  assert.equal(plan.questions.length, 1);
  assert.equal(plan.questions[0]?.criterionIndex, 1);
  assert.equal(plan.questions[0]?.criteriaPosition, 0, "발행 배열 기준 위치여야 한다(삽입 연결 키)");
  assert.equal(plan.droppedQuestionCandidates, 1, "탈락 criterion 의 질문 후보는 앵커 상실로 집계돼야 한다");
}

// ---- sourceSpanHash — 정규화(NFC·공백 접기) ------------------------------------------

{
  const hash = sourceSpanHash("타 정부지원사업 지원");
  assert.ok(hash && /^[0-9a-f]{64}$/.test(hash));
  assert.equal(sourceSpanHash("타  정부지원사업\n  지원"), hash, "공백 나열·개행 차이는 같은 해시여야 한다");
  assert.notEqual(sourceSpanHash("다른 인용"), hash);
  assert.equal(sourceSpanHash(null), null);
  assert.equal(sourceSpanHash("   "), null, "공백뿐인 span 은 해시를 위장하지 않는다");
}

// ---- ⑤ 발행 가드 — 답변 보존(우선)·계약 실패·빈 발행 ----------------------------------

{
  const okPlan = planGrantPromotion({ run: baseRun, review: baseReview, origin: "human", sidecar: baseSidecar });
  const answeredPlan: GrantPromotionPlan = { ...okPlan, grantId: "g-answered" };
  const errorPlan: GrantPromotionPlan = {
    ...okPlan,
    grantId: "g-error",
    criteria: [],
    conversion: { ...okPlan.conversion, error: "assertGrantCriteriaContract 실패" },
  };
  const emptyPlan: GrantPromotionPlan = {
    ...okPlan,
    grantId: "g-empty",
    criteria: [],
    conversion: { ...okPlan.conversion, converted: 0 },
  };
  const guarded = applyPublishGuards(
    [okPlan, answeredPlan, errorPlan, emptyPlan],
    new Map([["g-answered", 3]]),
  );
  assert.deepEqual(guarded.publishable.map((plan) => plan.grantId), [okPlan.grantId]);
  assert.deepEqual(
    guarded.refused.map((item) => [item.plan.grantId, item.reason]),
    [
      ["g-answered", "answers_exist"],
      ["g-error", "conversion_error"],
      ["g-empty", "empty_criteria"],
    ],
  );
  assert.match(guarded.refused[0]!.detail, /답변 3건/);

  // 답변 가드는 다른 결함보다 우선한다(cascade 사고가 최우선 방어 대상).
  const both = applyPublishGuards([errorPlan], new Map([["g-error", 1]]));
  assert.equal(both.refused[0]?.reason, "answers_exist");
}

// ---- ⑥ 실행 모드 게이트 — 두 플래그 동시 요구 -----------------------------------------

{
  assert.deepEqual(resolvePromotionMode({ write: false, confirmGo: false }), { write: false, warning: null });
  const writeOnly = resolvePromotionMode({ write: true, confirmGo: false });
  assert.equal(writeOnly.write, false, "--write 단독은 실쓰기가 열리면 안 된다");
  assert.match(writeOnly.warning ?? "", /--confirm-go/);
  assert.match(writeOnly.warning ?? "", /aggregate GO/);
  const confirmOnly = resolvePromotionMode({ write: false, confirmGo: true });
  assert.equal(confirmOnly.write, false, "--confirm-go 단독도 실쓰기가 열리면 안 된다");
  assert.match(confirmOnly.warning ?? "", /--write/);
  assert.deepEqual(resolvePromotionMode({ write: true, confirmGo: true }), { write: true, warning: null });
}

// ---- ⑦ 쓰기 오케스트레이션 — 페이크 포트, per-grant 격리 ------------------------------

{
  const okPlan = planGrantPromotion({ run: baseRun, review: baseReview, origin: "human", sidecar: baseSidecar });
  const planA: GrantPromotionPlan = { ...okPlan, grantId: "g-1" };
  const planB: GrantPromotionPlan = { ...okPlan, grantId: "g-2" };
  const planC: GrantPromotionPlan = { ...okPlan, grantId: "g-3" };
  const published: string[] = [];
  const fakeResult: PromotionGrantWriteResult = {
    criteriaDeleted: 2,
    criteriaInserted: 3,
    questionsDeleted: 0,
    questionsInserted: 2,
    matchStatesDeleted: 5,
  };
  const outcomes = await executePromotionWrites([planA, planB, planC], {
    async publishGrant(plan) {
      if (plan.grantId === "g-2") throw new Error("트랜잭션 실패(모의)");
      published.push(plan.grantId);
      return fakeResult;
    },
  });
  assert.deepEqual(published, ["g-1", "g-3"], "실패 공고 이후의 발행도 계속돼야 한다(격리)");
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.plan.grantId, outcome.error === null]),
    [
      ["g-1", true],
      ["g-2", false],
      ["g-3", true],
    ],
  );
  assert.equal(outcomes[0]?.result, fakeResult);
  assert.match(outcomes[1]?.error ?? "", /모의/);
}

console.log("promote tests: ok");
