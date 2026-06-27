import assert from "node:assert/strict";
import { planDedupLinkPublication } from "./dedupLinkPublisher";

const plan = planDedupLinkPublication([
  {
    canonicalGrantKey: "kstartup:178246",
    memberGrantKey: "bizinfo:PBLN_DEDUP_TECH_BRIDGE",
    score: 0.944,
    reasons: ["title:0.92"],
  },
  {
    canonicalGrantKey: "bizinfo:PBLN_DEDUP_TECH_BRIDGE",
    memberGrantKey: "kstartup:178246",
    score: 0.91,
    reasons: ["title:0.9"],
  },
  {
    canonicalGrantKey: "kstartup:178246",
    memberGrantKey: "kstartup:178246",
    score: 1,
    reasons: ["self"],
  },
  {
    canonicalGrantKey: "bizinfo:PBLN_OTHER",
    memberGrantKey: "kstartup:178999",
    score: 0.83,
    reasons: ["title:0.83"],
  },
]);

assert.equal(plan.candidateCount, 4);
assert.equal(plan.linkCount, 2);
assert.equal(plan.skippedCount, 2);
assert.equal(plan.links[0]?.canonicalGrantKey, "bizinfo:PBLN_DEDUP_TECH_BRIDGE");
assert.equal(plan.links[0]?.memberGrantKey, "kstartup:178246");
assert.equal(plan.links[0]?.score, 0.944);
assert.equal(plan.links[1]?.canonicalGrantKey, "bizinfo:PBLN_OTHER");
assert.equal(plan.links[1]?.memberGrantKey, "kstartup:178999");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "dedup_link_plan_pair_sort",
    "dedup_link_plan_duplicate_merge",
    "dedup_link_plan_self_skip",
  ],
  plan,
}, null, 2));
