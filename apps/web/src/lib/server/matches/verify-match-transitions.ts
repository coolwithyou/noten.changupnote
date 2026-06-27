import assert from "node:assert/strict";
import { planMatchTransitions } from "@cunote/core";
import { createRuntimeRepositories } from "@/lib/server/repositories/runtime";

const asOf = new Date("2026-08-01T09:00:00.000Z");
const plan = planMatchTransitions([
  {
    companyId: "00000000-0000-4000-8000-000000000101",
    grantId: "00000000-0000-4000-8000-000000000201",
    eligibility: "ineligible",
    eligibleFrom: "2026-08-01T00:00:00.000Z",
    eligibleUntil: null,
  },
  {
    companyId: "00000000-0000-4000-8000-000000000101",
    grantId: "00000000-0000-4000-8000-000000000202",
    eligibility: "ineligible",
    eligibleFrom: "2026-08-02T00:00:00.000Z",
    eligibleUntil: null,
  },
  {
    companyId: "00000000-0000-4000-8000-000000000102",
    grantId: "00000000-0000-4000-8000-000000000203",
    eligibility: "eligible",
    eligibleFrom: null,
    eligibleUntil: "2026-08-01T00:00:00.000Z",
  },
  {
    companyId: "00000000-0000-4000-8000-000000000103",
    grantId: "00000000-0000-4000-8000-000000000204",
    eligibility: "conditional",
    eligibleFrom: null,
    eligibleUntil: "2026-07-31T00:00:00.000Z",
  },
  {
    companyId: "00000000-0000-4000-8000-000000000104",
    grantId: "00000000-0000-4000-8000-000000000205",
    eligibility: "ineligible",
    eligibleFrom: null,
    eligibleUntil: "2026-07-31T00:00:00.000Z",
  },
], { asOf });

assert.equal(plan.asOf, asOf.toISOString());
assert.equal(plan.counts.becomes_eligible, 1);
assert.equal(plan.counts.becomes_ineligible, 2);
assert.equal(plan.transitions.length, 3);
assert.equal(
  plan.transitions.some((item) =>
    item.kind === "becomes_eligible" &&
    item.reason === "eligible_from_due" &&
    item.grantId === "00000000-0000-4000-8000-000000000201"
  ),
  true,
);
assert.equal(
  plan.transitions.some((item) =>
    item.kind === "becomes_ineligible" &&
    item.reason === "eligible_until_due" &&
    item.grantId === "00000000-0000-4000-8000-000000000204"
  ),
  true,
);
assert.equal(
  plan.transitions.some((item) => item.grantId === "00000000-0000-4000-8000-000000000202"),
  false,
);
assert.equal(
  plan.transitions.some((item) => item.grantId === "00000000-0000-4000-8000-000000000205"),
  false,
);

const runtimeRepositories = createRuntimeRepositories({
  loadGrants: async () => [],
  loadCompanyProfile: async () => ({}),
});
const runtimeCandidates = await runtimeRepositories.matches.listDueMatchTransitions({ asOf });
assert.deepEqual(runtimeCandidates, []);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "transition_plan_eligible_from_due",
    "transition_plan_eligible_until_due",
    "transition_plan_future_ignored",
    "transition_plan_ineligible_until_ignored",
    "runtime_transition_candidates_empty",
  ],
  counts: plan.counts,
  transitions: plan.transitions.map((item) => ({
    grantId: item.grantId,
    kind: item.kind,
    dueAt: item.dueAt,
  })),
}, null, 2));
