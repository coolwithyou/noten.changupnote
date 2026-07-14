import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import {
  legacyMergeCompanyProfilesForEnrichment,
  mergeCompanyProfilesForEnrichmentAt,
} from "./serviceData.js";

const asOf = "2026-07-14T00:00:00.000Z";
const fixtures: Array<{ name: string; current: CompanyProfile; enriched: CompanyProfile }> = [
  {
    name: "scalar provider precedence",
    current: {
      region: { code: "11", label: "서울" },
      confidence: { region: 0.6 },
      profile_evidence: {
        region: observation("self_declared", "cunote_profile_question", "complete", 0.6),
      },
    },
    enriched: {
      region: { code: "41", label: "경기" },
      confidence: { region: 0.9 },
      profile_evidence: {
        region: observation("authoritative_api", "codef", "complete", 0.9),
      },
    },
  },
  {
    name: "complete list retains partial candidate",
    current: {
      certs: ["사용자 확인 인증"],
      list_completeness: { certification: "complete" },
      confidence: { certification: 0.7 },
      profile_evidence: {
        certification: observation("self_declared", "cunote_profile_question", "complete", 0.7),
      },
    },
    enriched: {
      certs: ["창업기업확인서"],
      list_completeness: { certification: "partial" },
      confidence: { certification: 0.95 },
      profile_evidence: {
        certification: observation("authoritative_api", "startup_confirmation", "partial", 0.95),
      },
    },
  },
  {
    name: "compound shallow overlay and question clear",
    current: {
      financial_health: { equity_krw: 1_000_000_000, fiscal_year: "2024" },
      confidence: { financial_health: 0.7 },
      profile_evidence: {
        financial_health: observation("authoritative_api", "fsc", "partial", 0.7),
      },
      question_answer_state: {
        financial_health: {
          status: "unknown",
          answeredAt: asOf,
          expiresAt: "2026-08-14T00:00:00.000Z",
          sourceKind: "self_declared",
          rulesetVer: "matching-v5",
        },
      },
    },
    enriched: {
      financial_health: { capital_krw: 2_000_000_000, fiscal_year: "2025" },
      confidence: { financial_health: 0.85 },
      profile_evidence: {
        financial_health: observation("authoritative_api", "dart", "partial", 0.85),
      },
    },
  },
  {
    name: "non-evidence identity and diagnostics remain legacy-compatible",
    current: { name: "기존 회사", other_conditions: { old: true }, confidence: {} },
    enriched: { name: "새 회사", is_preliminary: false, other_conditions: { new: true }, confidence: {} },
  },
];

for (const fixture of fixtures) {
  assert.deepEqual(
    mergeCompanyProfilesForEnrichmentAt(fixture.current, fixture.enriched, asOf),
    legacyMergeCompanyProfilesForEnrichment(fixture.current, fixture.enriched),
    fixture.name,
  );
}

const conflictCurrent: CompanyProfile = {
  employees_count: 10,
  confidence: { employees: 0.8 },
  profile_evidence: {
    employees: observation("authoritative_api", "unknown-a", "complete", 0.8),
  },
};
const conflictIncoming: CompanyProfile = {
  employees_count: 20,
  confidence: { employees: 0.8 },
  profile_evidence: {
    employees: observation("authoritative_api", "unknown-b", "complete", 0.8),
  },
};
assert.equal(
  legacyMergeCompanyProfilesForEnrichment(conflictCurrent, conflictIncoming).employees_count,
  10,
  "P0 input-first behavior receipt",
);
const corrected = mergeCompanyProfilesForEnrichmentAt(conflictCurrent, conflictIncoming, asOf);
assert.equal(corrected.employees_count, undefined);
assert.equal(corrected.profile_evidence?.employees?.provider, "cunote_profile_conflict");
assert.equal(corrected.profile_evidence?.employees?.supplemental?.length, 2);

console.log("serviceData-profile-merge-parity.test.ts: all assertions passed");

function observation(
  sourceKind: "authoritative_api" | "self_declared",
  provider: string,
  axisCompleteness: "partial" | "complete",
  confidence: number,
) {
  return { sourceKind, provider, asOf, axisCompleteness, confidence };
}
