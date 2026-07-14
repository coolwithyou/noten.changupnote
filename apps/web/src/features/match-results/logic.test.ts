import assert from "node:assert/strict";
import type { MatchCard, ProductTeaserResult } from "@cunote/contracts";
import { buildCompanyEvidence, mergeCompanyProfilesForEnrichment } from "@/lib/server/serviceData";
import { normalizeManualProfile } from "@/lib/server/teaser/resolveTeaserCompanyProfile";
import {
  buildProfileAnswer,
  buildProfilePatch,
  groupMatchesForDisplay,
  matchingPrecision,
  matchVerdictStatus,
  profileFieldAsOfLabel,
  profileInputSuggestions,
  profileSheetValueState,
  summarizeAnswerImpact,
} from "./logic";

const openMatch = {
  grantId: "grant-open",
  status: "open",
  eligibility: "eligible",
  bucket: "now",
  recommendationTier: "recommendable",
} as MatchCard;
const answerMatch = {
  grantId: "grant-answer",
  status: "open",
  eligibility: "conditional",
  bucket: "conditional",
  recommendationTier: "needs_profile_input",
  ruleTrace: [{
    dimension: "region",
    result: "unknown",
    action: { type: "progressive", target: "region", label: "지금 확인" },
  }],
} as MatchCard;
const reviewMatch = {
  grantId: "grant-review",
  status: "open",
  eligibility: "conditional",
  bucket: "conditional",
  recommendationTier: "needs_core_review",
  ruleTrace: [],
} as unknown as MatchCard;
const preparableMatch = {
  grantId: "grant-prepare",
  status: "open",
  eligibility: "conditional",
  bucket: "preparable",
  recommendationTier: "needs_profile_input",
  ruleTrace: [
    {
      dimension: "industry",
      result: "unknown",
      action: { type: "progressive", target: "industry", label: "지금 확인" },
    },
    {
      dimension: "revenue",
      result: "unknown",
      action: { type: "progressive", target: "revenue", label: "지금 확인" },
    },
  ],
} as unknown as MatchCard;
const hardFailLegacyPreparableMatch = {
  ...preparableMatch,
  grantId: "grant-hard-fail-legacy-preparable",
  eligibility: "ineligible",
  recommendationTier: "not_recommended",
} as MatchCard;
const multiAnswerMatch = {
  ...answerMatch,
  grantId: "grant-multi-answer",
  scoreDisplay: "hidden",
  ruleTrace: [
    ...answerMatch.ruleTrace,
    {
      dimension: "revenue",
      result: "unknown",
      action: { type: "progressive", target: "revenue", label: "지금 확인" },
    },
  ],
} as MatchCard;
const unknownStatusMatch = {
  ...openMatch,
  grantId: "grant-status-unknown",
  status: "unknown",
} as MatchCard;

assert.equal(matchVerdictStatus(openMatch), "open");
assert.equal(matchVerdictStatus(answerMatch), "one_answer");
assert.equal(matchVerdictStatus(multiAnswerMatch), "closed");
assert.equal(matchVerdictStatus(reviewMatch), "check_source");
assert.equal(matchVerdictStatus(unknownStatusMatch), "check_source");
const grouped = groupMatchesForDisplay([
  openMatch,
  answerMatch,
  multiAnswerMatch,
  reviewMatch,
  preparableMatch,
  hardFailLegacyPreparableMatch,
  unknownStatusMatch,
]);
assert.equal(grouped.oneAnswer.length, 1);
assert.equal(grouped.preparable.length, 2);
assert.equal(grouped.checkSource.length, 2);
assert.equal(grouped.closed.length, 1, "hard fail은 legacy preparable bucket이어도 준비 목록에서 제외");

assert.equal(profileSheetValueState({
  value: "벤처기업확인서",
  available: true,
  status: "partial",
  sourceKind: "self_declared",
} as never), "direct", "partial self-declared 값은 미입력으로 숨기면 안 됨");
assert.equal(profileSheetValueState({
  value: "서울",
  available: true,
  status: "partial",
  sourceKind: "authoritative_api",
} as never), "automatic", "partial authoritative 값은 자동 확인 값으로 보여야 함");

function teaserFixture(matches: MatchCard[], knownCount: number): ProductTeaserResult {
  return {
    matches,
    profileView: {
      knownCount,
      partialCount: 0,
      unknownCount: 2 - knownCount,
      rows: [{}, {}],
    },
  } as ProductTeaserResult;
}

const beforeImpact = teaserFixture([answerMatch], 0);
const afterImpact = teaserFixture([{ ...answerMatch, eligibility: "eligible", recommendationTier: "recommendable" }], 1);
assert.equal(matchingPrecision(beforeImpact).pct, 0);
assert.deepEqual(summarizeAnswerImpact(beforeImpact, afterImpact), {
  newlyOpen: 1,
  newlyOpenGrantIds: ["grant-answer"],
  newlyClosed: 0,
  changed: 1,
  previousPrecision: 0,
  nextPrecision: 50,
  precisionDelta: 50,
});

assert.deepEqual(profileInputSuggestions("target_type"), ["개인사업자", "법인"]);
assert.match(profileFieldAsOfLabel("2026-07-14T12:00:00.000Z") ?? "", /2026/);

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

const answer = buildProfileAnswer("target_type", {
  value: "법인",
  secondaryValue: "",
  unit: "manwon",
});
assert.deepEqual(answer, { answer: { field: "target_type", value: ["법인"] } });

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

console.log("match-results/logic: ok");
