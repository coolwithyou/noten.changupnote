// 배치 러너 코어 단위 테스트 (실 API/CLI/DB/파일 무접촉 — deps 주입점 전면 페이크).
// 실행: pnpm lab:batch-runner:test
// 검증: ① plan 이벤트 정확성(partitionCohortEntries 결과와 일치·기간 스킵·예상 비용)
// ② 비용 상한 → guard-stop(cost-cap) + 신규 착수 중단 ③ 윈도 소진 마커 → guard-stop(window-exhausted)
// ④ abort → stopReason aborted + 진행분 완료 ⑤ transport/model/roundtrip 오버라이드의 runLabAnalysis 전달
// ⑥ 대상 0건 → 분석 무호출 finished ⑦ 오버라이드 오타 fail-fast(이벤트 무방출).
import assert from "node:assert/strict";
import { partitionCohortEntries, type GrantRunState } from "./batch-plan";
import {
  FALLBACK_COST_PER_GRANT_USD,
  runLabBatch,
  type LabBatchAnalysisImpl,
  type LabBatchEvent,
  type LabBatchPeriodSkipStatus,
  type LabBatchRunResult,
  type LabBatchRunnerDeps,
  type LabBatchRunnerOptions,
} from "./batch-runner";
import { CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER } from "./claude-cli-transport";
import type { CohortEntry, CohortFileV2 } from "./cohort-file";

// ---- 픽스처 헬퍼 ---------------------------------------------------------------

function makeCohort(entries: CohortEntry[]): CohortFileV2 {
  return {
    version: 2,
    selectedAt: "2026-08-03T00:00:00.000Z",
    seed: 1,
    experimentLabel: "runner-test",
    entries,
  };
}

function entry(grantId: string, stratum = "bizinfo/thick"): CohortEntry {
  return { grantId, stratum };
}

function okResult(title: string, costUsd: number | null): LabBatchRunResult {
  return { title, costUsd, error: null };
}

function errorResult(title: string, message: string): LabBatchRunResult {
  return { title, costUsd: null, error: message };
}

/** deps 조립 — 미지정 필드는 "빈 상태"(런 없음·기간 전원 통과) 페이크. */
function makeDeps(config: {
  entries: CohortEntry[];
  states?: Map<string, GrantRunState>;
  okCostSamples?: number[];
  /** grantId → 기간 정책 위반 상태. 미지정/undefined 반환이면 runnable. */
  periodStatus?: (grantId: string) => LabBatchPeriodSkipStatus | undefined;
  run: LabBatchAnalysisImpl;
}): LabBatchRunnerDeps {
  return {
    readCohortImpl: async () => makeCohort(config.entries),
    scanRunsImpl: async () => ({
      states: config.states ?? new Map(),
      okCostSamples: config.okCostSamples ?? [],
    }),
    splitPeriodImpl: async (pending) => {
      const runnable: CohortEntry[] = [];
      const skipped: Array<{ entry: CohortEntry; status: LabBatchPeriodSkipStatus }> = [];
      for (const candidate of pending) {
        const status = config.periodStatus?.(candidate.grantId);
        if (status === undefined) runnable.push(candidate);
        else skipped.push({ entry: candidate, status });
      }
      return { runnable, skipped };
    },
    runAnalysisImpl: config.run,
  };
}

function baseOptions(
  events: LabBatchEvent[],
  overrides: Partial<LabBatchRunnerOptions> = {},
): LabBatchRunnerOptions {
  return {
    limit: 10,
    concurrency: 1,
    maxCostUsd: 100,
    retryErrors: false,
    reanalyzeOutdated: false,
    onEvent: (event) => events.push(event),
    ...overrides,
  };
}

function eventTypes(events: LabBatchEvent[]): string[] {
  return events.map((event) => event.type);
}

function planOf(events: LabBatchEvent[]): Extract<LabBatchEvent, { type: "plan" }> {
  const plan = events.find((event) => event.type === "plan");
  assert.ok(plan && plan.type === "plan", "plan 이벤트 존재");
  return plan;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---- ① plan 이벤트 정확성 -----------------------------------------------------
{
  // g1: 현행 ok(스킵) · g2: 구버전 ok만(스킵+구버전만) · g3: 현행 error(보류)
  // g4: 기간 마감(스킵) · g5: 대상.
  const entries = [entry("g1"), entry("g2"), entry("g3"), entry("g4", "kstartup/thin"), entry("g5")];
  const states = new Map<string, GrantRunState>([
    ["g1", { okCurrent: true, okOutdated: false, errorCurrent: false }],
    ["g2", { okCurrent: false, okOutdated: true, errorCurrent: false }],
    ["g3", { okCurrent: false, okOutdated: false, errorCurrent: true }],
  ]);
  const analyzed: string[] = [];
  const events: LabBatchEvent[] = [];
  const summary = await runLabBatch(
    baseOptions(events),
    makeDeps({
      entries,
      states,
      okCostSamples: [0.4, 0.6],
      periodStatus: (grantId) => (grantId === "g4" ? "closed" : undefined),
      run: async (grantId) => {
        analyzed.push(grantId);
        return okResult(`공고 ${grantId}`, 0.5);
      },
    }),
  );

  // 분할 결과는 batch-plan 순수 로직과 반드시 일치해야 한다(러너가 규칙을 복제하지 않음).
  const expected = partitionCohortEntries(entries, states, {
    retryErrors: false,
    reanalyzeOutdated: false,
  });
  const plan = planOf(events);
  assert.equal(plan.cohortLabel, "runner-test");
  assert.equal(plan.total, 5);
  assert.equal(plan.skippedOk, expected.skippedOk.length); // 2 (g1, g2)
  assert.equal(plan.skippedOk, 2);
  assert.equal(plan.skippedOkOutdatedOnly, expected.skippedOkOutdatedOnly.length); // 1 (g2)
  assert.equal(plan.heldError, expected.heldError.length); // 1 (g3)
  assert.equal(plan.periodSkipped, 1);
  assert.deepEqual(plan.periodSkippedEntries, [
    { grantId: "g4", stratum: "kstartup/thin", status: "closed" },
  ]);
  assert.equal(plan.runnable, 1, "pending(g4,g5) − 기간 스킵(g4) = 1");
  assert.equal(plan.targets, 1);
  assert.equal(plan.estimatedCostPerGrantUsd, 0.5, "ok 런 표본 [0.4, 0.6] 평균");
  assert.equal(plan.costSampleCount, 2);
  assert.equal(plan.estimatedCostUsd, 0.5);
  assert.deepEqual(analyzed, ["g5"], "스킵·보류·기간 스킵 공고는 착수하지 않는다");
  assert.deepEqual(eventTypes(events), ["plan", "target-started", "target-ok", "finished"]);
  assert.deepEqual(summary, {
    ok: 1,
    errorRuns: 0,
    unsavedFailures: 0,
    notStarted: 0,
    skippedOk: 2,
    skippedOkOutdatedOnly: 1,
    heldError: 1,
    periodSkipped: 1,
    totalCostUsd: 0.5,
    durationMs: summary.durationMs,
    stopReason: "completed",
  });
  console.log("✅ plan 이벤트 — partitionCohortEntries 일치·기간 스킵 상세·예상 비용 근거");
}

// ---- ①-보강: 표본 없음 → 파일럿 실측 기본값, limit 적용 -----------------------
{
  const events: LabBatchEvent[] = [];
  await runLabBatch(
    baseOptions(events, { limit: 2 }),
    makeDeps({
      entries: [entry("h1"), entry("h2"), entry("h3")],
      run: async (grantId) => okResult(grantId, 0.1),
    }),
  );
  const plan = planOf(events);
  assert.equal(plan.estimatedCostPerGrantUsd, FALLBACK_COST_PER_GRANT_USD);
  assert.equal(plan.costSampleCount, 0);
  assert.equal(plan.runnable, 3);
  assert.equal(plan.targets, 2, "limit=2 슬라이스");
  assert.equal(plan.estimatedCostUsd, FALLBACK_COST_PER_GRANT_USD * 2);
  console.log("✅ plan 이벤트 — 표본 없음 파일럿 기본값·limit 슬라이스");
}

// ---- ② 비용 상한 → guard-stop(cost-cap) + 신규 착수 중단 -----------------------
{
  const analyzed: string[] = [];
  const events: LabBatchEvent[] = [];
  const summary = await runLabBatch(
    baseOptions(events, { maxCostUsd: 5 }),
    makeDeps({
      entries: [entry("c1"), entry("c2"), entry("c3")],
      run: async (grantId) => {
        analyzed.push(grantId);
        return okResult(`공고 ${grantId}`, 3);
      },
    }),
  );
  assert.deepEqual(analyzed, ["c1", "c2"], "누적 $6 ≥ 상한 $5 — c3 은 착수하지 않는다");
  assert.deepEqual(eventTypes(events), [
    "plan",
    "target-started",
    "target-ok",
    "target-started",
    "target-ok",
    "guard-stop",
    "finished",
  ]);
  const guard = events.find((event) => event.type === "guard-stop");
  assert.ok(guard && guard.type === "guard-stop");
  assert.equal(guard.reason, "cost-cap");
  assert.equal(guard.cumulativeCostUsd, 6);
  assert.equal(summary.ok, 2);
  assert.equal(summary.notStarted, 1);
  assert.equal(summary.totalCostUsd, 6);
  assert.equal(summary.stopReason, "cost-cap");
  console.log("✅ 비용 상한 — guard-stop(cost-cap)·신규 착수 중단·stopReason");
}

// ---- ③ 윈도 소진 마커 → guard-stop(window-exhausted) ---------------------------
{
  const analyzed: string[] = [];
  const events: LabBatchEvent[] = [];
  const summary = await runLabBatch(
    baseOptions(events),
    makeDeps({
      entries: [entry("w1"), entry("w2"), entry("w3")],
      run: async (grantId) => {
        analyzed.push(grantId);
        return errorResult(
          `공고 ${grantId}`,
          `Claude Max 사용량 윈도 소진으로 판단됨 ${CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER} — 윈도 리셋 후 재실행`,
        );
      },
    }),
  );
  assert.deepEqual(analyzed, ["w1"], "소진 감지 후 w2·w3 은 착수하지 않는다");
  assert.deepEqual(eventTypes(events), [
    "plan",
    "target-started",
    "target-error",
    "guard-stop",
    "finished",
  ]);
  const errorEvent = events.find((event) => event.type === "target-error");
  assert.ok(errorEvent && errorEvent.type === "target-error");
  assert.equal(errorEvent.runSaved, true, "윈도 소진 실패도 error 런으로 저장된 실패다");
  assert.equal(errorEvent.title, "공고 w1");
  const guard = events.find((event) => event.type === "guard-stop");
  assert.ok(guard && guard.type === "guard-stop");
  assert.equal(guard.reason, "window-exhausted");
  assert.equal(summary.errorRuns, 1);
  assert.equal(summary.notStarted, 2);
  assert.equal(summary.stopReason, "window-exhausted");
  console.log("✅ 윈도 소진 — 마커 감지 guard-stop(window-exhausted)·신규 착수 중단");
}

// Kordoc sidecar 윈도 소진은 딥 분석 성공을 유지하면서 신규 착수만 중단한다.
{
  const analyzed: string[] = [];
  const events: LabBatchEvent[] = [];
  const summary = await runLabBatch(
    baseOptions(events, { withApplicationRoundtrip: true }),
    makeDeps({
      entries: [entry("sw1"), entry("sw2"), entry("sw3")],
      run: async (grantId) => {
        analyzed.push(grantId);
        return {
          ...okResult(`공고 ${grantId}`, 0.1),
          applicationRoundtrip: {
            status: "partial",
            runId: "roundtrip-sidecar",
            transport: "claude-cli",
            model: "claude-opus-5",
            documentCount: 1,
            sourceCount: 1,
            errorCode: "window_exhausted",
            error: null,
          },
        };
      },
    }),
  );
  assert.deepEqual(analyzed, ["sw1"]);
  assert.deepEqual(eventTypes(events), [
    "plan",
    "target-started",
    "target-ok",
    "guard-stop",
    "finished",
  ]);
  const okEvent = events.find((event) => event.type === "target-ok");
  assert.ok(okEvent && okEvent.type === "target-ok");
  assert.equal(okEvent.applicationRoundtrip?.status, "partial");
  assert.equal(okEvent.applicationRoundtrip?.errorCode, "window_exhausted");
  assert.equal(summary.ok, 1, "sidecar 실패가 딥 분석 성공 집계를 바꾸지 않는다");
  assert.equal(summary.errorRuns, 0);
  assert.equal(summary.notStarted, 2);
  assert.equal(summary.stopReason, "window-exhausted");
  console.log("✅ Kordoc 윈도 소진 — 딥 분석 성공 유지·신규 착수 중단");
}

// ---- ④ abort → stopReason aborted + 진행분 완료 --------------------------------
{
  // concurrency=2 로 g1·g2 가 동시에 착수된 뒤 abort — 진행분 2건은 끝까지 완료(런 저장
  // 경로 유지)되고 g3·g4 는 착수하지 않는다.
  const controller = new AbortController();
  const release = deferred();
  let started = 0;
  const events: LabBatchEvent[] = [];
  const summary = await runLabBatch(
    baseOptions(events, { concurrency: 2, signal: controller.signal }),
    makeDeps({
      entries: [entry("a1"), entry("a2"), entry("a3"), entry("a4")],
      run: async (grantId) => {
        started += 1;
        if (started === 2) {
          controller.abort();
          release.resolve();
        }
        await release.promise;
        return okResult(`공고 ${grantId}`, 0.2);
      },
    }),
  );
  assert.equal(started, 2, "abort 이후 신규 착수 없음");
  assert.equal(summary.ok, 2, "진행분 2건은 완료로 집계");
  assert.equal(summary.notStarted, 2);
  assert.equal(summary.stopReason, "aborted");
  assert.equal(
    events.filter((event) => event.type === "target-ok").length,
    2,
    "진행분의 target-ok 이벤트도 정상 방출",
  );
  assert.ok(!events.some((event) => event.type === "guard-stop"), "abort 는 guard-stop 이 아니다");
  console.log("✅ abort — 신규 착수 중단·진행분 완료·stopReason aborted");
}

// ---- ⑤ transport/model 오버라이드 전달 ----------------------------------------
{
  const received: Array<{
    transport?: string;
    model?: string;
    withApplicationRoundtrip?: boolean;
    roundtripModel?: string;
  } | undefined> = [];
  const run: LabBatchAnalysisImpl = async (grantId, overrides) => {
    received.push(overrides);
    return okResult(grantId, 0.1);
  };

  // 둘 다 지정 — 매 호출에 그대로 전달.
  const bothEvents: LabBatchEvent[] = [];
  await runLabBatch(
    baseOptions(bothEvents, { transport: "claude-cli", model: "claude-test-1" }),
    makeDeps({ entries: [entry("t1"), entry("t2")], run }),
  );
  assert.deepEqual(received, [
    { transport: "claude-cli", model: "claude-test-1" },
    { transport: "claude-cli", model: "claude-test-1" },
  ]);

  // model 만 지정 — transport 키 자체를 만들지 않는다(env 경로 보존).
  received.length = 0;
  await runLabBatch(
    baseOptions([], { model: "claude-test-2" }),
    makeDeps({ entries: [entry("t3")], run }),
  );
  assert.equal(received.length, 1);
  const modelOnly = received[0];
  assert.ok(modelOnly);
  assert.deepEqual(modelOnly, { model: "claude-test-2" });
  assert.ok(!("transport" in modelOnly), "미지정 transport 는 키 자체가 없어야 한다");

  // Kordoc 선분석 opt-in — false는 키를 만들지 않고 true/model만 명시 전달한다.
  received.length = 0;
  await runLabBatch(
    baseOptions([], {
      withApplicationRoundtrip: true,
      roundtripModel: "claude-opus-roundtrip",
    }),
    makeDeps({ entries: [entry("t-roundtrip")], run }),
  );
  assert.deepEqual(received, [{
    withApplicationRoundtrip: true,
    roundtripModel: "claude-opus-roundtrip",
  }]);

  // 둘 다 미지정 — overrides 인자 자체가 undefined(기존 env 경로 100% 보존).
  received.length = 0;
  await runLabBatch(baseOptions([]), makeDeps({ entries: [entry("t4")], run }));
  assert.deepEqual(received, [undefined]);
  console.log("✅ 오버라이드 — transport/model/roundtrip 전달·미지정 시 undefined(env 경로 보존)");
}

// ---- ⑥ 대상 0건 → 분석 무호출 finished ----------------------------------------
{
  const events: LabBatchEvent[] = [];
  let called = 0;
  const summary = await runLabBatch(
    baseOptions(events),
    makeDeps({
      entries: [entry("z1")],
      states: new Map([["z1", { okCurrent: true, okOutdated: false, errorCurrent: false }]]),
      run: async (grantId) => {
        called += 1;
        return okResult(grantId, 0.1);
      },
    }),
  );
  assert.equal(called, 0);
  assert.deepEqual(eventTypes(events), ["plan", "finished"]);
  assert.equal(planOf(events).estimatedCostUsd, null, "대상 0건이면 예상 비용 표기 없음(null)");
  assert.equal(summary.stopReason, "completed");
  assert.equal(summary.skippedOk, 1);
  console.log("✅ 대상 0건 — plan·finished 만 방출, 분석 무호출");
}

// ---- ⑦ 오버라이드 오타 fail-fast ----------------------------------------------
{
  const events: LabBatchEvent[] = [];
  let called = 0;
  await assert.rejects(
    runLabBatch(
      baseOptions(events, { transport: "claude_cli" as never }),
      makeDeps({
        entries: [entry("x1")],
        run: async (grantId) => {
          called += 1;
          return okResult(grantId, 0.1);
        },
      }),
    ),
    /transport 오버라이드 값이 잘못됐습니다/,
  );
  assert.equal(called, 0);
  assert.equal(events.length, 0, "fail-fast — plan 이벤트조차 방출하지 않는다");
  console.log("✅ 오버라이드 오타 — 진입 시 1회 해석 fail-fast·이벤트 무방출");
}

console.log("\nbatch-runner 테스트 전부 통과");
