import assert from "node:assert/strict";
import {
  GRANT_CHAT_TIMEOUT_MS,
  grantChatFailureMessage,
  isGrantChatBusyStatus,
} from "./chatRequestState";

assert.equal(isGrantChatBusyStatus("submitted"), true);
assert.equal(isGrantChatBusyStatus("streaming"), true);
assert.equal(isGrantChatBusyStatus("ready"), false);
assert.equal(isGrantChatBusyStatus("error"), false);
assert.ok(GRANT_CHAT_TIMEOUT_MS >= 20_000 && GRANT_CHAT_TIMEOUT_MS <= 30_000);
assert.match(grantChatFailureMessage("timeout"), /요청을 중단/);
assert.match(grantChatFailureMessage("request"), /다시 요청/);

console.log("apply-workspace chat request state tests passed");
