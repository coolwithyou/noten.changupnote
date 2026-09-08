import assert from "node:assert/strict";
import {
  createDeepRepairLiveRuntimeAuthority,
  type DeepRepairLeaseClient,
} from "./deep-repair-live-runtime";

const OWNER = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_OWNER = "223e4567-e89b-42d3-a456-426614174000";

function control(generation: number) {
  return { mode: "local_subscription" as const, generation, localOwnerId: OWNER };
}

{
  const callbacks: Array<() => Promise<void>> = [];
  const releaseBindings: Array<{ ownerId: string; generation: number }> = [];
  const client: DeepRepairLeaseClient = {
    async acquire(input) { return control(input.expectedGeneration + 1); },
    async renew() {
      return { mode: "paused", generation: 69, localOwnerId: OTHER_OWNER };
    },
    async release(input) { releaseBindings.push(input); },
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
  });
  let abortedAfterKnownLoss: boolean | undefined;
  await assert.rejects(
    runtime.runExclusive(
      { ownerId: OWNER, expectedGeneration: 67, signal: new AbortController().signal },
      async (signal) => {
        await callbacks[0]!();
        abortedAfterKnownLoss = signal.aborted;
        return "must-not-return";
      },
    ),
    /renewed lease generation\/owner binding mismatch/,
  );
  assert.equal(abortedAfterKnownLoss, true);
  assert.deepEqual(
    releaseBindings,
    [{ ownerId: OWNER, generation: 68 }],
    "cleanup은 갱신 응답의 타 owner/generation이 아니라 최초 획득 exact binding만 해제해야 한다",
  );
}

{
  const callbacks: Array<() => Promise<void>> = [];
  const client: DeepRepairLeaseClient = {
    async acquire(input) { return control(input.expectedGeneration + 1); },
    async renew() {
      const conflict = new Error("lease expired or stolen") as Error & { code: string };
      conflict.name = "DeepAnalysisRuntimeControlError";
      conflict.code = "runtime_control_conflict";
      throw conflict;
    },
    async release() {},
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
  });
  let abortedAfterConflict: boolean | undefined;
  await assert.rejects(
    runtime.runExclusive(
      { ownerId: OWNER, expectedGeneration: 67, signal: new AbortController().signal },
      async (signal) => {
        await callbacks[0]!();
        abortedAfterConflict = signal.aborted;
      },
    ),
    /lease expired or stolen/,
  );
  assert.equal(abortedAfterConflict, true, "typed DB lease 거부는 첫 응답에서 중단해야 한다");
}

{
  const callbacks: Array<() => Promise<void>> = [];
  const callerAbort = new AbortController();
  let renews = 0;
  const client: DeepRepairLeaseClient = {
    async acquire(input) { return control(input.expectedGeneration + 1); },
    async renew() {
      renews += 1;
      return control(68);
    },
    async release() {},
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
  });
  const running = runtime.runExclusive(
    { ownerId: OWNER, expectedGeneration: 67, signal: callerAbort.signal },
    async (signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  callerAbort.abort(new Error("caller stopped"));
  await callbacks[0]!();
  await assert.rejects(running, /caller stopped/);
  assert.equal(renews, 0, "외부 signal 중단 뒤에는 새 lease 갱신을 시작하면 안 된다");
}

{
  const callbacks: Array<() => Promise<void>> = [];
  const callerAbort = new AbortController();
  const client: DeepRepairLeaseClient = {
    async acquire(input) { return control(input.expectedGeneration + 1); },
    renew() {
      callerAbort.abort(new Error("caller stopped during renew start"));
      return Promise.reject(new Error("late renewal rejection"));
    },
    async release() {},
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
  });
  await assert.rejects(
    runtime.runExclusive(
      { ownerId: OWNER, expectedGeneration: 67, signal: callerAbort.signal },
      async () => {
        await callbacks[0]!();
      },
    ),
    /caller stopped during renew start/,
  );
  await new Promise((resolve) => setImmediate(resolve));
}

{
  const callbacks: Array<() => Promise<void>> = [];
  let finishRenewal!: (value: {
    mode: string;
    generation: number;
    localOwnerId: string | null;
  }) => void;
  let renewalStarted!: () => void;
  const started = new Promise<void>((resolve) => { renewalStarted = resolve; });
  const renewal = new Promise<{
    mode: string;
    generation: number;
    localOwnerId: string | null;
  }>((resolve) => { finishRenewal = resolve; });
  const client: DeepRepairLeaseClient = {
    async acquire(input) { return control(input.expectedGeneration + 1); },
    async renew() {
      renewalStarted();
      return renewal;
    },
    async release() {},
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
  });
  const running = runtime.runExclusive(
    { ownerId: OWNER, expectedGeneration: 67, signal: new AbortController().signal },
    async () => {
      void callbacks[0]!();
      await started;
      return "completed-while-renewal-pending";
    },
  );
  await started;
  finishRenewal({ mode: "paused", generation: 69, localOwnerId: null });
  await assert.rejects(
    running,
    /renewed lease generation\/owner binding mismatch/,
    "성공 반환 전에 진행 중 갱신과 합류하고 뒤늦은 확정 상실을 재검사해야 한다",
  );
}

{
  let now = 1_000;
  let released = 0;
  const client: DeepRepairLeaseClient = {
    async acquire() {
      return {
        mode: "local_subscription",
        generation: 2,
        localOwnerId: OWNER,
        localLeaseExpiresAt: new Date(2_000).toISOString(),
      };
    },
    async renew() { return control(2); },
    async release() { released += 1; },
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    now: () => now,
    scheduleRenewal: () => () => {},
    scheduleLeaseExpiry: () => () => {},
  });
  await assert.rejects(
    runtime.runExclusive(
      { ownerId: OWNER, expectedGeneration: 1, signal: new AbortController().signal },
      async () => {
        now = 3_000;
        return "must-not-return-after-deadline";
      },
    ),
    /runtime lease expired before renewal confirmation/,
    "timer 전달이 지연되어도 마지막 확인 deadline을 넘긴 결과는 성공할 수 없다",
  );
  assert.equal(released, 1);
}

{
  const callbacks: Array<() => Promise<void>> = [];
  let now = 1_000;
  let renews = 0;
  const client: DeepRepairLeaseClient = {
    async acquire() {
      return {
        mode: "local_subscription",
        generation: 2,
        localOwnerId: OWNER,
        localLeaseExpiresAt: new Date(2_000).toISOString(),
      };
    },
    async renew() {
      renews += 1;
      return control(2);
    },
    async release() {},
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    now: () => now,
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
    scheduleLeaseExpiry: () => () => {},
  });
  await assert.rejects(
    runtime.runExclusive(
      { ownerId: OWNER, expectedGeneration: 1, signal: new AbortController().signal },
      async (signal) => {
        now = 3_000;
        await callbacks[0]!();
        assert.equal(signal.aborted, true);
      },
    ),
    /runtime lease expired before renewal confirmation/,
  );
  assert.equal(renews, 0, "확정 deadline 뒤에는 DB 갱신 자체를 새로 시작하면 안 된다");
}

{
  const callbacks: Array<() => Promise<void>> = [];
  let now = 1_000;
  let finishRenewal!: (value: {
    mode: string;
    generation: number;
    localOwnerId: string | null;
    localLeaseExpiresAt: string;
  }) => void;
  let renewalStarted!: () => void;
  const started = new Promise<void>((resolve) => { renewalStarted = resolve; });
  const renewal = new Promise<{
    mode: string;
    generation: number;
    localOwnerId: string | null;
    localLeaseExpiresAt: string;
  }>((resolve) => { finishRenewal = resolve; });
  const client: DeepRepairLeaseClient = {
    async acquire() {
      return {
        mode: "local_subscription",
        generation: 2,
        localOwnerId: OWNER,
        localLeaseExpiresAt: new Date(2_000).toISOString(),
      };
    },
    async renew() {
      renewalStarted();
      return renewal;
    },
    async release() {},
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    now: () => now,
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
    scheduleLeaseExpiry: () => () => {},
  });
  const running = runtime.runExclusive(
    { ownerId: OWNER, expectedGeneration: 1, signal: new AbortController().signal },
    async (signal) => {
      void callbacks[0]!();
      await started;
      signal.throwIfAborted();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  );
  await started;
  now = 3_000;
  finishRenewal({
    mode: "local_subscription",
    generation: 2,
    localOwnerId: OWNER,
    localLeaseExpiresAt: new Date(5_000).toISOString(),
  });
  await assert.rejects(
    running,
    /runtime lease expired before renewal confirmation/,
    "이전 deadline 뒤 도착한 미래-expiry 응답은 만료 권한을 부활시키면 안 된다",
  );
}

{
  const callbacks: Array<() => Promise<void>> = [];
  let expire!: () => void;
  let finishRenewal!: (value: ReturnType<typeof control>) => void;
  let renewalStarted!: () => void;
  const started = new Promise<void>((resolve) => { renewalStarted = resolve; });
  const delayedRenewal = new Promise<ReturnType<typeof control>>((resolve) => {
    finishRenewal = resolve;
  });
  const releaseBindings: Array<{ ownerId: string; generation: number }> = [];
  const client: DeepRepairLeaseClient = {
    async acquire(input) {
      return {
        ...control(input.expectedGeneration + 1),
        localLeaseExpiresAt: "2026-08-14T00:02:00.000Z",
      };
    },
    async renew() {
      renewalStarted();
      return delayedRenewal;
    },
    async release(input) { releaseBindings.push(input); },
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    now: () => Date.parse("2026-08-14T00:00:00.000Z"),
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
    scheduleLeaseExpiry(_expiresAtMs, callback) {
      expire = callback;
      return () => {};
    },
  });
  const running = runtime.runExclusive(
    { ownerId: OWNER, expectedGeneration: 67, signal: new AbortController().signal },
    async (signal) => {
      void callbacks[0]!();
      await started;
      signal.throwIfAborted();
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  );
  await started;
  expire();
  finishRenewal(control(68));
  await assert.rejects(running, /runtime lease expired before renewal confirmation/);
  assert.deepEqual(releaseBindings, [{ ownerId: OWNER, generation: 68 }]);
}

{
  const calls: string[] = [];
  const client: DeepRepairLeaseClient = {
    async acquire(input) {
      calls.push(`acquire:${input.expectedGeneration}`);
      return control(input.expectedGeneration + 1);
    },
    async renew(input) { calls.push(`renew:${input.generation}`); return control(68); },
    async release(input) { calls.push(`release:${input.generation}`); },
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal: () => () => { calls.push("stop"); },
  });
  const result = await runtime.runExclusive(
    { ownerId: OWNER, expectedGeneration: 67, signal: new AbortController().signal },
    async (signal) => {
      assert.equal(signal.aborted, false);
      calls.push("run");
      return 42;
    },
  );
  assert.equal(result, 42);
  assert.deepEqual(calls, ["acquire:67", "run", "stop", "release:68"]);
}

{
  const callbacks: Array<() => Promise<void>> = [];
  let renews = 0;
  let released = 0;
  const client: DeepRepairLeaseClient = {
    async acquire(input) { return control(input.expectedGeneration + 1); },
    async renew() {
      renews += 1;
      throw new Error(`renew-${renews}`);
    },
    async release() { released += 1; },
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal(callback) {
      callbacks.push(callback);
      return () => {};
    },
  });
  const running = runtime.runExclusive(
    { ownerId: OWNER, expectedGeneration: 67, signal: new AbortController().signal },
    async (signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.length, 1);
  await callbacks[0]!();
  assert.equal(renews, 1);
  await callbacks[0]!();
  await assert.rejects(running, /renew-2/);
  assert.equal(released, 1);
}

{
  let ran = false;
  let released = false;
  const client: DeepRepairLeaseClient = {
    async acquire() { return control(99); },
    async renew() { return control(99); },
    async release() { released = true; },
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal: () => () => {},
  });
  await assert.rejects(
    runtime.runExclusive(
      { ownerId: OWNER, expectedGeneration: 67, signal: new AbortController().signal },
      async () => { ran = true; },
    ),
    /generation\/owner binding mismatch/,
  );
  assert.equal(ran, false);
  assert.equal(released, true);
}

{
  const primary = new Error("model state ambiguous");
  const releaseFailure = new Error("release failed");
  const client: DeepRepairLeaseClient = {
    async acquire(input) { return control(input.expectedGeneration + 1); },
    async renew() { return control(68); },
    async release() { throw releaseFailure; },
  };
  const runtime = createDeepRepairLiveRuntimeAuthority(client, {
    scheduleRenewal: () => () => {},
  });
  await assert.rejects(
    runtime.runExclusive(
      { ownerId: OWNER, expectedGeneration: 67, signal: new AbortController().signal },
      async () => { throw primary; },
    ),
    (error: unknown) => error === primary && primary.cause === releaseFailure,
    "release 실패가 모델 착수 뒤의 원래 ambiguous 오류를 덮어쓰면 안 된다",
  );
}

console.log("deep-repair-live-runtime tests passed");
