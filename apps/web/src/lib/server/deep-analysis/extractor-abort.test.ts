import assert from "node:assert/strict";
import { runDeepGrantAnalysis } from "./extractor";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const firstFetch = deferred();
let fetchCalls = 0;
const controller = new AbortController();
const leaseAbort = new DOMException("receipt lease lost", "AbortError");
const pending = runDeepGrantAnalysis({
  apiKey: "subscription",
  inputText: "테스트 공고 원문",
  model: "claude-opus-5",
  signal: controller.signal,
  fetchImpl: async (_input, init) => {
    fetchCalls += 1;
    assert.ok(init?.signal, "caller signal과 request timeout을 결합한 signal 필요");
    firstFetch.resolve();
    return new Response("temporary", { status: 429, statusText: "Too Many Requests" });
  },
});
await firstFetch.promise;
controller.abort(leaseAbort);

let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
const retryOutcome = await Promise.race([
  pending.then(
    () => ({ kind: "resolved" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  ),
  new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), 500);
    timeoutHandle.unref?.();
  }),
]);
if (timeoutHandle) clearTimeout(timeoutHandle);
assert.equal(retryOutcome.kind, "rejected", "lease abort는 5초 retry delay를 즉시 중단해야 한다");
if (retryOutcome.kind === "rejected") {
  assert.equal(retryOutcome.error, leaseAbort, "운영 lease abort 사유를 timeout으로 오분류하지 않는다");
}
assert.equal(fetchCalls, 1, "abort 뒤 두 번째 HTTP/CLI attempt를 시작하지 않는다");

const alreadyAborted = new AbortController();
alreadyAborted.abort(new DOMException("already lost", "AbortError"));
let lateFetchCalls = 0;
await assert.rejects(
  runDeepGrantAnalysis({
    apiKey: "subscription",
    inputText: "호출되면 안 되는 원문",
    model: "claude-opus-5",
    signal: alreadyAborted.signal,
    fetchImpl: async () => {
      lateFetchCalls += 1;
      return new Response("unused", { status: 500 });
    },
  }),
  (error: unknown) => error === alreadyAborted.signal.reason,
);
assert.equal(lateFetchCalls, 0, "이미 중단된 authority는 첫 fetch도 시작하지 않는다");

console.log("deep-analysis extractor abort tests: ok");
