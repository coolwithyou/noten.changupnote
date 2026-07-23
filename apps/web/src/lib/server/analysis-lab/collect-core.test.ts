import assert from "node:assert/strict";
import {
  decideAuditCollectAction,
  latestAuditReceiptSha,
  receiptShaMatches,
  selectCollectableDispatchRowIds,
} from "./collect-core";
import {
  mergeHumanReviewOverlay,
  type HumanReviewOverlayItem,
} from "./human-review-overlay";

assert.equal(
  decideAuditCollectAction({
    expectedSha256: "before",
    currentSha256: "after",
    decisionsAlreadyApplied: true,
    reconcileOnly: false,
  }),
  "recover_receipt",
  "파일 쓰기 성공 뒤 DB 기록이 실패한 crash point는 재실행에서 receipt만 복구해야 한다",
);
assert.equal(
  decideAuditCollectAction({
    expectedSha256: "dispatch",
    currentSha256: "concurrent-edit",
    decisionsAlreadyApplied: false,
    reconcileOnly: false,
  }),
  "stale",
  "병행 파일 변경은 stale로 중단하고 강제 병합하면 안 된다",
);
assert.equal(
  decideAuditCollectAction({
    expectedSha256: "same",
    currentSha256: "same",
    decisionsAlreadyApplied: false,
    reconcileOnly: true,
  }),
  "skip_reconcile",
  "reconcile은 미적용 판정을 새로 쓰지 않는다",
);
assert.equal(
  decideAuditCollectAction({
    expectedSha256: "same",
    currentSha256: "same",
    decisionsAlreadyApplied: false,
    reconcileOnly: false,
  }),
  "write",
);
assert.equal(receiptShaMatches("after", "after"), true);
assert.equal(receiptShaMatches("after", "before"), false, "DB receipt만 있고 파일이 이전 상태면 역방향 crash를 탐지한다");
assert.equal(receiptShaMatches("after", null), false, "receipt 대상 파일 유실도 탐지한다");
assert.equal(
  latestAuditReceiptSha("dispatch", [
    { collectedAt: new Date("2026-07-23T01:00:00.000Z"), postSha256: "first" },
    { collectedAt: new Date("2026-07-23T02:00:00.000Z"), postSha256: "second" },
  ]),
  "second",
  "부분 수거 뒤 다음 CAS는 가장 최근 성공 receipt를 기준으로 이어야 한다",
);
assert.equal(latestAuditReceiptSha("dispatch", []), "dispatch");

const overlapPending = selectCollectableDispatchRowIds([
  { id: "single", overlapGroup: null, status: "decided", collectedAt: null },
  { id: "pair-a", overlapGroup: "pair", status: "decided", collectedAt: null },
  { id: "pair-b", overlapGroup: "pair", status: "pending", collectedAt: null },
]);
assert.deepEqual([...overlapPending], ["single"], "중복 표본 한쪽 판정만 파일에 먼저 섞으면 안 된다");
const overlapConflict = selectCollectableDispatchRowIds([
  { id: "pair-a", overlapGroup: "pair", status: "conflict", collectedAt: null },
  { id: "pair-b", overlapGroup: "pair", status: "conflict", collectedAt: null },
]);
assert.equal(overlapConflict.size, 0, "충돌은 3심 전까지 수거하지 않는다");
const overlapResolved = selectCollectableDispatchRowIds([
  { id: "pair-a", overlapGroup: "pair", status: "resolved", collectedAt: null },
  { id: "pair-b", overlapGroup: "pair", status: "resolved", collectedAt: null },
]);
assert.deepEqual([...overlapResolved].sort(), ["pair-a", "pair-b"], "3심 resolved 뒤 양측 row를 함께 수거한다");

const overlayItem: HumanReviewOverlayItem = {
  sourceItemKey: "overlay:c:1",
  itemKind: "criterion",
  criterionIndex: 1,
  humanVerdict: "correct",
  note: null,
  decidedBy: "reviewer@noten.im",
  decidedAt: "2026-07-23T00:00:00.000Z",
  revision: 1,
};
const first = mergeHumanReviewOverlay(null, {
  grantId: "grant",
  runId: "run",
  items: [overlayItem],
  now: overlayItem.decidedAt,
});
const duplicate = mergeHumanReviewOverlay(first, {
  grantId: "grant",
  runId: "run",
  items: [overlayItem],
  now: "2026-07-23T00:01:00.000Z",
});
assert.equal(duplicate.items.length, 1, "overlay 중복 수거는 같은 sourceItemKey를 증식시키면 안 된다");
assert.equal(duplicate.items[0]?.revision, 1);

console.log("collect-core tests: ok");
