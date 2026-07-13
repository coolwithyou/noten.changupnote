import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import { backfillCachedPopbillTargetType, mergeCompanyProfilesForEnrichment } from "./serviceData";

const current: CompanyProfile = {
  id: "company-1",
  name: "기존 회사",
  region: { code: "11", label: "서울" },
  biz_age_months: 18,
  founder_age: 35,
  industries: ["기존 업종"],
  traits: ["여성기업"],
  confidence: {
    region: 0.4,
    biz_age: 0.5,
    founder_age: 0.8,
  },
};

const enriched: CompanyProfile = {
  id: "popbill:123-**-67***",
  name: "보강 회사",
  region: { code: "41", label: "경기" },
  biz_age_months: 42,
  industries: ["정보통신업", "소프트웨어 개발"],
  industry_codes: ["J62", "62", "J"],
  size: "중소기업",
  business_status: {
    active: true,
    label: "정상",
  },
  confidence: {
    region: 0.8,
    biz_age: 0.75,
    industry: 0.7,
    size: 0.65,
    business_status: 0.8,
  },
};

const merged = mergeCompanyProfilesForEnrichment(current, enriched);

assert.equal(merged.id, "company-1");
assert.equal(merged.name, "보강 회사");
assert.deepEqual(merged.region, { code: "41", label: "경기" });
assert.equal(merged.biz_age_months, 42);
assert.equal(merged.founder_age, 35);
assert.deepEqual(merged.industries, ["정보통신업", "소프트웨어 개발"]);
assert.deepEqual(merged.industry_codes, ["J62", "62", "J"]);
assert.deepEqual(merged.traits, ["여성기업"]);
assert.equal(merged.size, "중소기업");
assert.equal(merged.business_status?.active, true);
assert.equal(merged.confidence?.founder_age, 0.8);
assert.equal(merged.confidence?.region, 0.8);
assert.equal(merged.confidence?.industry, 0.7);

const protectedCurrent: CompanyProfile = {
  revenue_krw: 500_000_000,
  industries: ["사용자 확인 업종"],
  target_types: ["개인사업자"],
  confidence: { revenue: 0.95, industry: 0.6, target_type: 0.6 },
  list_completeness: { industry: "complete", target_type: "partial" },
  question_answer_state: {
    revenue: unknownAnswerState(),
    employees: unknownAnswerState(),
  },
  profile_evidence: {
    revenue: {
      sourceKind: "authoritative_api",
      provider: "fsc",
      asOf: "2026-07-11T00:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 0.95,
    },
    industry: {
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      asOf: "2026-07-10T00:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 0.6,
    },
    target_type: {
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      asOf: "2026-07-10T00:00:00.000Z",
      axisCompleteness: "partial",
      confidence: 0.6,
    },
  },
};
const connectorEnriched: CompanyProfile = {
  revenue_krw: 400_000_000,
  employees_count: 12,
  industries: ["정보통신업"],
  target_types: ["법인"],
  ip: ["patent"],
  financial_health: { debt_ratio_pct: 120, fiscal_year: "2025" },
  insured_workforce: { employment_insurance_active: true, insured_count: 12 },
  investment: { total_raised_krw: 100_000_000 },
  confidence: {
    revenue: 0.6,
    employees: 0.9,
    industry: 0.8,
    target_type: 1,
    ip: 0.9,
    financial_health: 0.9,
    insured_workforce: 0.9,
    investment: 0.8,
  },
  list_completeness: { industry: "partial", target_type: "complete", ip: "partial" },
  profile_evidence: {
    revenue: observation("derived", "estimate", "complete", 0.6),
    employees: observation("authoritative_api", "kcomwel", "complete", 0.9),
    industry: observation("authoritative_api", "popbill", "partial", 0.8),
    target_type: observation("authoritative_api", "nts", "complete", 1),
    ip: observation("authoritative_api", "kipris", "partial", 0.9),
    financial_health: observation("authoritative_api", "fsc", "complete", 0.9),
    insured_workforce: observation("authoritative_api", "kcomwel", "complete", 0.9),
    investment: observation("public_registry", "tips", "partial", 0.8),
  },
};
const connectorMerged = mergeCompanyProfilesForEnrichment(protectedCurrent, connectorEnriched);
assert.equal(connectorMerged.revenue_krw, 500_000_000, "낮은 우선순위 derived가 FSC 권위값을 덮으면 안 됨");
assert.equal(connectorMerged.confidence?.revenue, 0.95);
assert.equal(connectorMerged.employees_count, 12);
assert.deepEqual(connectorMerged.industries, ["사용자 확인 업종"], "partial 권위 관측은 complete 사용자 확인 목록을 교체하지 않음");
assert.deepEqual(connectorMerged.target_types, ["법인"], "complete 권위 target_type은 partial 자가값을 교체");
assert.deepEqual(connectorMerged.ip, ["patent"]);
assert.equal(connectorMerged.financial_health?.debt_ratio_pct, 120);
assert.equal(connectorMerged.insured_workforce?.insured_count, 12);
assert.equal(connectorMerged.investment?.total_raised_krw, 100_000_000);
assert.equal(connectorMerged.profile_evidence?.revenue?.provider, "fsc");
assert.equal(connectorMerged.profile_evidence?.revenue?.supplemental?.[0]?.provider, "estimate");
assert.equal(connectorMerged.profile_evidence?.industry?.provider, "cunote_profile_question");
assert.equal(connectorMerged.profile_evidence?.industry?.supplemental?.[0]?.provider, "popbill");
assert.equal(connectorMerged.list_completeness?.industry, "complete");
assert.ok(connectorMerged.question_answer_state?.revenue, "적용되지 않은 낮은 우선순위 값은 unknown 상태를 지우면 안 됨");
assert.equal(connectorMerged.question_answer_state?.employees, undefined, "권위 직원값이 적용되면 unknown 상태를 해제해야 함");

const providerPriorityMerged = mergeCompanyProfilesForEnrichment({
  revenue_krw: 900_000_000,
  confidence: { revenue: 0.95 },
  profile_evidence: {
    revenue: observation("authoritative_api", "codef", "complete", 0.95, "2026-01-01T00:00:00.000Z"),
  },
  question_answer_state: { revenue: unknownAnswerState() },
}, {
  revenue_krw: 100_000_000,
  confidence: { revenue: 0.8 },
  profile_evidence: {
    revenue: observation("authoritative_api", "nice", "complete", 0.8, "2026-07-12T00:00:00.000Z"),
  },
});
assert.equal(providerPriorityMerged.revenue_krw, 900_000_000, "newer NICE must not overwrite CODEF revenue");
assert.equal(providerPriorityMerged.confidence?.revenue, 0.95);
assert.equal(providerPriorityMerged.profile_evidence?.revenue?.provider, "codef");
assert.equal(providerPriorityMerged.profile_evidence?.revenue?.supplemental?.[0]?.provider, "nice");
assert.ok(providerPriorityMerged.question_answer_state?.revenue, "losing evidence must not clear question state");

const fresherNtsMerged = mergeCompanyProfilesForEnrichment({
  business_status: { active: true, label: "정상" },
  profile_evidence: {
    business_status: observation("authoritative_api", "nts", "complete", 0.9, "2026-07-11T00:00:00.000Z"),
  },
}, {
  business_status: { active: false, label: "폐업" },
  profile_evidence: {
    business_status: observation("authoritative_api", "nts", "complete", 0.9, "2026-07-12T00:00:00.000Z"),
  },
});
assert.equal(fresherNtsMerged.business_status?.active, false, "same-provider fresher NTS replaces");
assert.equal(fresherNtsMerged.profile_evidence?.business_status?.supplemental?.[0]?.asOf, "2026-07-11T00:00:00.000Z");

const legacyCachedProfile = backfillCachedPopbillTargetType(
  { name: "구 캐시 법인", confidence: {} },
  { personCorpCode: 1 },
  new Date("2026-07-12T00:00:00.000Z"),
);
assert.deepEqual(legacyCachedProfile.target_types, ["법인"]);
assert.equal(legacyCachedProfile.list_completeness?.target_type, "partial");
assert.equal(legacyCachedProfile.profile_evidence?.target_type?.provider, "popbill");
const existingCachedType = backfillCachedPopbillTargetType(
  { target_types: ["개인사업자"], list_completeness: { target_type: "partial" } },
  { personCorpCode: 1 },
  new Date("2026-07-12T00:00:00.000Z"),
);
assert.deepEqual(existingCachedType.target_types, ["개인사업자"], "구 캐시 보정은 기존 canonical 유형을 덮으면 안 됨");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "enrichment_preserves_company_id",
    "enrichment_overwrites_verified_fields",
    "enrichment_preserves_manual_fields",
    "enrichment_merges_confidence",
    "enrichment_preserves_profile_evidence",
    "enrichment_applies_source_priority",
    "enrichment_covers_expanded_profile_dimensions",
    "enrichment_clears_unknown_only_when_evidence_applies",
    "enrichment_backfills_legacy_popbill_target_type",
  ],
  region: merged.region,
  bizAgeMonths: merged.biz_age_months,
  industriesCount: merged.industries?.length ?? 0,
}, null, 2));

function observation(
  sourceKind: "authoritative_api" | "public_registry" | "derived",
  provider: string,
  axisCompleteness: "partial" | "complete",
  confidence: number,
  asOf = "2026-07-12T00:00:00.000Z",
) {
  return {
    sourceKind,
    provider,
    asOf,
    axisCompleteness,
    confidence,
  };
}

function unknownAnswerState() {
  return {
    status: "unknown" as const,
    answeredAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    sourceKind: "self_declared" as const,
    rulesetVer: "ruleset-test",
  };
}
