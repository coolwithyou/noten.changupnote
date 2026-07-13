import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CompanyProfile, Eligibility, GrantCriterion, CriterionResult } from "@cunote/contracts";
import { matchGrantCriteria, validateGrantCriteriaContract } from "../src/index.js";

const path = resolve("packages/core/golden/matching/prior-award-scenarios-v1.json");
const fixture = JSON.parse(readFileSync(path, "utf8")) as {
  goldenVer: string;
  asOf: string;
  cases: Array<{
    caseId: string;
    tags: string[];
    criterion: Omit<GrantCriterion, "id" | "grant_id" | "parser_version">;
    profile: CompanyProfile;
    expectedTrace: CriterionResult;
    expectedEligibility: Eligibility;
  }>;
};

assert.equal(fixture.goldenVer, "prior-award-scenarios-v1");
const asOf = new Date(fixture.asOf);
assert.equal(Number.isNaN(asOf.getTime()), false, "asOf must be a valid date");
assert.ok(fixture.cases.length > 0, "golden cases required");
const caseIds = new Set<string>();
const coveredTags = new Set<string>();
const resultCounts: Record<string, number> = {};
for (const item of fixture.cases) {
  assert.ok(!caseIds.has(item.caseId), `duplicate caseId: ${item.caseId}`);
  caseIds.add(item.caseId);
  item.tags.forEach((tag) => coveredTags.add(tag));
  const criterion: GrantCriterion = {
    ...item.criterion,
    id: `golden:${item.caseId}`,
    grant_id: item.caseId,
    parser_version: fixture.goldenVer,
  };
  assert.deepEqual(validateGrantCriteriaContract([criterion]), [], `${item.caseId} contract violation`);
  const result = matchGrantCriteria([criterion], item.profile, { asOf });
  assert.equal(result.rule_trace[0]?.result, item.expectedTrace, `${item.caseId} trace mismatch`);
  assert.equal(result.eligibility, item.expectedEligibility, `${item.caseId} eligibility mismatch`);
  resultCounts[item.expectedTrace] = (resultCounts[item.expectedTrace] ?? 0) + 1;
}
for (const tag of ["self", "program", "program_type", "unqueried", "year_unknown", "period_outside", "period_inside"]) {
  assert.ok(coveredTags.has(tag), `golden coverage missing tag: ${tag}`);
}
for (const result of ["pass", "fail", "unknown"]) assert.ok((resultCounts[result] ?? 0) > 0, `missing result class: ${result}`);

console.log(JSON.stringify({
  ok: true,
  goldenVer: fixture.goldenVer,
  caseCount: fixture.cases.length,
  coveredTags: [...coveredTags].sort(),
  resultCounts,
}, null, 2));
