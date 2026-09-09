import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { matchGrantCriteria, RULESET_VERSION } from "../matching/match.js";
import { toMatchCard } from "../use-cases/match-card.js";
import { answerableHardUnknownDimensions, hasUnanswerableHardUnknown } from "../use-cases/select-match-cards.js";

const premises: GrantCriterion = {
  id: "premises-criterion",
  dimension: "premises",
  kind: "required",
  operator: "exists",
  value: {
    schemaVersion: "premises-v1",
    state: "registered_current_site",
    sidoCodes: ["11"],
    facilityTypes: ["headquarters"],
    facilitySemantics: "any",
    basisDate: "2026-09-09",
  },
  source_span: "2026년 9월 9일 현재 서울특별시에 등록된 본사를 둔 기업",
  confidence: 1,
  needs_review: false,
};

const company: CompanyProfile = {
  region: { code: "26", label: "부산" },
  premises: {
    schemaVersion: "premises-v1",
    locations: [{
      locationId: "00000000-0000-4000-8000-000000000001",
      facilityType: "headquarters",
      sidoCode: "11",
      validFrom: "2026-01-01",
      validTo: null,
    }],
    coverage: {
      facilityTypes: ["headquarters"],
      validFrom: "2026-01-01",
      validTo: "2026-09-09",
      asOf: "2026-09-08T15:30:00.000Z",
      completeness: "complete",
    },
  },
  profile_evidence: {
    premises: {
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      asOf: "2026-09-08T15:30:00.000Z",
      axisCompleteness: "complete",
      confidence: 0.6,
      scope: "user",
      persistenceClass: "portable_user_answer",
    },
  },
};

const matched = matchGrantCriteria([premises], company, {
  asOf: new Date("2026-09-08T15:30:00.000Z"),
});
assert.equal(RULESET_VERSION, "ruleset-kstartup-spine-v14");
assert.equal(matched.eligibility, "eligible", "premises must use its own location, never company.region");
assert.equal(matched.rule_trace[0]?.result, "pass");

const withoutPremises = matchGrantCriteria([premises], {
  region: { code: "11", label: "서울" },
  profile_evidence: company.profile_evidence?.premises
    ? { premises: company.profile_evidence.premises }
    : {},
}, { asOf: new Date("2026-09-08T15:30:00.000Z") });
assert.equal(withoutPremises.eligibility, "conditional", "region must not infer premises");
assert.equal(withoutPremises.rule_trace[0]?.unresolved_reason, "company_profile_missing");
assert.equal(withoutPremises.next_question, undefined, "premises uses the dedicated editor, not generic spotlight");
const premiseCard = toMatchCard({
  item: {
    grant: {
      id: "grant-premises",
      source: "bizinfo",
      source_id: "premises-v1-fixture",
      title: "등록 사업장 조건 공고",
      status: "open",
      overall_confidence: 1,
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
    },
    criteria: [premises],
    raw: { source: "bizinfo", source_id: "premises-v1-fixture", payload: {}, status: "published" },
  } as NormalizedGrant<unknown>,
  match: withoutPremises,
});
assert.equal(premiseCard.ruleTrace[0]?.confirmationNextAction, "company_profile");
assert.deepEqual([...answerableHardUnknownDimensions(premiseCard)], ["premises"]);
assert.equal(hasUnanswerableHardUnknown(premiseCard), false, "dedicated premises input must make the exact criterion answerable");

const legacyOther: GrantCriterion = {
  id: "legacy-premises-text",
  dimension: "other",
  kind: "required",
  operator: "text_only",
  value: {
    note: "서울특별시 강남구 사업장",
    original_dimension: "premises",
    downgrade_reason: "reserved_dimension",
  },
  source_span: "서울특별시 강남구 사업장",
  confidence: 0.9,
  needs_review: true,
};
const mixed = matchGrantCriteria([premises, legacyOther], company, {
  asOf: new Date("2026-09-08T15:30:00.000Z"),
});
assert.equal(mixed.eligibility, "conditional");
assert.deepEqual(mixed.rule_trace.map((trace) => trace.result), ["pass", "unknown"]);
assert.equal(mixed.rule_trace[1]?.unresolved_reason, "criterion_needs_review");

console.log("premises-v1 matching integration tests passed");
