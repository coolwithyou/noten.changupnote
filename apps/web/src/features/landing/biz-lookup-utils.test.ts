import assert from "node:assert/strict";
import { previewCheckedAtNotice, previewRefreshNotice } from "./biz-lookup-utils";

const checkedAt = "2026-03-01T15:00:00.000Z";
assert.equal(
  previewCheckedAtNotice(checkedAt, new Date("2026-03-08T15:00:00.000Z")),
  null,
  "exactly 7 days stays quiet",
);
assert.equal(
  previewCheckedAtNotice(checkedAt, new Date("2026-03-08T15:00:00.001Z")),
  "3월 2일에 확인한 정보예요",
);
assert.equal(
  previewCheckedAtNotice("2026-03-02T15:30:00.000Z", new Date("2026-03-20T00:00:00.000Z")),
  "3월 3일에 확인한 정보예요",
);
assert.equal(previewCheckedAtNotice(undefined, new Date()), null);
assert.equal(previewRefreshNotice("updated"), "최신 정보로 바꿨어요");
assert.equal(
  previewRefreshNotice("unchanged"),
  "국세청에 등록된 상호는 그대로예요. 반영까지 하루이틀 걸릴 수 있어요.",
);
assert.equal(previewRefreshNotice("already_fresh"), "방금 확인한 정보예요");
assert.equal(previewRefreshNotice("rate_limited"), "오늘은 이미 최신 정보를 확인했어요.");
assert.equal(
  previewRefreshNotice("failed"),
  "지금은 최신 정보를 가져오지 못했어요. 잠시 뒤 다시 눌러 주세요.",
);
assert.equal(previewRefreshNotice(undefined), null);
for (const notice of [
  previewRefreshNotice("updated"),
  previewRefreshNotice("unchanged"),
  previewRefreshNotice("already_fresh"),
  previewRefreshNotice("rate_limited"),
  previewRefreshNotice("failed"),
  previewCheckedAtNotice(checkedAt, new Date("2026-04-01T00:00:00.000Z")),
]) {
  assert.equal(/캐시|팝빌|과금|원천/.test(notice ?? ""), false);
}

console.log("biz-lookup-utils.test.ts: all assertions passed");
