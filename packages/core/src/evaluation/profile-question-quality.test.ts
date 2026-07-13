import assert from "node:assert/strict";
import { buildProfileQuestionQualityReport, type ProfileQuestionQualityRecord } from "./profile-question-quality.js";

const records: ProfileQuestionQualityRecord[] = [];
for (let session = 1; session <= 10; session += 1) {
  const sessionId = `00000000-0000-4000-8000-${String(session).padStart(12, "0")}`;
  const resolutionQuestion = session <= 5 ? 2 : 3;
  for (let question = 1; question <= 3; question += 1) {
    records.push({
      id: `${session}-${question}`,
      sessionId,
      timestamp: `2026-07-${String(session).padStart(2, "0")}T00:0${question}:00.000Z`,
      rulesetVer: "ruleset-v3",
      dimension: question === 1 ? "industry" : "revenue",
      targetedConditionalCount: 2,
      dimensionResolvedGrantCount: question === 1 ? 0 : 2,
      eligibilityResolvedCount: question === resolutionQuestion ? 2 : 0,
    });
  }
}

const report = buildProfileQuestionQualityReport({
  records,
  periodStart: new Date("2026-07-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-01T00:00:00.000Z"),
});
assert.equal(report.eventCount, 30);
assert.equal(report.sessionCount, 10);
assert.equal(report.resolvedSessionCount, 10);
assert.equal(report.unresolvedSessionCount, 0);
assert.equal(report.targetedConditionalCount, 60);
assert.equal(report.dimensionResolvedGrantCount, 40);
assert.equal(report.eligibilityResolvedCount, 20);
assert.equal(report.conditionalResolutionRate, 0.3333);
assert.equal(report.questionsToFirstResolutionP50, 2.5);
assert.deepEqual(report.rulesetCounts, { "ruleset-v3": 30 });
assert.equal(report.mixedRulesets, false);
assert.equal(report.sampleReady, true);
assert.equal(report.operationalReady, false, "표본이 충분해도 해소율 0.6 미만이면 gate를 열지 않는다");
assert.equal(report.byDimension.industry?.conditionalResolutionRate, 0);
assert.equal(report.byDimension.revenue?.dimensionResolutionRate, 1);

const passing = buildProfileQuestionQualityReport({
  records: records.map((record) => ({
    ...record,
    eligibilityResolvedCount: record.id.endsWith("-2") ? 2 : 0,
  })),
  periodStart: new Date("2026-07-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-01T00:00:00.000Z"),
});
assert.equal(passing.conditionalResolutionRate, 0.3333);
assert.equal(passing.questionsToFirstResolutionP50, 2);

const gatePassing = buildProfileQuestionQualityReport({
  records: records.map((record) => ({
    ...record,
    targetedConditionalCount: 1,
    dimensionResolvedGrantCount: 1,
    eligibilityResolvedCount: record.id.endsWith("-1") || record.id.endsWith("-2") ? 1 : 0,
  })),
  periodStart: new Date("2026-07-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-01T00:00:00.000Z"),
});
assert.equal(gatePassing.conditionalResolutionRate, 0.6667);
assert.equal(gatePassing.questionsToFirstResolutionP50, 1);
assert.equal(gatePassing.operationalReady, true);

const mixedRulesets = buildProfileQuestionQualityReport({
  records: gatePassing.eventCount > 0
    ? records.map((record, index) => ({ ...record, rulesetVer: index === 0 ? "ruleset-v4" : "ruleset-v3" }))
    : [],
  periodStart: new Date("2026-07-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-01T00:00:00.000Z"),
});
assert.equal(mixedRulesets.mixedRulesets, true);
assert.equal(mixedRulesets.operationalReady, false);

console.log("profile-question-quality: ok");
