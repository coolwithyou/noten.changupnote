import assert from "node:assert/strict";
import { RULESET_VERSION, SCORING_VERSION } from "../matching/match.js";
import { buildMatchingV3PairReviewTasks } from "./pair-review-packet.js";

const tasks = buildMatchingV3PairReviewTasks({
  grants: [{
    recordType: "grant",
    schemaVersion: "matching-v3",
    grantId: "bizinfo:g1",
    source: "bizinfo",
    sourceId: "g1",
    title: "서울 AI 기업 지원",
    audience: "company",
    sourceFixture: "fixture",
    sourceRevision: "revision-1",
    labelStatus: "draft",
    criteria: [{
      criterionId: "c1",
      dimension: "region",
      kind: "required",
      operator: "in",
      value: { regions: ["11"] },
      sourceSpan: "서울 소재 기업",
      sourceField: "target",
      annotationConfidence: 1,
      note: null,
    }],
  }],
  companies: [{
    recordType: "company",
    schemaVersion: "matching-v3",
    companyId: "company-1",
    businessKind: "corporation",
    profile: { region: { code: "11" }, confidence: { region: 1 } },
    sourceFixture: "synthetic",
    labelStatus: "draft",
  }],
});
assert.equal(tasks.length, 1);
assert.equal(tasks[0]?.predictedEligibility, "eligible");
assert.equal(tasks[0]?.annotationTemplate.labelStatus, "draft");
assert.equal(tasks[0]?.annotationTemplate.note, "ENGINE_PREDICTION_REQUIRES_INDEPENDENT_REVIEW");
assert.equal(tasks[0]?.annotationTemplate.resolvableByProfileInput, null);
assert.equal(tasks[0]?.rulesetVer, RULESET_VERSION);
assert.equal(tasks[0]?.scoringVer, SCORING_VERSION);
assert.match(tasks[0]?.inputFingerprint ?? "", /^[a-f0-9]{64}$/);
assert.equal(tasks[0]?.annotationTemplate.inputFingerprint, tasks[0]?.inputFingerprint);
assert.equal(tasks[0]?.annotationTemplate.rulesetVer, RULESET_VERSION);
assert.equal(tasks[0]?.annotationTemplate.scoringVer, SCORING_VERSION);
assert.equal(JSON.stringify(tasks[0]).includes("company_value"), false);
const changedInput = buildMatchingV3PairReviewTasks({
  grants: [{ ...tasks[0]!.annotationTemplate, recordType: "grant", criteria: [{
    criterionId: "c1", dimension: "region", kind: "required", operator: "in",
    value: { regions: ["11"] }, sourceSpan: "서울 소재 기업", sourceField: "target",
    annotationConfidence: 1, note: null,
  }], grantId: "bizinfo:g1", source: "bizinfo", sourceId: "g1", title: "서울 AI 기업 지원",
    audience: "company", sourceFixture: "fixture", sourceRevision: "revision-1" }],
  companies: [{
    recordType: "company", schemaVersion: "matching-v3", companyId: "company-1",
    businessKind: "corporation", profile: { region: { code: "41" }, confidence: { region: 1 } },
    sourceFixture: "synthetic", labelStatus: "draft",
  }],
});
assert.notEqual(changedInput[0]?.inputFingerprint, tasks[0]?.inputFingerprint);
assert.throws(() => buildMatchingV3PairReviewTasks({
  grants: [{
    recordType: "grant", schemaVersion: "matching-v3", grantId: "bizinfo:g1", source: "bizinfo", sourceId: "g1",
    title: "legacy", audience: "unknown", criteria: [], sourceFixture: "fixture", labelStatus: "legacy",
  }],
  companies: [{
    recordType: "company", schemaVersion: "matching-v3", companyId: "c", businessKind: "unknown",
    profile: {}, sourceFixture: "fixture", labelStatus: "draft",
  }],
}), /legacy grant/);
console.log("pair-review-packet.test.ts: all assertions passed");
