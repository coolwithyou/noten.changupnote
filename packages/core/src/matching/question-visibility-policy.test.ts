import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { matchGrantCriteria } from "./match.js";
import { planProfileQuestions } from "./question-planner.js";
import type { MatchedGrant } from "../use-cases/match-card.js";

const regionCriterion: GrantCriterion = {
  dimension: "region",
  operator: "in",
  kind: "required",
  confidence: 1,
  source_span: "서울 소재 기업",
  value: { regions: ["11"], labels: ["서울"] },
};

const authoritative = profile("authoritative_api", "complete");
assert.equal(evaluate(authoritative, regionCriterion).match.eligibility, "eligible");
assert.equal(plan(authoritative, regionCriterion), null, "complete 권위값은 질문을 숨겨야 한다");

const fuzzy = profile("public_registry", "partial");
assert.equal(evaluate(fuzzy, regionCriterion).match.eligibility, "conditional");
assert.equal(plan(fuzzy, regionCriterion)?.dimension, "region", "fuzzy/partial 후보값은 질문을 유지해야 한다");

const derived = profile("derived", "complete");
assert.equal(evaluate(derived, regionCriterion).match.eligibility, "conditional");
assert.equal(plan(derived, regionCriterion)?.dimension, "region", "derived scalar는 complete 표시만으로 질문을 숨기면 안 된다");

const partialCertification: CompanyProfile = {
  certs: ["벤처기업확인"],
  list_completeness: { certification: "partial" },
  profile_evidence: {
    certification: {
      sourceKind: "public_registry",
      provider: "registry_exact_subset",
      asOf: "2026-07-12T00:00:00.000Z",
      axisCompleteness: "partial",
      confidence: 0.9,
    },
  },
};
const missingCert: GrantCriterion = {
  dimension: "certification",
  operator: "in",
  kind: "required",
  confidence: 1,
  source_span: "이노비즈 인증 기업",
  value: { certs: ["이노비즈"] },
};
assert.equal(evaluate(partialCertification, missingCert).match.eligibility, "conditional");
assert.equal(plan(partialCertification, missingCert)?.dimension, "certification", "부분 명단의 no-hit는 질문을 숨기면 안 된다");

console.log("question-visibility-policy: ok");

function profile(
  sourceKind: "authoritative_api" | "public_registry" | "derived",
  axisCompleteness: "complete" | "partial",
): CompanyProfile {
  return {
    region: { code: "11", label: "서울" },
    profile_evidence: {
      region: {
        sourceKind,
        provider: sourceKind === "public_registry" ? "registry_fuzzy" : sourceKind,
        asOf: "2026-07-12T00:00:00.000Z",
        axisCompleteness,
        confidence: 0.9,
      },
    },
  };
}

function plan(company: CompanyProfile, criterion: GrantCriterion) {
  return planProfileQuestions([evaluate(company, criterion)], {
    asOf: new Date("2026-07-12T00:00:00.000Z"),
    limit: 1,
  })[0]?.question ?? null;
}

function evaluate(company: CompanyProfile, criterion: GrantCriterion): MatchedGrant<Record<string, never>> {
  const item = grant(criterion);
  return {
    item,
    match: matchGrantCriteria(item.criteria, company, { extractionManifest: item.extraction_manifest! }),
  };
}

function grant(criterion: GrantCriterion): NormalizedGrant<Record<string, never>> {
  return {
    grant: {
      source: "bizinfo",
      source_id: `visibility-${criterion.dimension}`,
      title: "질문 노출 정책 fixture",
      status: "open",
      apply_end: "2026-07-31",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria: [criterion],
    extraction_manifest: {
      grantId: `bizinfo:visibility-${criterion.dimension}`,
      revision: "r1",
      sourceFieldsSeen: ["criteria"],
      attachmentsExpected: 0,
      attachmentsFetched: 0,
      attachmentsConverted: 0,
      sectionsDetected: ["eligibility"],
      extractorVersion: "fixture",
      completedAt: "2026-07-12T00:00:00.000Z",
      warnings: [],
      readiness: "reviewed",
    },
    raw: {
      source: "bizinfo",
      source_id: `visibility-${criterion.dimension}`,
      payload: {},
      status: "published",
    },
  };
}
