import assert from "node:assert/strict";
import {
  promotionStateMatchesParentOrMigration,
  resolveLegacyQuestionMigrationServingStates,
  type LegacyQuestionMigrationServingRow,
} from "./legacyQuestionMigrationServing";

const parentPromotionItemId = "10000000-0000-4000-8000-000000000001";
const grantId = "20000000-0000-4000-8000-000000000001";
const parentAfterSha256 = "a".repeat(64);
const firstSuccessorSha256 = "b".repeat(64);
const secondSuccessorSha256 = "c".repeat(64);

function row(overrides: Partial<LegacyQuestionMigrationServingRow> = {}): LegacyQuestionMigrationServingRow {
  return {
    releaseDbId: "30000000-0000-4000-8000-000000000001",
    parentPromotionItemId,
    grantId,
    releaseStatus: "active",
    itemStatus: "applied",
    servingStateSha256: firstSuccessorSha256,
    appliedAt: new Date("2026-09-22T01:00:00.000Z"),
    ...overrides,
  };
}

const multiItemRelease = resolveLegacyQuestionMigrationServingStates([
  row(),
  row({ servingStateSha256: firstSuccessorSha256 }),
  row({
    releaseDbId: "30000000-0000-4000-8000-000000000002",
    servingStateSha256: secondSuccessorSha256,
    appliedAt: new Date("2026-09-22T02:00:00.000Z"),
  }),
]);
assert.equal(multiItemRelease.get(parentPromotionItemId)?.servingStateSha256, secondSuccessorSha256);
assert.equal(promotionStateMatchesParentOrMigration({
  currentStateSha256: secondSuccessorSha256,
  parentAfterSha256,
  successor: multiItemRelease.get(parentPromotionItemId),
  grantId,
}), true);
assert.equal(promotionStateMatchesParentOrMigration({
  currentStateSha256: "d".repeat(64),
  parentAfterSha256,
  successor: multiItemRelease.get(parentPromotionItemId),
  grantId,
}), false);
assert.equal(promotionStateMatchesParentOrMigration({
  currentStateSha256: parentAfterSha256,
  parentAfterSha256,
  grantId,
}), true);

const ambiguous = resolveLegacyQuestionMigrationServingStates([
  row(),
  row({
    releaseDbId: "30000000-0000-4000-8000-000000000002",
    servingStateSha256: secondSuccessorSha256,
  }),
]);
assert.equal(ambiguous.has(parentPromotionItemId), false, "동시 최신 release는 임의 선택하지 않는다");

const inconsistentRelease = resolveLegacyQuestionMigrationServingStates([
  row(),
  row({ servingStateSha256: secondSuccessorSha256 }),
]);
assert.equal(inconsistentRelease.has(parentPromotionItemId), false, "한 release의 serving receipt가 갈리면 닫는다");

console.log("PASS: legacy question migration serving accepts only the exact unique successor frontier");
