import assert from "node:assert/strict";
import { promotionGrantSnapshotHashes, toPromotionQuestionSnapshot } from "./promotionSnapshot";

const base = {
  id: "00000000-0000-4000-8000-000000000201",
  grantId: "00000000-0000-4000-8000-000000000200",
  grantCriteriaId: "00000000-0000-4000-8000-000000000202",
  evaluationCriterionId: null,
  evaluationContractVersion: null,
  sourceRevisionSha256: null,
  sourceRawSha256: null,
  criterionStableKey: "stable",
  definitionSha256: "definition",
  version: 1,
  supersedesQuestionId: null,
  criterionRef: null,
  prompt: "질문",
  options: [{ value: "yes", label: "예", disqualifies: true }],
  answerType: "single",
  reusable: "per_notice",
  conditionKey: null,
  promptVer: "legacy",
  provenance: {},
  invalidatedAt: null,
  invalidationReason: null,
  createdAt: new Date("2026-09-07T00:00:00.000Z"),
};
const legacy = toPromotionQuestionSnapshot(base);
assert.equal(Object.prototype.hasOwnProperty.call(legacy, "evaluationCriterionId"), false);
assert.equal(Object.prototype.hasOwnProperty.call(legacy, "sourceRevisionSha256"), false);
const legacyWithoutMigrationColumns = { ...base } as Record<string, unknown>;
delete legacyWithoutMigrationColumns.evaluationCriterionId;
delete legacyWithoutMigrationColumns.evaluationContractVersion;
delete legacyWithoutMigrationColumns.sourceRevisionSha256;
delete legacyWithoutMigrationColumns.sourceRawSha256;
const projectedBeforeMigration = toPromotionQuestionSnapshot({
  ...legacyWithoutMigrationColumns,
  evaluationCriterionId: null,
  evaluationContractVersion: null,
  sourceRevisionSha256: null,
  sourceRawSha256: null,
} as typeof base);
assert.deepEqual(legacy, projectedBeforeMigration);

const v2 = toPromotionQuestionSnapshot({
  ...base,
  grantCriteriaId: null,
  evaluationCriterionId: base.grantCriteriaId,
  evaluationContractVersion: "confirmation-evaluation-v2",
  sourceRevisionSha256: "a".repeat(64),
  sourceRawSha256: "b".repeat(64),
});
assert.equal(v2.evaluationCriterionId, base.grantCriteriaId);
assert.equal(v2.sourceRawSha256, "b".repeat(64));
const empty = {
  grantId: base.grantId,
  authoringGuide: null,
  criteria: [],
  answerBindings: [],
  dedupComponentGrantIds: [base.grantId],
  dedupLinks: [],
};
assert.notEqual(
  promotionGrantSnapshotHashes({ ...empty, questions: [legacy] }).questionsSha256,
  promotionGrantSnapshotHashes({ ...empty, questions: [v2] }).questionsSha256,
);

console.log("promotion-snapshot: ok");
