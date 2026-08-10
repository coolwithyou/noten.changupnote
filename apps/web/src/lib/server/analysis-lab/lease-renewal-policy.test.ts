import assert from "node:assert/strict";
import {
  initialLeaseRenewalFailureState,
  recordLeaseRenewalFailure,
  recordLeaseRenewalSuccess,
} from "./lease-renewal-policy";

{
  const state = initialLeaseRenewalFailureState();
  assert.deepEqual(recordLeaseRenewalFailure(state, "temporary outage"), {
    shouldAbort: false,
    consecutiveFailures: 1,
  });
  assert.equal(state.fatalErrorMessage, null);

  recordLeaseRenewalSuccess(state);
  assert.equal(state.consecutiveFailures, 0, "성공하면 일시 실패 누적을 초기화해야 한다");

  assert.deepEqual(recordLeaseRenewalFailure(state, "outage 1"), {
    shouldAbort: false,
    consecutiveFailures: 1,
  });
  assert.deepEqual(recordLeaseRenewalFailure(state, "outage 2"), {
    shouldAbort: true,
    consecutiveFailures: 2,
  });
  assert.equal(state.fatalErrorMessage, "outage 2");

  recordLeaseRenewalSuccess(state);
  assert.equal(state.consecutiveFailures, 2, "치명 실패 뒤 성공 응답이 상태를 되돌리면 안 된다");
}

console.log("analysis-lab lease renewal policy tests: ok");
