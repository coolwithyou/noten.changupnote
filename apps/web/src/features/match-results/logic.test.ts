import assert from "node:assert/strict";
import { buildCompanyEvidence, mergeCompanyProfilesForEnrichment } from "@/lib/server/serviceData";
import { normalizeManualProfile } from "@/lib/server/teaser/resolveTeaserCompanyProfile";
import {
  buildProfilePatch,
  mergeCompanyProfileForRequest,
  profileInputSuggestions,
  sanitizeManualProfileForStorage,
} from "./logic";

assert.deepEqual(profileInputSuggestions("target_type"), ["개인사업자", "법인"]);

const patch = buildProfilePatch("target_type", {
  value: "법인",
  secondaryValue: "",
  unit: "manwon",
});
assert.ok("profile" in patch);
if ("profile" in patch) {
  assert.deepEqual(patch.profile.target_types, ["법인"]);
  assert.equal(patch.profile.list_completeness?.target_type, "partial");
  assert.equal(patch.profile.confidence?.target_type, 0.78);

  const normalized = normalizeManualProfile(patch.profile as Record<string, unknown>);
  assert.deepEqual(normalized.target_types, ["법인"]);
  assert.equal(normalized.list_completeness?.target_type, "partial");
  assert.equal(normalized.confidence?.target_type, 0.6, "anonymous self-declared confidence는 0.6을 넘으면 안 됨");
  assert.equal(normalized.profile_evidence?.target_type?.sourceKind, "self_declared");

  const evidence = buildCompanyEvidence({
    provider: "manual",
    source: "manual_profile",
    cacheStatus: "none",
    profile: normalized,
    summary: "test",
  });
  const targetTypeField = evidence.fields.find((field) => field.key === "target_type");
  assert.equal(targetTypeField?.available, true);
  assert.equal(targetTypeField?.value, "법인");
}

const invalid = buildProfilePatch("target_type", {
  value: "기타",
  secondaryValue: "",
  unit: "manwon",
});
assert.ok("error" in invalid);

const expanded = normalizeManualProfile({
  region: { code: "26", label: "부산" },
  prior_awards: ["지역지원사업"],
  ip: ["특허"],
  tax_compliance: {
    flags: [],
    known_flags: ["national_tax_delinquent", "local_tax_delinquent"],
    exceptions: [],
  },
  financial_health: {
    debt_ratio_pct: 120.5,
    interest_coverage_ratio: -0.4,
    impairment: "none",
    fiscal_year: "2025",
  },
  insured_workforce: {
    employment_insurance_active: true,
    insured_count: 12,
    no_layoff: true,
  },
  investment: {
    total_raised_krw: 100_000_000,
    last_round: "Seed",
    tips_backed: false,
  },
  confidence: {
    region: 1,
    prior_award: 0.95,
    tax_compliance: 0.9,
    financial_health: 0.8,
    absent_dimension: 1,
  },
  profile_evidence: {
    region: {
      sourceKind: "authoritative_api",
      provider: "forged-client",
      asOf: "2026-07-12T00:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 1,
    },
  },
});
assert.deepEqual(expanded.prior_awards, ["지역지원사업"]);
assert.deepEqual(expanded.ip, ["특허"]);
assert.deepEqual(expanded.tax_compliance?.known_flags, ["national_tax_delinquent", "local_tax_delinquent"]);
assert.equal(expanded.financial_health?.interest_coverage_ratio, -0.4);
assert.equal(expanded.insured_workforce?.insured_count, 12);
assert.equal(expanded.investment?.total_raised_krw, 100_000_000);
assert.equal(expanded.confidence?.region, 0.6);
assert.equal((expanded.confidence as Record<string, number> | undefined)?.absent_dimension, undefined);
assert.equal(expanded.profile_evidence?.region?.provider, "cunote_teaser_manual", "client provenance 위조는 폐기해야 함");

const authoritativeBase = {
  region: { code: "11", label: "서울" },
  confidence: { region: 0.9 },
  profile_evidence: {
    region: {
      sourceKind: "authoritative_api" as const,
      provider: "popbill",
      asOf: "2026-07-12T00:00:00.000Z",
      axisCompleteness: "complete" as const,
      confidence: 0.9,
    },
  },
};
const authorityMerged = mergeCompanyProfilesForEnrichment(authoritativeBase, expanded);
assert.deepEqual(authorityMerged.region, { code: "11", label: "서울" }, "anonymous manual region이 authoritative 값을 덮으면 안 됨");
assert.equal(authorityMerged.profile_evidence?.region?.provider, "popbill");
assert.equal(authorityMerged.profile_evidence?.region?.supplemental?.[0]?.provider, "cunote_teaser_manual");
assert.equal(authorityMerged.financial_health?.debt_ratio_pct, 120.5, "권위값이 없는 축의 self-declared 값은 보존");

const unknownExpiry = new Date(Date.now() + 90 * 86_400_000).toISOString();
const unknownNormalized = normalizeManualProfile({
  question_answer_state: {
    founder_age: {
      status: "unknown",
      answeredAt: new Date().toISOString(),
      expiresAt: unknownExpiry,
      sourceKind: "authoritative_api",
      rulesetVer: "ruleset-test",
    },
  },
});
assert.equal(unknownNormalized.question_answer_state?.founder_age?.sourceKind, "self_declared");
assert.ok(
  Date.parse(unknownNormalized.question_answer_state?.founder_age?.expiresAt ?? "") <= Date.now() + 30 * 86_400_000 + 1_000,
  "client unknown TTL은 30일을 넘으면 안 됨",
);

const accumulated = mergeCompanyProfileForRequest({
  financial_health: { debt_ratio_pct: 120 },
  insured_workforce: { employment_insurance_active: true },
  list_completeness: { industry: "partial" },
}, {
  financial_health: { interest_coverage_ratio: 1.5 },
  insured_workforce: { insured_count: 8 },
  list_completeness: { certification: "partial" },
});
assert.equal(accumulated.financial_health?.debt_ratio_pct, 120);
assert.equal(accumulated.financial_health?.interest_coverage_ratio, 1.5);
assert.equal(accumulated.insured_workforce?.employment_insurance_active, true);
assert.equal(accumulated.insured_workforce?.insured_count, 8);
assert.equal(accumulated.list_completeness?.industry, "partial");
assert.equal(accumulated.list_completeness?.certification, "partial");

const storageSafe = sanitizeManualProfileForStorage({
  region: { code: "11", label: "서울" },
  tax_compliance: { flags: ["national_tax_delinquent"], known_flags: [], exceptions: [] },
  financial_health: { debt_ratio_pct: 120 },
  insured_workforce: { insured_count: 8 },
  investment: { total_raised_krw: 100_000_000 },
  confidence: { region: 0.6, tax_compliance: 0.6, financial_health: 0.6 },
  profile_evidence: {
    region: {
      sourceKind: "self_declared",
      provider: "test",
      asOf: null,
      axisCompleteness: "complete",
      confidence: 0.6,
    },
  },
});
assert.deepEqual(storageSafe.region, { code: "11", label: "서울" });
assert.equal(storageSafe.tax_compliance, undefined);
assert.equal(storageSafe.financial_health, undefined);
assert.equal(storageSafe.insured_workforce, undefined);
assert.equal(storageSafe.investment, undefined);
assert.equal(storageSafe.confidence?.tax_compliance, undefined);
assert.equal(storageSafe.profile_evidence, undefined);

console.log("match-results/logic: ok");
