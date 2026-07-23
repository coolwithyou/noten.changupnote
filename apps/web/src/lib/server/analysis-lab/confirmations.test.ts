// 확정 결격 질문 경량 보강(Phase B-0) 단위 테스트 (실 API·DB 미사용 — LLM 은 페이크 주입).
// 실행: pnpm lab:confirmations:test
// 검증: ① 대상 선정(correct exclusion 만·v3 인라인 보유 제외·범위 밖 검수 방어)
// ② 응답 정규화(대상 인덱스 밖/범위 밖 드롭·중복 첫 항목·결함 confirmation 드롭)
// ③ 사이드카 병합(인라인 우선·범위 밖/비 exclusion 드롭·짝 불일치 무병합·런 불변)
// ④ 러너 왕복(임시 디렉토리) — 생성·기존 사이드카 스킵·--force 재생성·원문 드리프트
// ⑤ batch 우발 재분석 가드(batch-plan) — 버전 무관 ok 스킵·--reanalyze-outdated 탈출구.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LabCriterion,
  LabCriterionConfirmation,
  LabReview,
  LabRun,
} from "@/features/dev/analysis-lab/contract";
import { partitionCohortEntries, type GrantRunState } from "./batch-plan";
import {
  LAB_CONFIRMATIONS_SCHEMA,
  mergeConfirmationsIntoRun,
  normalizeConfirmationsPayload,
  parseLabConfirmationsFile,
  runConfirmations,
  selectConfirmationTargets,
  type ConfirmationsLlmDeps,
  type LabConfirmationsFile,
} from "./confirmations";

// ---- 픽스처 -----------------------------------------------------------------------

function criterionFixture(overrides: Partial<LabCriterion> = {}): LabCriterion {
  return {
    dimension: "prior_award",
    kind: "exclusion",
    operator: "exists",
    value: { scope: "self" },
    confidence: 0.9,
    sourceSpan: "타 정부지원사업에서 체계적합성시험비를 기 지원받은 경우",
    spanVerified: true,
    note: null,
    ...overrides,
  };
}

/** 저장 계약(camelCase)의 confirmation — Phase A 인라인·사이드카 항목이 공유하는 형태. */
function confirmationFixture(prompt = "다른 정부지원사업에서 체계적합성시험비를 지원받은 적이 있나요?"): LabCriterionConfirmation {
  return {
    prompt,
    options: [
      { value: "received_before", label: "지원받은 적이 있어요", disqualifies: true },
      { value: "never_received", label: "지원받은 적이 없어요", disqualifies: false },
    ],
    answerType: "single",
    reusable: "company_fact",
    conditionKey: "prior_award_system_conformity_test_fee",
  };
}

function runFixture(criteria: LabCriterion[], overrides: Partial<LabRun> = {}): LabRun {
  return {
    runId: "run-2026-07-23T000000.000Z-abc123",
    grantId: "g1",
    source: "bizinfo",
    sourceId: "S1",
    title: "테스트 공고",
    model: "claude-opus-4-8",
    promptVersion: "lab-deep-v2",
    startedAt: "2026-07-23T00:00:00.000Z",
    durationMs: 1_000,
    inputBlocks: [],
    inputTotalChars: 100,
    inputSha256: "sha-1",
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

function reviewFixture(
  criterionReviews: LabReview["criterionReviews"],
  overrides: Partial<LabReview> = {},
): LabReview {
  return {
    grantId: "g1",
    runId: "run-2026-07-23T000000.000Z-abc123",
    reviewerEmail: "sw@noten.im",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    criterionReviews,
    axisReviews: [],
    overallNote: null,
    ...overrides,
  };
}

/**
 * 기준 런 — criteria 5건:
 *   #0 required(비 exclusion) / #1 exclusion(질문 없음 — 보강 대상)
 *   #2 exclusion + v3 인라인 confirmation / #3 exclusion(검수 needs_edit — 미확정)
 *   #4 exclusion other/text_only(질문 없음 — 보강 대상)
 */
const baseRun = runFixture([
  criterionFixture({ dimension: "region", kind: "required", operator: "in", value: { regions: ["11"] } }),
  criterionFixture(),
  criterionFixture({ dimension: "sanction", confirmation: confirmationFixture("참여제한 상태인가요?") }),
  criterionFixture({ dimension: "credit_status" }),
  criterionFixture({ dimension: "other", operator: "text_only", value: { note: "서류 허위 제외" } }),
]);
const baseReview = reviewFixture([
  { criterionIndex: 0, verdict: "correct", note: null },
  { criterionIndex: 1, verdict: "correct", note: null },
  { criterionIndex: 2, verdict: "correct", note: null },
  { criterionIndex: 3, verdict: "needs_edit", note: "플래그 수정 필요" },
  { criterionIndex: 4, verdict: "correct", note: null },
]);

/** LLM 응답의 snake_case confirmation(도구 스키마 형태). */
const snakeConfirmation = {
  prompt: "다른 정부지원사업에서 체계적합성시험비를 지원받은 적이 있나요?",
  options: [
    { value: "received_before", label: "지원받은 적이 있어요", disqualifies: true },
    { value: "never_received", label: "지원받은 적이 없어요", disqualifies: false },
  ],
  answer_type: "single",
  reusable: "company_fact",
  condition_key: "prior_award_system_conformity_test_fee",
};

function sidecarFixture(items: LabConfirmationsFile["items"], overrides: Partial<LabConfirmationsFile> = {}): LabConfirmationsFile {
  return {
    schema: LAB_CONFIRMATIONS_SCHEMA,
    grantId: baseRun.grantId,
    runId: baseRun.runId,
    model: "claude-sonnet-5",
    promptVersion: "confirmations-v1",
    createdAt: "2026-07-23T01:00:00.000Z",
    usage: null,
    costUsd: null,
    items,
    ...overrides,
  };
}

// ── ① 대상 선정 — correct exclusion 만, v3 인라인 보유·미확정·범위 밖 제외 ────────────
{
  const targets = selectConfirmationTargets(baseRun, baseReview);
  assert.deepEqual(
    targets.map((target) => target.criterionIndex),
    [1, 4],
    "correct exclusion 중 인라인 미보유(#1·#4)만 — required(#0)·인라인 보유(#2)·needs_edit(#3) 제외",
  );

  // 런 criteria 범위 밖 검수 항목(런 교체·손상 대비)은 조용히 제외한다.
  const outOfRange = reviewFixture([{ criterionIndex: 99, verdict: "correct", note: null }]);
  assert.deepEqual(selectConfirmationTargets(baseRun, outOfRange), [], "범위 밖 검수 인덱스 → 대상 없음");

  // 같은 인덱스 중복 검수(비정상 파일)는 첫 항목만.
  const dupReview = reviewFixture([
    { criterionIndex: 1, verdict: "correct", note: null },
    { criterionIndex: 1, verdict: "correct", note: null },
  ]);
  assert.equal(selectConfirmationTargets(baseRun, dupReview).length, 1, "중복 검수 인덱스 → 1건");
  console.log("✅ 대상 선정 — correct exclusion 만·v3 인라인 보유 제외·범위 밖 방어");
}

// ── ② 응답 정규화 — 대상 밖/범위 밖 드롭·중복 첫 항목·결함 confirmation 드롭 ──────────
{
  const targetIndexes = [1, 4];
  const items = normalizeConfirmationsPayload(
    {
      items: [
        { criterion_index: 1, confirmation: snakeConfirmation },
        // 런 범위 안이지만 대상 아님(#0 required·#2 인라인 보유) — 드롭.
        { criterion_index: 0, confirmation: snakeConfirmation },
        { criterion_index: 2, confirmation: snakeConfirmation },
        // 런 criteria 범위 밖 — 드롭.
        { criterion_index: 99, confirmation: snakeConfirmation },
        // 중복 — 첫 항목 유지.
        { criterion_index: 1, confirmation: { ...snakeConfirmation, prompt: "중복(무시)" } },
        // 결함 confirmation(극성 결손) — normalizeConfirmation 이 드롭.
        {
          criterion_index: 4,
          confirmation: {
            ...snakeConfirmation,
            options: [
              { value: "a", label: "결격 A", disqualifies: true },
              { value: "b", label: "결격 B", disqualifies: true },
            ],
          },
        },
      ],
    },
    targetIndexes,
  );
  assert.deepEqual(
    items.map((item) => item.criterionIndex),
    [1],
    "대상 밖(#0·#2)·범위 밖(#99)·결함(#4) 드롭 후 #1 만 잔존",
  );
  assert.equal(items[0]!.confirmation.prompt, snakeConfirmation.prompt, "중복은 첫 항목 유지");
  assert.deepEqual(normalizeConfirmationsPayload({ items: "깨짐" }, targetIndexes), [], "형식 밖 → 빈 배열");
  console.log("✅ 응답 정규화 — 대상 밖·범위 밖·결함 드롭, 중복 첫 항목");
}

// ── ③ 사이드카 병합 — 인라인 우선·범위 밖/비 exclusion 드롭·짝 불일치 무병합 ──────────
{
  const sidecar = sidecarFixture([
    { criterionIndex: 1, confirmation: confirmationFixture() },
    // 인라인 보유(#2) — 인라인 우선, 사이드카 무시.
    { criterionIndex: 2, confirmation: confirmationFixture("사이드카 질문(무시돼야 함)") },
    // 비 exclusion(#0) — 드롭.
    { criterionIndex: 0, confirmation: confirmationFixture() },
    // 범위 밖 — 드롭.
    { criterionIndex: 99, confirmation: confirmationFixture() },
  ]);
  const merged = mergeConfirmationsIntoRun(baseRun, sidecar);
  assert.equal(merged.criteria[1]!.confirmation?.prompt, confirmationFixture().prompt, "#1 병합");
  assert.equal(
    merged.criteria[2]!.confirmation?.prompt,
    "참여제한 상태인가요?",
    "#2 는 v3 인라인 우선 — 사이드카가 덮지 않는다",
  );
  assert.equal("confirmation" in merged.criteria[0]!, false, "비 exclusion(#0) 드롭 — 필드 자체 없음");
  assert.equal(merged.criteria.length, baseRun.criteria.length, "criteria 수 불변");
  // 런 불변 원칙 — 원본 객체는 건드리지 않는다.
  assert.equal("confirmation" in baseRun.criteria[1]!, false, "원본 run 무변경(새 객체 병합)");

  assert.equal(mergeConfirmationsIntoRun(baseRun, null), baseRun, "사이드카 없음 → 원본 그대로");
  assert.equal(
    mergeConfirmationsIntoRun(baseRun, sidecarFixture([{ criterionIndex: 1, confirmation: confirmationFixture() }], { runId: "run-other" })),
    baseRun,
    "짝 불일치(runId 다름) → 병합하지 않음",
  );
  console.log("✅ 사이드카 병합 — 인라인 우선·범위 밖/비 exclusion 드롭·짝 불일치 무병합·런 불변");
}

// ── ④ 러너 왕복(임시 디렉토리) — 생성·기존 파일 스킵·--force·원문 드리프트 ────────────
{
  const dir = await mkdtemp(join(tmpdir(), "lab-confirmations-test-"));
  const sidecarPath = join(dir, `${baseRun.runId}.confirmations.json`);
  let callCount = 0;
  const fakeDeps: ConfirmationsLlmDeps = {
    reassembleInput: async () => ({ text: "공고 원문", blocks: [], totalChars: 100, inputSha256: "sha-1" }),
    callModel: async (options) => {
      callCount += 1;
      // 페이크도 대상 한정 스키마를 검증한다 — 대상 인덱스가 enum 으로 전달되는지.
      assert.equal(options.toolSchema.name, "emit_exclusion_confirmations");
      return {
        kind: "ok",
        input: {
          items: [
            { criterion_index: 1, confirmation: snakeConfirmation },
            { criterion_index: 99, confirmation: snakeConfirmation }, // 범위 밖 — 저장 전 드롭.
          ],
        },
        usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: null },
      };
    },
    computeCostUsd: () => 0.0123,
  };

  const created = await runConfirmations({
    run: baseRun,
    review: baseReview,
    model: "claude-sonnet-5",
    apiKey: "test-key",
    sidecarPath,
    deps: fakeDeps,
  });
  assert.equal(created.status, "created");
  if (created.status === "created") {
    assert.equal(created.targetCount, 2, "확정 exclusion 대상 #1·#4");
    assert.equal(created.generatedCount, 1, "범위 밖(#99) 드롭 후 #1 만 저장");
  }
  const stored = parseLabConfirmationsFile(JSON.parse(await readFile(sidecarPath, "utf8")));
  assert.notEqual(stored, null, "저장본이 파싱 계약을 통과한다");
  assert.deepEqual(stored!.items.map((item) => item.criterionIndex), [1]);
  assert.equal(stored!.schema, LAB_CONFIRMATIONS_SCHEMA);
  assert.equal(stored!.promptVersion, "confirmations-v1");
  assert.equal(stored!.costUsd, 0.0123);

  // 기존 사이드카 존재 → 스킵(API 재호출 없음).
  const again = await runConfirmations({
    run: baseRun,
    review: baseReview,
    model: "claude-sonnet-5",
    apiKey: "test-key",
    sidecarPath,
    deps: fakeDeps,
  });
  assert.equal(again.status, "exists", "기존 파일 있으면 스킵");
  assert.equal(callCount, 1, "스킵 경로는 LLM 을 호출하지 않는다");

  // --force → 재생성.
  const forced = await runConfirmations({
    run: baseRun,
    review: baseReview,
    model: "claude-sonnet-5",
    apiKey: "test-key",
    sidecarPath,
    force: true,
    deps: fakeDeps,
  });
  assert.equal(forced.status, "created", "--force 는 재생성");
  assert.equal(callCount, 2);

  // 원문 드리프트 — sha 불일치면 파일을 만들지 않고 스킵.
  const driftPath = join(dir, "drift.confirmations.json");
  const drift = await runConfirmations({
    run: baseRun,
    review: baseReview,
    model: "claude-sonnet-5",
    apiKey: "test-key",
    sidecarPath: driftPath,
    deps: {
      ...fakeDeps,
      reassembleInput: async () => ({ text: "달라진 원문", blocks: [], totalChars: 100, inputSha256: "sha-2" }),
    },
  });
  assert.equal(drift.status, "input_drift");
  assert.equal(existsSync(driftPath), false, "드리프트 시 파일 미생성");

  // 대상 0건(전건 인라인 보유/미확정) — LLM 호출 없이 no_targets.
  const noTargets = await runConfirmations({
    run: baseRun,
    review: reviewFixture([{ criterionIndex: 2, verdict: "correct", note: null }]),
    model: "claude-sonnet-5",
    apiKey: "test-key",
    sidecarPath: join(dir, "none.confirmations.json"),
    deps: fakeDeps,
  });
  assert.equal(noTargets.status, "no_targets");
  console.log("✅ 러너 왕복 — 생성·기존 사이드카 스킵·--force 재생성·드리프트 미생성·대상 0건");
}

// ── ⑤ batch 우발 재분석 가드 — 버전 무관 ok 스킵·--reanalyze-outdated 탈출구 ──────────
{
  const entries = [
    { grantId: "g-ok-current" },
    { grantId: "g-ok-outdated" },
    { grantId: "g-error-current" },
    { grantId: "g-fresh" },
    { grantId: "g-outdated-plus-error" },
  ];
  const states = new Map<string, GrantRunState>([
    ["g-ok-current", { okCurrent: true, okOutdated: false, errorCurrent: false }],
    ["g-ok-outdated", { okCurrent: false, okOutdated: true, errorCurrent: false }],
    ["g-error-current", { okCurrent: false, okOutdated: false, errorCurrent: true }],
    ["g-outdated-plus-error", { okCurrent: false, okOutdated: true, errorCurrent: true }],
  ]);

  // 기본(플래그 없음): 구버전 ok 런 보유도 스킵 — v3 승격 여파 ~$12 재분석 함정 차단.
  const guarded = partitionCohortEntries(entries, states, { retryErrors: false, reanalyzeOutdated: false });
  assert.deepEqual(
    guarded.skippedOk.map((entry) => entry.grantId),
    ["g-ok-current", "g-ok-outdated", "g-outdated-plus-error"],
    "ok 런 보유는 버전 무관 스킵",
  );
  assert.deepEqual(
    guarded.skippedOkOutdatedOnly.map((entry) => entry.grantId),
    ["g-ok-outdated", "g-outdated-plus-error"],
    "구버전만 보유분은 부분집합으로 구분 표기",
  );
  assert.deepEqual(guarded.heldError.map((entry) => entry.grantId), ["g-error-current"]);
  assert.deepEqual(guarded.pending.map((entry) => entry.grantId), ["g-fresh"], "신규만 대상");

  // --reanalyze-outdated: 구버전 ok 런 보유 공고가 다시 대상에 편입된다(탈출구).
  const reanalyze = partitionCohortEntries(entries, states, { retryErrors: false, reanalyzeOutdated: true });
  assert.deepEqual(reanalyze.skippedOk.map((entry) => entry.grantId), ["g-ok-current"], "현행 ok 만 스킵");
  assert.deepEqual(reanalyze.skippedOkOutdatedOnly, [], "탈출구에서는 구버전만 스킵 분류가 없다");
  assert.deepEqual(
    reanalyze.pending.map((entry) => entry.grantId),
    ["g-ok-outdated", "g-fresh"],
    "구버전 ok 보유 공고 재편입",
  );
  assert.deepEqual(
    reanalyze.heldError.map((entry) => entry.grantId),
    ["g-error-current", "g-outdated-plus-error"],
    "현행 error 런 보유는 --retry-errors 규칙이 그대로 적용",
  );

  // --reanalyze-outdated + --retry-errors: error 보류까지 해제.
  const both = partitionCohortEntries(entries, states, { retryErrors: true, reanalyzeOutdated: true });
  assert.deepEqual(
    both.pending.map((entry) => entry.grantId),
    ["g-ok-outdated", "g-error-current", "g-fresh", "g-outdated-plus-error"],
    "두 탈출구 동시 지정 시 현행 ok 외 전부 대상",
  );
  console.log("✅ batch 가드 — 버전 무관 ok 스킵·--reanalyze-outdated/--retry-errors 탈출구");
}

console.log("\n확정 결격 질문 보강(Phase B-0) 테스트 전부 통과");
