import assert from "node:assert/strict";
import {
  createDeepRepairLiveRuntimeAuthority,
  type DeepRepairLeaseClient,
} from "./deep-repair-live-runtime";

const OWNER = "123e4567-e89b-42d3-a456-426614174000";

function control(generation: number) {
  return { mode: "local_subscription" as const, generation, localOwnerId: OWNER };
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
