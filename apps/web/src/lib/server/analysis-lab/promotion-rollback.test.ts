import assert from "node:assert/strict";
import { rollbackDriftReason } from "./promotion-rollback";

assert.equal(
  rollbackDriftReason({
    itemStatus: "applied",
    expectedAfterSha256: "same",
    currentSha256: "same",
  }),
  null,
);
assert.equal(
  rollbackDriftReason({
    itemStatus: "applied",
    expectedAfterSha256: "before",
    currentSha256: "changed",
  }),
  "rollback_drift",
);
assert.equal(
  rollbackDriftReason({
    itemStatus: "prepared",
    expectedAfterSha256: null,
    currentSha256: "anything",
  }),
  "item_status:prepared",
);

console.log("promotion rollback tests: ok");
