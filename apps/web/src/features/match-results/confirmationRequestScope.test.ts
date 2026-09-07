import assert from "node:assert/strict";
import {
  confirmationResponseIsCurrent,
  confirmationResultAction,
  invalidateConfirmationRequestScope,
} from "./confirmationRequestScope";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const oldSave = deferred<string>();
let current = { endpoint: "/a", generation: 1 };
const request = { ...current };
const observed: string[] = [];
const completion = oldSave.promise.then((value) => {
  if (confirmationResponseIsCurrent({ request, current, open: true })) observed.push(value);
});
// A→B→A: endpoint는 같아졌지만 새 open/reload 세대다.
current = { endpoint: "/b", generation: 2 };
current = { endpoint: "/a", generation: 3 };
oldSave.resolve("stale");
await completion;
assert.deepEqual(observed, []);

assert.equal(confirmationResponseIsCurrent({
  request: { endpoint: "/a", generation: 3 },
  current,
  open: false,
}), false, "닫기→동일 scope 재열기 전의 응답은 폐기한다");
assert.equal(confirmationResponseIsCurrent({ request: current, current, open: true }), true);

const strictFirstRequest = { endpoint: "/strict", generation: 1 };
const strictCleanup = invalidateConfirmationRequestScope({
  request: strictFirstRequest,
  current: { ...strictFirstRequest, key: "open:/strict:0" },
});
assert.deepEqual(strictCleanup, {
  endpoint: "/strict",
  generation: 2,
  key: "open:/strict:0",
}, "StrictMode cleanup은 동일 render key를 보존해야 한다");
const strictSecondRequest = { ...strictCleanup };
assert.equal(confirmationResponseIsCurrent({
  request: strictSecondRequest,
  current: strictCleanup,
  open: true,
}), true, "cleanup 직후 setup한 두 번째 GET은 동일 props 재렌더에도 유효하다");
assert.equal(invalidateConfirmationRequestScope({
  request: strictFirstRequest,
  current: strictCleanup,
}), strictCleanup, "이전 effect cleanup은 새 세대를 다시 무효화하지 않는다");

const unmountedSave = deferred<string>();
const unmountedRequest = { endpoint: "/a", generation: 4 };
let unmountedCurrent = { ...unmountedRequest };
const unmountedObserved: string[] = [];
const unmountedCompletion = unmountedSave.promise.then((value) => {
  if (confirmationResponseIsCurrent({
    request: unmountedRequest,
    current: unmountedCurrent,
    open: true,
  })) unmountedObserved.push(value);
});
unmountedCurrent = { ...unmountedCurrent, generation: 5 };
unmountedSave.resolve("stale-after-unmount");
await unmountedCompletion;
assert.deepEqual(unmountedObserved, []);

assert.equal(confirmationResultAction({
  hasCompany: true,
  hasMatch: false,
  refreshStatus: "failed",
}), "reload_with_notice", "답변 저장 뒤 재계산 실패는 stale 화면을 두지 않고 재조회한다");
assert.equal(confirmationResultAction({
  hasCompany: true,
  hasMatch: false,
  refreshStatus: "stale",
}), "reload_with_notice");
assert.equal(confirmationResultAction({
  hasCompany: true,
  hasMatch: true,
  refreshStatus: "not_persisted_user_scope",
}), "reload", "user overlay 응답은 shared card를 직접 치환하지 않고 회사 상태를 재조회한다");
assert.equal(confirmationResultAction({ hasCompany: false, hasMatch: false }), "ignore");
assert.equal(confirmationResultAction({ hasCompany: false, hasMatch: true }), "replace");

console.log("confirmation-request-scope: ok");
