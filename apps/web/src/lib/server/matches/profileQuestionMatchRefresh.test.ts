import assert from "node:assert/strict";
import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import { evaluateProfileUpdateImpact, type ServiceRepositories } from "@cunote/core";
import { refreshProfileQuestionMatchStates } from "./profileQuestionMatchRefresh";

const before: CompanyProfile = { employees_count: 3 };
const after: CompanyProfile = { ...before, revenue_krw: 80_000_000 };
const grants = [revenueGrant(), employeeGrant()];
const impact = evaluateProfileUpdateImpact({ grants, beforeProfile: before, afterProfile: after, dimension: "revenue" });
const savedGrantIds: string[] = [];
const repositories = repositoriesWithSave(async (grantId) => {
  savedGrantIds.push(grantId);
});

const refresh = await refreshProfileQuestionMatchStates({
  repositories,
  companyId: "company-1",
  stateScope: "company",
  company: after,
  grants,
  impact,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.deepEqual(refresh, {
  scope: "company_dimension",
  status: "succeeded",
  plannedCount: 1,
  savedCount: 1,
  failedCount: 0,
  failedGrantIds: [],
});
assert.deepEqual(savedGrantIds, ["bizinfo:revenue-grant"]);

const userScopedRefresh = await refreshProfileQuestionMatchStates({
  repositories,
  companyId: "company-1",
  stateScope: "user",
  company: after,
  grants,
  impact,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.deepEqual(userScopedRefresh, {
  scope: "user_dimension",
  status: "skipped_user_scope",
  plannedCount: 1,
  savedCount: 0,
  failedCount: 0,
  failedGrantIds: [],
});
assert.deepEqual(savedGrantIds, ["bizinfo:revenue-grant"], "user overlay must not write shared match_state");

const noChangeImpact = evaluateProfileUpdateImpact({
  grants,
  beforeProfile: after,
  afterProfile: after,
  dimension: "revenue",
});
const noChangeRefresh = await refreshProfileQuestionMatchStates({
  repositories,
  companyId: "company-1",
  stateScope: "company",
  company: after,
  grants,
  impact: noChangeImpact,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.deepEqual(noChangeRefresh, {
  scope: "company_dimension",
  status: "no_op",
  plannedCount: 0,
  savedCount: 0,
  failedCount: 0,
  failedGrantIds: [],
});
assert.deepEqual(savedGrantIds, ["bizinfo:revenue-grant"], "unchanged answers must not write match state");

const bothBefore: CompanyProfile = {};
const bothAfter: CompanyProfile = { revenue_krw: 80_000_000 };
const twoRevenueGrants = [revenueGrant(), secondRevenueGrant()];
const twoGrantImpact = evaluateProfileUpdateImpact({
  grants: twoRevenueGrants,
  beforeProfile: bothBefore,
  afterProfile: bothAfter,
  dimension: "revenue",
});
const attemptedGrantIds: string[] = [];
const partialRefresh = await refreshProfileQuestionMatchStates({
  repositories: repositoriesWithSave(async (grantId) => {
    attemptedGrantIds.push(grantId);
    if (grantId === "bizinfo:second-revenue-grant") throw new Error("fixture write failure");
  }),
  companyId: "company-1",
  stateScope: "company",
  company: bothAfter,
  grants: twoRevenueGrants,
  impact: twoGrantImpact,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.deepEqual(attemptedGrantIds, ["bizinfo:revenue-grant", "bizinfo:second-revenue-grant"]);
assert.deepEqual(partialRefresh, {
  scope: "company_dimension",
  status: "partial",
  plannedCount: 2,
  savedCount: 1,
  failedCount: 1,
  failedGrantIds: ["bizinfo:second-revenue-grant"],
});

console.log("profile-question-match-refresh: ok");

function revenueGrant(): NormalizedGrant<{ fixture: true }> {
  return grant("revenue-grant", {
    dimension: "revenue",
    kind: "required",
    operator: "lte",
    value: { max_krw: 100_000_000 },
    confidence: 1,
    source_span: "매출 1억원 이하",
  });
}

function employeeGrant(): NormalizedGrant<{ fixture: true }> {
  return grant("employee-grant", {
    dimension: "employees",
    kind: "required",
    operator: "lte",
    value: { max: 5 },
    confidence: 1,
    source_span: "상시근로자 5명 이하",
  });
}

function secondRevenueGrant(): NormalizedGrant<{ fixture: true }> {
  return grant("second-revenue-grant", {
    dimension: "revenue",
    kind: "required",
    operator: "gte",
    value: { min_krw: 50_000_000 },
    confidence: 1,
    source_span: "매출 5천만원 이상",
  });
}

function repositoriesWithSave(
  save: (grantId: string) => Promise<void>,
): ServiceRepositories<{ fixture: true }> {
  return {
    matches: {
      async saveMatchState(input: { grantId: string }) {
        await save(input.grantId);
      },
    },
  } as unknown as ServiceRepositories<{ fixture: true }>;
}

function grant(
  sourceId: string,
  criterion: NormalizedGrant["criteria"][number],
): NormalizedGrant<{ fixture: true }> {
  return {
    raw: { source: "bizinfo", source_id: sourceId, payload: { fixture: true }, status: "normalized" },
    grant: {
      source: "bizinfo",
      source_id: sourceId,
      title: sourceId,
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria: [criterion],
  };
}
