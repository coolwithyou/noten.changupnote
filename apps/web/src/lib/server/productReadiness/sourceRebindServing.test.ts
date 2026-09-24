import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSourceRebindServingStates,
  sourceRebindMatchesCurrent,
} from "./sourceRebindServing";

const PARENT_ID = "00000000-0000-4000-8000-000000000911";
const GRANT_ID = "00000000-0000-4000-8000-000000000912";
const row = {
  parentPromotionItemId: PARENT_ID,
  grantId: GRANT_ID,
  previousSourceRevisionSha256: "a".repeat(64),
  previousSourceRawSha256: "b".repeat(64),
  currentSourceRevisionSha256: "c".repeat(64),
  currentSourceRawSha256: "d".repeat(64),
  currentMaterialSourceRevisionSha256: "e".repeat(64),
  servingStateSha256: "f".repeat(64),
  appliedAt: new Date("2026-09-22T12:00:00.000Z"),
  releaseStatus: "active",
  itemStatus: "applied",
};

test("유일한 active/applied source successor만 current source와 결속한다", () => {
  const state = resolveSourceRebindServingStates([row]).get(PARENT_ID);
  assert.ok(state);
  assert.equal(sourceRebindMatchesCurrent({
    state,
    grantId: GRANT_ID,
    currentStateSha256: row.servingStateSha256,
    currentSourceRevisionSha256: row.currentSourceRevisionSha256,
    currentSourceRawSha256: row.currentSourceRawSha256,
    currentMaterialSourceRevisionSha256: row.currentMaterialSourceRevisionSha256,
  }), true);
  assert.equal(sourceRebindMatchesCurrent({
    state,
    grantId: GRANT_ID,
    currentStateSha256: row.servingStateSha256,
    currentSourceRevisionSha256: row.currentSourceRevisionSha256,
    currentSourceRawSha256: "0".repeat(64),
    currentMaterialSourceRevisionSha256: row.currentMaterialSourceRevisionSha256,
  }), false);
});

test("같은 parent의 중복 successor와 불완전 receipt는 fail-closed한다", () => {
  assert.equal(resolveSourceRebindServingStates([row, { ...row }]).size, 0);
  assert.equal(resolveSourceRebindServingStates([{ ...row, releaseStatus: "approved" }]).size, 0);
});

test("같은 parent의 연속 evidence refresh는 분기 없는 최신 frontier로 이어진다", () => {
  const next = {
    ...row,
    previousSourceRevisionSha256: row.currentSourceRevisionSha256,
    previousSourceRawSha256: row.currentSourceRawSha256,
    currentSourceRevisionSha256: "1".repeat(64),
    currentSourceRawSha256: "2".repeat(64),
    currentMaterialSourceRevisionSha256: row.currentMaterialSourceRevisionSha256,
    servingStateSha256: "4".repeat(64),
    appliedAt: new Date("2026-09-22T13:00:00.000Z"),
  };
  const state = resolveSourceRebindServingStates([row, next]).get(PARENT_ID);
  assert.equal(state?.rootSourceRevisionSha256, row.previousSourceRevisionSha256);
  assert.equal(state?.previousSourceRevisionSha256, row.currentSourceRevisionSha256);
  assert.equal(state?.currentSourceRevisionSha256, next.currentSourceRevisionSha256);
  assert.equal(state?.servingStateSha256, next.servingStateSha256);
  assert.deepEqual(state?.sourceRevisionChain, [
    row.previousSourceRevisionSha256,
    row.currentSourceRevisionSha256,
    next.currentSourceRevisionSha256,
  ]);
  assert.equal(resolveSourceRebindServingStates([
    row,
    next,
    { ...next, currentSourceRevisionSha256: "5".repeat(64) },
  ]).size, 0);
});

console.log("source rebind serving: successor frontier fixtures passed");
