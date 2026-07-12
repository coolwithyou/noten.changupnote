import assert from "node:assert/strict";
import type { CompanyProfile, Grant, NormalizedGrant } from "@cunote/contracts";
import { planScopedMatchStateRefresh } from "./plan-scoped-match-state-refresh.js";

const company: CompanyProfile = { industries: ["AI"], confidence: { industry: 1 } };
const grant = normalizedGrant();
const first = planScopedMatchStateRefresh({
  scope: "pair",
  companies: [{ companyId: "company-1", profile: company }],
  grants: [grant],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.equal(first.stateCount, 1);
assert.equal(first.changedCount, 1);
assert.deepEqual(first.states[0]?.changeReasons, ["missing_state"]);
const state = first.states[0]!;
const unchanged = planScopedMatchStateRefresh({
  scope: "pair",
  companies: [{ companyId: "company-1", profile: company }],
  grants: [grant],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  existingStates: [{
    companyId: "company-1",
    grantId: state.grantId,
    eligibility: state.eligibility,
    fitScore: Math.round(state.fitScore),
    rulesetVer: state.rulesetVer,
    scoringVer: state.scoringVer,
    ruleTrace: state.match.rule_trace,
    eligibleFrom: state.eligibleFrom,
    eligibleUntil: state.eligibleUntil,
  }],
});
assert.equal(unchanged.changedCount, 0);
const changed = planScopedMatchStateRefresh({
  scope: "pair",
  companies: [{ companyId: "company-1", profile: company }],
  grants: [grant],
  existingStates: [{
    companyId: "company-1",
    grantId: state.grantId,
    eligibility: "ineligible",
    fitScore: 0,
    rulesetVer: "old",
    scoringVer: "old",
    ruleTrace: [],
    eligibleFrom: null,
    eligibleUntil: null,
  }],
});
assert.equal(changed.changedCount, 1);
assert.equal(changed.states[0]?.changeReasons.includes("eligibility"), true);

const extendedGrant = normalizedGrant();
extendedGrant.grant.apply_end = "2026-07-31T14:59:59.000Z";
const deadlineExtended = planScopedMatchStateRefresh({
  scope: "grant",
  companies: [{ companyId: "company-1", profile: company }],
  grants: [extendedGrant],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  existingStates: [{
    companyId: "company-1",
    grantId: state.grantId,
    eligibility: state.eligibility,
    fitScore: Math.round(state.fitScore),
    rulesetVer: state.rulesetVer,
    scoringVer: state.scoringVer,
    ruleTrace: state.match.rule_trace,
    eligibleFrom: state.eligibleFrom,
    eligibleUntil: state.eligibleUntil,
  }],
});
assert.equal(deadlineExtended.scope, "grant");
assert.equal(deadlineExtended.grantCount, 1);
assert.equal(deadlineExtended.changedCount, 0, "apply_end is read from grant data, not match-state transition window");

const criteriaRevisedGrant = normalizedGrant();
criteriaRevisedGrant.criteria[0] = {
  ...criteriaRevisedGrant.criteria[0]!,
  value: { tags: ["BIO"] },
};
const criteriaRevised = planScopedMatchStateRefresh({
  scope: "grant",
  companies: [{ companyId: "company-1", profile: company }],
  grants: [criteriaRevisedGrant],
  existingStates: [{
    companyId: "company-1",
    grantId: state.grantId,
    eligibility: state.eligibility,
    fitScore: Math.round(state.fitScore),
    rulesetVer: state.rulesetVer,
    scoringVer: state.scoringVer,
    ruleTrace: state.match.rule_trace,
    eligibleFrom: state.eligibleFrom,
    eligibleUntil: state.eligibleUntil,
  }],
});
assert.equal(criteriaRevised.changedCount, 1);
assert.equal(criteriaRevised.states[0]?.changeReasons.includes("eligibility"), true);
assert.equal(criteriaRevised.states[0]?.changeReasons.includes("rule_trace"), true);
assert.throws(() => planScopedMatchStateRefresh({
  scope: "pair", companies: [], grants: [grant],
}), /exactly one company/);
const manual = planScopedMatchStateRefresh({ scope: "manual", companies: [], grants: [] });
assert.equal(manual.stateCount, 0);
console.log("plan-scoped-match-state-refresh.test.ts: all assertions passed");

function normalizedGrant(): NormalizedGrant {
  const value: Grant = {
    id: "grant-uuid-1",
    source: "bizinfo",
    source_id: "grant-1",
    title: "AI 기업 지원",
    status: "open",
    f_regions: [],
    f_industries: ["AI"],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 1,
    apply_end: "2026-07-20T14:59:59.000Z",
  };
  return {
    raw: { source: "bizinfo", source_id: "grant-1", payload: {}, status: "normalized" },
    grant: value,
    criteria: [{
      id: "criterion-1",
      dimension: "industry",
      operator: "in",
      value: { tags: ["AI"] },
      kind: "required",
      confidence: 1,
      source_span: "AI 기업",
    }],
  };
}
