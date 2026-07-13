import assert from "node:assert/strict";
import { buildMatchingV3CompanyReviewTasks, renderMatchingV3ReviewWorkbench, validateIndependentAnnotation } from "./review-workbench.js";
import type { MatchingV3GrantReviewTask, MatchingV3PairReviewTask } from "../index.js";

const grant = {
  recordType: "grant_review_task", schemaVersion: "matching-v3-review-task-v1", grantId: "bizinfo:g1",
  source: "bizinfo", sourceId: "g1", title: "테스트 </script> 공고", readiness: "partial", warnings: [], sourceFixture: "fixture",
  sourceFields: { target: "기업" }, attachments: [], predictedCriteria: [], annotationTemplate: {
    recordType: "grant", schemaVersion: "matching-v3", grantId: "bizinfo:g1", source: "bizinfo", sourceId: "g1",
    title: "테스트 공고", audience: "company", criteria: [], sourceFixture: "fixture", sourceRevision: "r1", labelStatus: "draft",
  },
} as MatchingV3GrantReviewTask;
const pair = (split: "development" | "holdout"): MatchingV3PairReviewTask => ({
  recordType: "eligibility_pair_review_task", schemaVersion: "matching-v3-pair-review-task-v1", pairId: `bizinfo:g1::${split}`,
  grantId: "bizinfo:g1", companyId: split, businessKind: "corporation", grantSourceRevision: "r1",
  rulesetVer: "ruleset-test", scoringVer: "scoring-test", inputFingerprint: "a".repeat(64),
  predictedEligibility: "conditional", predictedTrace: [], profileDimensionsPresent: [], annotationTemplate: {
    recordType: "eligibility_pair", schemaVersion: "matching-v3", pairId: `bizinfo:g1::${split}`, grantId: "bizinfo:g1",
    companyId: split, expectedEligibility: "conditional", split, hardFailCriterionIds: [], unknownCriterionIds: [],
    resolvableByProfileInput: null, note: "ENGINE_PREDICTION_REQUIRES_INDEPENDENT_REVIEW", labelStatus: "draft",
    rulesetVer: "ruleset-test", scoringVer: "scoring-test", inputFingerprint: "a".repeat(64),
  },
});
const companyTasks = buildMatchingV3CompanyReviewTasks([{
  recordType: "company", schemaVersion: "matching-v3", companyId: "company-1", businessKind: "corporation",
  profile: { region: { code: "11" } }, sourceFixture: "synthetic", labelStatus: "draft",
}]);
const html = renderMatchingV3ReviewWorkbench({ companyTasks, grantTasks: [grant], pairTasks: [pair("development"), pair("holdout")] });
const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 2);
assert.doesNotThrow(() => new Function(scripts.at(-1)?.[1] ?? ""), "generated browser script must compile");
assert.equal(html.includes("Content-Security-Policy"), true);
assert.equal(html.includes("connect-src 'none'"), true);
assert.equal(html.includes("bizinfo:g1::development"), true);
assert.equal(html.includes("bizinfo:g1::holdout"), false);
assert.equal(html.includes("const key=t=>(t.pairId||t.grantId||t.companyId)"), true, "each annotation type needs stable storage identity");
assert.equal(html.includes("id=a.pairId||a.grantId||a.companyId"), true, "pair, grant, and company imports must use the same stable identity order");
assert.equal(html.includes("company-1"), true);
assert.equal(html.includes("</script> 공고"), false, "embedded task text must not break script tag");
const withHoldout = renderMatchingV3ReviewWorkbench({ grantTasks: [grant], pairTasks: [pair("holdout")], includeHoldout: true });
assert.equal(withHoldout.includes("bizinfo:g1::holdout"), true);
const holdoutPacket = withHoldout.match(/<script id="packet" type="application\/json">([\s\S]*?)<\/script>/)?.[1] ?? "";
assert.equal(holdoutPacket.includes('"predictedEligibility"'), false, "holdout packet must hide engine eligibility");
assert.equal(holdoutPacket.includes('"predictedTrace"'), false, "holdout packet must hide engine trace");
assert.equal(holdoutPacket.includes('"expectedEligibility":null'), true, "holdout annotation must require an independent label");
assert.deepEqual(validateIndependentAnnotation(pair("development").annotationTemplate), [
  "bizinfo:g1::development: independent review note required",
  "bizinfo:g1::development: resolvableByProfileInput must be decided",
]);
assert.deepEqual(validateIndependentAnnotation({
  ...pair("development").annotationTemplate,
  note: "공고 조건과 프로필을 대조함",
  resolvableByProfileInput: true,
}), []);
console.log("review-workbench.test.ts: all assertions passed");
