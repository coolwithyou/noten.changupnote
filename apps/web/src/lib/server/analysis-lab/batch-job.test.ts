// 웹 배치 잡 관리자 단위 테스트 (실 러너/DB/spike-out 무접촉 — deps 주입점 전면 페이크).
// 실행: pnpm lab:batch-job:test
// 검증: ① 시작→진행→완료(옵션 확정 기록·progress 누적·영속 파일) ② busy(실행 중 재시작
// 거부 — 라우트 409 경로) + 완료 후 재시작 허용 ③ abort(신호 전달·전이는 러너 종료 시점)
// ④ 이벤트 링 버퍼 200 상한 ⑤ 러너 throw → state error ⑥ HMR 스태시(globalThis 심볼 —
// 모듈 로컬 상태 없음 검증) ⑦ 재시작 강등(running 잔상 → aborted + 안내, finished 잔상
// 그대로, 파일 없음 → idle) ⑧ CLI 관측 브리지(origin "cli" 파일: pid 생존 → running 유지
// + 캐시 금지·매 GET 재독 / pid 사망 → aborted 강등 / 생존 CLI running 중 웹 시작 → busy /
// 종결 메모리 잔상보다 살아 있는 CLI running 우선).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LabBatchJobSnapshot,
  LabBatchStartRequest,
} from "@/features/dev/analysis-lab/contract";
import {
  LabBatchJobBusyError,
  applyLabBatchEvent,
  abortLabBatchJob,
  getLabBatchJobSnapshot,
  startLabBatchJob,
  type LabBatchJobDeps,
} from "./batch-job";
import type { LabBatchEvent, LabBatchRunnerOptions, LabBatchSummary } from "./batch-runner";

// ---- 픽스처 헬퍼 ---------------------------------------------------------------

const tempRoot = mkdtempSync(join(tmpdir(), "cunote-batch-job-test-"));
const STASH_KEY = Symbol.for("cunote.labBatchJob");

/** 프로세스 재시작 시뮬 — globalThis 스태시를 비운다(모듈은 재실행 없이 그대로). */
function clearStash(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[STASH_KEY];
}

function request(overrides: Partial<LabBatchStartRequest> = {}): LabBatchStartRequest {
  return {
    limit: 5,
    concurrency: 2,
    apiMaxCostUsd: 100,
    retryErrors: false,
    reanalyzeOutdated: false,
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<LabBatchSummary> = {}): LabBatchSummary {
  return {
    ok: 0,
    held: 0,
    errorRuns: 0,
    unsavedFailures: 0,
    notStarted: 0,
    skippedOk: 0,
    skippedOkOutdatedOnly: 0,
    skippedHeld: 0,
    heldError: 0,
    periodSkipped: 0,
    totalCostUsd: 0,
    durationMs: 10,
    stopReason: "completed",
    ...overrides,
  };
}

/** 러너가 방출하는 형태의 plan 이벤트 — additive 필드 전부 채움(러너 보장과 동형). */
function planEvent(targets: number): LabBatchEvent {
  return {
    type: "plan",
    cohortLabel: "job-test",
    total: targets,
    skippedOk: 0,
    skippedOkOutdatedOnly: 0,
    skippedHeld: 0,
    heldError: 0,
    periodSkipped: 0,
    targets,
    estimatedCostUsd: targets > 0 ? 0.4 * targets : null,
    runnable: targets,
    periodSkippedEntries: [],
    estimatedCostPerGrantUsd: 0.4,
    costSampleCount: 1,
  };
}

// ---- additive held 진행 집계 — 구 progress(held 미기록)도 0에서 복원 ---------
{
  const legacy = persistedFixture("running");
  assert.equal(legacy.progress?.held, undefined, "구 스냅샷 형태");
  applyLabBatchEvent(legacy, {
    type: "target-held",
    index: 1,
    total: 5,
    grantId: "held-1",
    stratum: "pilot",
    title: "보류 공고",
    durationMs: 100,
    costUsd: 0.4,
    cumulativeCostUsd: 0.8,
  });
  assert.equal(legacy.progress?.held, 1);
  assert.equal(legacy.progress?.ok, 1, "기존 성공 집계 보존");
  assert.equal(legacy.progress?.error, 1, "기존 실패 집계 보존");
  assert.equal(legacy.progress?.cumulativeCostUsd, 0.8);
  console.log("✅ target-held 진행 집계 — 구 스냅샷 additive 복원");
}

function startedEvent(index: number, total: number, grantId: string): LabBatchEvent {
  return { type: "target-started", index, total, grantId, stratum: "bizinfo/thick" };
}

function okEvent(index: number, total: number, grantId: string, cumulativeCostUsd: number): LabBatchEvent {
  return {
    type: "target-ok",
    index,
    total,
    grantId,
    stratum: "bizinfo/thick",
    title: `공고 ${grantId}`,
    durationMs: 100,
    costUsd: 0.25,
    cumulativeCostUsd,
  };
}

function persistedFixture(state: LabBatchJobSnapshot["state"]): LabBatchJobSnapshot {
  return {
    jobId: "job-stale-1",
    state,
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: state === "running" ? null : "2026-08-03T00:10:00.000Z",
    options: {
      limit: 5,
      concurrency: 2,
      maxCostUsd: 3,
      retryErrors: false,
      reanalyzeOutdated: false,
      transport: "claude-cli",
      model: "claude-test-model",
    },
    progress: { total: 5, started: 2, ok: 1, error: 1, cumulativeCostUsd: 0.4 },
    guardStop: null,
    summary: null,
    events: [],
    error: null,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** fire-and-forget 잡의 종료(마이크로태스크 수렴)를 폴링으로 기다린다. */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`시간 내 조건 미충족: ${label}`);
}

// ---- ① 시작→진행→완료 ---------------------------------------------------------
{
  clearStash();
  const path = join(tempRoot, "t1.json");
  const release = deferred();
  let receivedOptions: LabBatchRunnerOptions | null = null;
  let keepAliveCount = 0;
  const deps: LabBatchJobDeps = {
    resolveTransportImpl: () => "claude-cli",
    resolveModelImpl: () => "claude-test-model",
    snapshotPathImpl: () => path,
    keepAliveIntervalMs: 5,
    keepAliveImpl: async () => { keepAliveCount += 1; },
    runBatchImpl: async (options) => {
      receivedOptions = options;
      const emit = options.onEvent ?? (() => {});
      // 첫 await 이전 동기 방출 — startLabBatchJob 반환 스냅샷에 이미 반영돼야 한다.
      emit(planEvent(2));
      emit(startedEvent(0, 2, "g1"));
      emit(okEvent(0, 2, "g1", 0.25));
      await release.promise;
      emit(startedEvent(1, 2, "g2"));
      emit(okEvent(1, 2, "g2", 0.5));
      const summary = summaryFixture({ ok: 2, totalCostUsd: 0.5 });
      emit({ type: "finished", summary });
      return summary;
    },
  };

  const started = startLabBatchJob(request({
    withApplicationRoundtrip: true,
    roundtripModel: "claude-roundtrip-test",
  }), deps);
  assert.equal(started.state, "running");
  assert.ok(started.jobId?.startsWith("job-"), "jobId 부여");
  assert.equal(started.options?.transport, "claude-cli", "미지정 transport 는 resolver 로 확정해 기록");
  assert.equal(started.options?.model, "claude-test-model", "미지정 model 도 resolver 로 확정해 기록");
  assert.ok(
    started.options && !("maxCostUsd" in started.options),
    "구독 잡 스냅샷에는 과거 명목 비용 상한을 active option으로 저장하지 않는다",
  );
  assert.equal(started.options?.apiMaxCostUsd, undefined, "구독 입력에 섞인 API cap도 정규화 단계에서 제거");
  assert.equal(started.progress?.total, 2, "plan 이벤트로 total 반영");
  assert.equal(started.progress?.started, 1);
  assert.equal(started.progress?.ok, 1);
  assert.equal(started.progress?.cumulativeCostUsd, 0.25);
  assert.equal(started.events.length, 3);

  // 러너 옵션 — 확정 transport/model 이 명시 오버라이드로, abort 용 signal 이 함께 전달된다.
  const options = receivedOptions as LabBatchRunnerOptions | null;
  assert.ok(options, "러너 호출됨");
  assert.equal(options.transport, "claude-cli");
  assert.equal(options.model, "claude-test-model");
  assert.equal(options.limit, 5);
  assert.equal(options.apiMaxCostUsd, undefined, "구독 runner에는 API 비용 guard를 전달하지 않는다");
  assert.equal(options.withApplicationRoundtrip, true, "Kordoc 형제 분석 옵션 전달");
  assert.equal(options.roundtripModel, "claude-roundtrip-test", "Kordoc 모델 옵션 전달");
  assert.ok(options.signal instanceof AbortSignal, "AbortController 신호 전달");

  assert.equal(getLabBatchJobSnapshot(deps).state, "running", "완료 전 GET 은 running");
  await waitUntil(() => keepAliveCount > 0, "로컬 runtime lease keepalive");
  release.resolve();
  await waitUntil(() => getLabBatchJobSnapshot(deps).state === "finished", "잡 완료 전이");
  const keepAliveAtFinish = keepAliveCount;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(keepAliveCount, keepAliveAtFinish, "잡 종결 시 keepalive timer 해제");

  const done = getLabBatchJobSnapshot(deps);
  assert.equal(done.jobId, started.jobId);
  assert.equal(done.summary?.ok, 2);
  assert.equal(done.summary?.stopReason, "completed");
  assert.equal(done.progress?.ok, 2);
  assert.equal(done.progress?.cumulativeCostUsd, 0.5);
  assert.equal(done.events.length, 6);
  assert.ok(done.finishedAt, "finishedAt 기록");
  assert.equal(done.error, null);

  // 영속 파일 — 베스트에포트 write 가 최종 상태를 남긴다(비동기 체인 수렴 대기).
  await waitUntil(() => {
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as { state?: unknown }).state === "finished";
    } catch {
      return false;
    }
  }, "batch-job.json 최종 상태 기록");
  console.log("✅ 시작→진행→완료 — 옵션 확정 기록·progress 누적·finished 전이·영속 파일");
}

// ---- API 비용 정책 — 잡 생성 전에 필수 cap 검증·정규화 -------------------------
{
  clearStash();
  const path = join(tempRoot, "t-api-cost-policy.json");
  let runnerCalled = false;
  const deps: LabBatchJobDeps = {
    resolveTransportImpl: () => "api",
    resolveModelImpl: () => "api-test-model",
    snapshotPathImpl: () => path,
    runBatchImpl: async () => {
      runnerCalled = true;
      return summaryFixture();
    },
  };
  const { apiMaxCostUsd: _omittedApiMaxCostUsd, ...apiRequestWithoutCap } = request();
  assert.throws(
    () => startLabBatchJob(apiRequestWithoutCap, deps),
    /apiMaxCostUsd 는 0보다 큰 유한한 숫자여야 합니다/,
    "API cap 누락은 running 스냅샷을 만들기 전에 fail-fast",
  );
  assert.equal(runnerCalled, false, "정책 오류에서 runner 미착수");
  assert.equal(getLabBatchJobSnapshot(deps).state, "idle", "정책 오류가 유령 running 잡을 남기지 않음");
  console.log("✅ API 비용 정책 — 잡 생성 전 필수 cap 검증·구독 cap 제거");
}

// ---- ② busy — 실행 중 재시작 거부(라우트 409 경로) + 완료 후 재시작 허용 --------
{
  clearStash();
  const path = join(tempRoot, "t2.json");
  const release = deferred();
  const deps: LabBatchJobDeps = {
    resolveTransportImpl: () => "api",
    resolveModelImpl: () => "claude-test-model",
    snapshotPathImpl: () => path,
    runBatchImpl: async () => {
      await release.promise;
      return summaryFixture();
    },
  };

  const first = startLabBatchJob(request(), deps);
  assert.equal(first.options?.apiMaxCostUsd, 100, "API 잡 스냅샷은 완료 비용 soft stop을 보존");
  assert.throws(
    () => startLabBatchJob(request(), deps),
    (caught: unknown) => {
      assert.ok(caught instanceof LabBatchJobBusyError, "LabBatchJobBusyError throw");
      assert.equal(caught.snapshot.state, "running", "busy 에러가 현재 스냅샷 동봉(라우트 409 본문)");
      assert.equal(caught.snapshot.jobId, first.jobId);
      return true;
    },
  );

  release.resolve();
  await waitUntil(() => getLabBatchJobSnapshot(deps).state === "finished", "1차 잡 완료");

  // 완료 후에는 새 잡 시작 허용 — 직전 잔상은 새 잡으로 대체된다.
  const second = startLabBatchJob(request({ limit: 1 }), {
    ...deps,
    runBatchImpl: async () => summaryFixture({ ok: 1 }),
  });
  assert.equal(second.state, "running");
  assert.notEqual(second.jobId, first.jobId, "새 jobId 발급");
  await waitUntil(() => getLabBatchJobSnapshot(deps).state === "finished", "2차 잡 완료");
  console.log("✅ busy — 실행 중 LabBatchJobBusyError(스냅샷 동봉)·완료 후 재시작 허용");
}

// ---- ③ abort — 신호 전달·상태 전이는 러너 종료 시점 ----------------------------
{
  clearStash();
  const path = join(tempRoot, "t3.json");
  const deps: LabBatchJobDeps = {
    resolveTransportImpl: () => "api",
    resolveModelImpl: () => "claude-test-model",
    snapshotPathImpl: () => path,
    runBatchImpl: async (options) => {
      // 러너 계약과 동형: abort 신호를 받으면 신규 착수를 멈추고 aborted 요약으로 종료.
      await waitUntil(() => options.signal?.aborted === true, "abort 신호 수신");
      return summaryFixture({ ok: 1, notStarted: 4, stopReason: "aborted" });
    },
  };

  startLabBatchJob(request(), deps);
  const afterAbort = abortLabBatchJob(deps);
  assert.equal(afterAbort.state, "running", "abort 직후는 running 유지 — 전이는 러너 종료 시점");
  await waitUntil(() => getLabBatchJobSnapshot(deps).state === "aborted", "aborted 전이");
  const final = getLabBatchJobSnapshot(deps);
  assert.equal(final.summary?.stopReason, "aborted");
  assert.equal(final.summary?.notStarted, 4, "진행분 완료·미착수 집계 유지");
  assert.equal(final.error, null, "abort 는 잡 실패가 아니다");

  // 잡 없는 상태의 DELETE 는 no-op — 현재 스냅샷만 반환(초기 상태 검증은 ⑦에서).
  const noop = abortLabBatchJob(deps);
  assert.equal(noop.state, "aborted", "no-op abort — 직전 잡 잔상 그대로");
  console.log("✅ abort — 신호 전달·러너 종료 시점 aborted 전이·no-op 안전");
}

// ---- ④ 이벤트 링 버퍼 200 상한 --------------------------------------------------
{
  clearStash();
  const path = join(tempRoot, "t4.json");
  const total = 125; // started+ok 2건씩 = 250 이벤트 > 200
  const deps: LabBatchJobDeps = {
    resolveTransportImpl: () => "api",
    resolveModelImpl: () => "claude-test-model",
    snapshotPathImpl: () => path,
    runBatchImpl: async (options) => {
      const emit = options.onEvent ?? (() => {});
      for (let index = 0; index < total; index += 1) {
        emit(startedEvent(index, total, `g${index}`));
        emit(okEvent(index, total, `g${index}`, (index + 1) * 0.01));
      }
      return summaryFixture({ ok: total, totalCostUsd: total * 0.01 });
    },
  };
  startLabBatchJob(request({ limit: total }), deps);
  await waitUntil(() => getLabBatchJobSnapshot(deps).state === "finished", "링 버퍼 잡 완료");
  const snapshot = getLabBatchJobSnapshot(deps);
  assert.equal(snapshot.events.length, 200, "링 버퍼 상한 200");
  const first = snapshot.events[0];
  assert.ok(first && first.type === "target-started" && first.grantId === "g25", "오래된 이벤트부터 탈락");
  assert.equal(snapshot.progress?.ok, total, "progress 누적은 링 버퍼와 무관하게 전체 집계");
  console.log("✅ 링 버퍼 — 200 상한·오래된 이벤트 탈락·progress 는 전체 누적");
}

// ---- ⑤ 러너 throw → state error ------------------------------------------------
{
  clearStash();
  const path = join(tempRoot, "t5.json");
  const deps: LabBatchJobDeps = {
    resolveTransportImpl: () => "api",
    resolveModelImpl: () => "claude-test-model",
    snapshotPathImpl: () => path,
    runBatchImpl: async () => {
      throw new Error("cohort.json 이 없거나 형식이 깨졌습니다: /tmp/none");
    },
  };
  startLabBatchJob(request(), deps);
  await waitUntil(() => getLabBatchJobSnapshot(deps).state === "error", "error 전이");
  const failed = getLabBatchJobSnapshot(deps);
  assert.match(failed.error ?? "", /cohort\.json/, "러너 throw 메시지 기록");
  assert.equal(failed.summary, null, "요약 없는 인프라 실패");
  assert.ok(failed.finishedAt, "실패 시각 기록");
  console.log("✅ 러너 throw — state error·메시지 기록(게이트 중단·error 런과 구분)");
}

// ---- ⑥ HMR 스태시 — 상태가 globalThis 심볼에만 있다 ----------------------------
{
  clearStash();
  const path = join(tempRoot, "t6.json");
  const deps: LabBatchJobDeps = {
    resolveTransportImpl: () => "api",
    resolveModelImpl: () => "claude-test-model",
    snapshotPathImpl: () => path,
    runBatchImpl: async () => summaryFixture({ ok: 1 }),
  };
  startLabBatchJob(request(), deps);
  await waitUntil(() => getLabBatchJobSnapshot(deps).state === "finished", "잡 완료");

  const stash = (globalThis as unknown as Record<symbol, unknown>)[STASH_KEY];
  assert.ok(stash, "잡 상태는 globalThis[Symbol.for(\"cunote.labBatchJob\")] 에 보관");
  // HMR 모듈 재인스턴스 시뮬: 새 모듈 인스턴스도 같은 스태시를 읽는다 — 모듈 로컬 사본이
  // 없음을 스태시 직접 변형이 조회에 즉시 반영되는 것으로 검증한다.
  const stashJob = (stash as { job: { snapshot: LabBatchJobSnapshot } | null }).job;
  assert.ok(stashJob, "스태시에 잡 실재");
  stashJob.snapshot.error = "hmr-probe";
  assert.equal(getLabBatchJobSnapshot(deps).error, "hmr-probe", "조회가 스태시를 통해 읽는다");
  console.log("✅ HMR 스태시 — globalThis 심볼 보관·모듈 로컬 상태 없음");
}

// ---- ⑦ 재시작 강등 — running 잔상 → aborted, finished 잔상 그대로, 없으면 idle --
{
  // 직전 프로세스가 running 상태로 남긴 파일 → aborted 강등 + 안내 메시지.
  clearStash();
  const runningPath = join(tempRoot, "t7-running.json");
  writeFileSync(runningPath, JSON.stringify(persistedFixture("running"), null, 2), "utf8");
  const demoted = getLabBatchJobSnapshot({ snapshotPathImpl: () => runningPath });
  assert.equal(demoted.state, "aborted", "running 잔상은 프로세스 재시작 강등");
  assert.equal(demoted.jobId, "job-stale-1", "직전 잡 식별 유지(stale, process-restarted)");
  assert.match(demoted.error ?? "", /dev 서버 재시작으로 잡이 소멸/, "강등 사유 안내");
  assert.equal(demoted.progress?.ok, 1, "완료분 집계 잔상 보존(완료 런은 저장됨)");
  assert.equal(demoted.options?.maxCostUsd, 3, "구 스냅샷의 명목 상한은 복원 호환용으로만 보존");
  // 복원 후 새 잡 시작 허용(강등된 잔상은 running 이 아니다).
  const restarted = startLabBatchJob(request(), {
    snapshotPathImpl: () => runningPath,
    resolveTransportImpl: () => "api",
    resolveModelImpl: () => "claude-test-model",
    runBatchImpl: async () => summaryFixture(),
  });
  assert.equal(restarted.state, "running");
  await waitUntil(
    () => getLabBatchJobSnapshot({ snapshotPathImpl: () => runningPath }).state === "finished",
    "복원 후 재시작 잡 완료",
  );

  // finished 잔상은 강등 없이 그대로.
  clearStash();
  const finishedPath = join(tempRoot, "t7-finished.json");
  writeFileSync(finishedPath, JSON.stringify(persistedFixture("finished"), null, 2), "utf8");
  const kept = getLabBatchJobSnapshot({ snapshotPathImpl: () => finishedPath });
  assert.equal(kept.state, "finished");
  assert.equal(kept.error, null, "완결 잔상은 손대지 않는다");

  // 파일 없음 → 초기(idle) 상태.
  clearStash();
  const missing = getLabBatchJobSnapshot({ snapshotPathImpl: () => join(tempRoot, "missing.json") });
  assert.equal(missing.state, "idle");
  assert.equal(missing.jobId, null);
  assert.deepEqual(missing.events, []);

  // 파손 파일 → 초기 상태(조용히 무시).
  clearStash();
  const corruptPath = join(tempRoot, "t7-corrupt.json");
  writeFileSync(corruptPath, "{broken", "utf8");
  assert.equal(getLabBatchJobSnapshot({ snapshotPathImpl: () => corruptPath }).state, "idle");
  console.log("✅ 재시작 강등 — running→aborted(안내 부여)·finished 보존·없음/파손→idle");
}

// ---- ⑧ CLI 관측 브리지 — origin "cli" 파일 폴백의 pid 생존 판정·busy 승격 ---------
{
  /** CLI(batch.ts 관측 브리지)가 남기는 형태의 스냅샷 — origin "cli" + 기록 프로세스 pid. */
  const cliFixture = (overrides: Partial<LabBatchJobSnapshot> = {}): LabBatchJobSnapshot => ({
    ...persistedFixture("running"),
    jobId: "job-cli-1",
    origin: "cli",
    pid: process.pid,
    options: {
      ...persistedFixture("running").options!,
      cohortSnapshot: "deep-v17-cp2b-pilot5",
    },
    ...overrides,
  });

  // pid 생존(현재 프로세스) → running 그대로(origin 라벨 유지) + 메모리 캐시 금지.
  clearStash();
  const alivePath = join(tempRoot, "t8-cli-alive.json");
  writeFileSync(alivePath, JSON.stringify(cliFixture(), null, 2), "utf8");
  const aliveDeps: LabBatchJobDeps = { snapshotPathImpl: () => alivePath };
  const alive = getLabBatchJobSnapshot(aliveDeps);
  assert.equal(alive.state, "running", "CLI 프로세스 생존 — running 유지(강등 없음)");
  assert.equal(alive.origin, "cli", "라벨용 origin 유지");
  assert.equal(alive.options?.cohortSnapshot, "deep-v17-cp2b-pilot5", "불변 코호트 provenance 유지");
  assert.equal(alive.error, null, "생존 중엔 안내 메시지 없음");
  const stashAfterCli = (globalThis as unknown as Record<symbol, unknown>)[STASH_KEY] as
    | { job: unknown }
    | undefined;
  assert.equal(stashAfterCli?.job ?? null, null, "CLI 스냅샷은 메모리 캐시 금지");
  // 파일 갱신(CLI 진행)이 다음 GET 에 즉시 반영 — 매 GET 재독의 실증.
  writeFileSync(
    alivePath,
    JSON.stringify(
      cliFixture({ progress: { total: 5, started: 4, ok: 3, error: 1, cumulativeCostUsd: 1.2 } }),
      null,
      2,
    ),
    "utf8",
  );
  assert.equal(getLabBatchJobSnapshot(aliveDeps).progress?.ok, 3, "파일 갱신 즉시 반영(재독)");

  // 생존 CLI running 중 웹 잡 시작 → busy(웹·CLI 동시 실행 금지의 코드 승격).
  assert.throws(
    () => startLabBatchJob(request(), { ...aliveDeps, runBatchImpl: async () => summaryFixture() }),
    (caught: unknown) => {
      assert.ok(caught instanceof LabBatchJobBusyError, "LabBatchJobBusyError throw");
      assert.equal(caught.snapshot.origin, "cli", "busy 스냅샷은 CLI 잡");
      assert.equal(caught.snapshot.state, "running");
      return true;
    },
  );

  // pid 사망(pid_max 밖 — ESRCH) → 기존 관행대로 aborted 강등 + CLI 종료 안내.
  clearStash();
  const deadPath = join(tempRoot, "t8-cli-dead.json");
  writeFileSync(deadPath, JSON.stringify(cliFixture({ pid: 999_999 }), null, 2), "utf8");
  const dead = getLabBatchJobSnapshot({ snapshotPathImpl: () => deadPath });
  assert.equal(dead.state, "aborted", "CLI 프로세스 사망 — aborted 강등");
  assert.equal(dead.origin, "cli", "강등 후에도 origin 유지");
  assert.match(dead.error ?? "", /CLI 배치 프로세스 종료 감지/, "CLI 종료 안내(완료 런은 저장됨)");

  // pid 사망 CLI 잔상은 웹 시작을 막지 않는다 — 새 웹 잡이 파일을 대체한다.
  clearStash();
  writeFileSync(deadPath, JSON.stringify(cliFixture({ pid: 999_999 }), null, 2), "utf8");
  const webStarted = startLabBatchJob(request(), {
    snapshotPathImpl: () => deadPath,
    resolveTransportImpl: () => "api",
    resolveModelImpl: () => "claude-test-model",
    runBatchImpl: async () => summaryFixture(),
  });
  assert.equal(webStarted.state, "running", "사망 CLI 잔상 위로 웹 잡 시작 허용");
  await waitUntil(
    () => getLabBatchJobSnapshot({ snapshotPathImpl: () => deadPath }).state === "finished",
    "사망 잔상 대체 웹 잡 완료",
  );
  // 영속 체인 flush 대기 — 아래 파일 덮어쓰기가 웹 잡의 늦은 write 에 뒤집히지 않게.
  await waitUntil(() => {
    try {
      return (JSON.parse(readFileSync(deadPath, "utf8")) as { state?: unknown }).state === "finished";
    } catch {
      return false;
    }
  }, "웹 잡 최종 상태 파일 flush");

  // 종결 메모리 잔상보다 CLI 파일이 우선 — 웹 잡도 종료 시 자신을 같은 파일에 남기므로,
  // 파일이 origin "cli" 라는 것은 곧 "직전 웹 잡 이후의 더 새로운 기록"이다.
  writeFileSync(deadPath, JSON.stringify(cliFixture({ jobId: "job-cli-2" }), null, 2), "utf8");
  const preempted = getLabBatchJobSnapshot({ snapshotPathImpl: () => deadPath });
  assert.equal(preempted.jobId, "job-cli-2", "살아 있는 CLI running 이 종결 메모리 잔상보다 우선");
  assert.equal(preempted.state, "running");
  // 종결(finished) CLI 파일도 마찬가지 — 완료된 CLI 배치 결과가 잔상에 가려지면 안 된다.
  writeFileSync(
    deadPath,
    JSON.stringify(cliFixture({ jobId: "job-cli-2", state: "finished", finishedAt: "2026-08-03T01:00:00.000Z" }), null, 2),
    "utf8",
  );
  const finishedCli = getLabBatchJobSnapshot({ snapshotPathImpl: () => deadPath });
  assert.equal(finishedCli.jobId, "job-cli-2", "종결 CLI 파일도 종결 메모리 잔상보다 우선");
  assert.equal(finishedCli.state, "finished");
  console.log("✅ CLI 관측 브리지 — pid 생존 running 유지(재독)·사망 강등·busy 승격·잔상 우선순위");
}

clearStash();
console.log("\nbatch-job 테스트 전부 통과");
