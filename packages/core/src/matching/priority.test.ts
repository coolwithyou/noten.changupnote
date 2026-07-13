import assert from "node:assert/strict";
import type { Grant, MatchResult } from "@cunote/contracts";
import { calculatePriority } from "./priority.js";

const asOf = new Date("2026-07-12T00:00:00.000Z");
const match = result(0);
const urgent = calculatePriority(grant({
  apply_end: "2026-07-15",
  support_amount: { min: null, max: 100_000_000, unit: "KRW", per: "기업" },
  required_documents: [{ name: "사업계획서", required: true, source: "self" }],
}), match, { asOf });
const distant = calculatePriority(grant({ apply_end: "2026-10-12" }), result(1), { asOf });
assert.ok((urgent.score ?? 0) > (distant.score ?? 0));
assert.ok(urgent.reasons.some((reason) => reason.includes("D-3")));

const closed = calculatePriority(grant({ status: "closed", apply_end: "2026-07-01" }), match, { asOf });
assert.equal(closed.score, 0);

function result(unknownCount: number): MatchResult {
  return {
    eligibility: unknownCount > 0 ? "conditional" : "eligible",
    fit_score: unknownCount > 0 ? 0 : 100,
    rule_trace: [{
      dimension: "industry",
      kind: "required",
      operator: "in",
      result: unknownCount > 0 ? "unknown" : "pass",
      message: "업종 조건",
    }],
    unknown_fields: unknownCount > 0 ? ["industry"] : [],
    ruleset_ver: "test",
    scoring_ver: "test",
    criteria_extracted: true,
    quality: {
      eligibilityConfidence: unknownCount > 0 ? "low" : "high",
      verificationCompleteness: unknownCount > 0 ? 0 : 100,
      evidenceCoverage: 100,
      extractionReadiness: "reviewed",
    },
  };
}

function grant(overrides: Partial<Grant>): Grant {
  return {
    source: "bizinfo",
    source_id: "test",
    title: "테스트 공고",
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 1,
    ...overrides,
  };
}

console.log("priority.test.ts: all assertions passed");
