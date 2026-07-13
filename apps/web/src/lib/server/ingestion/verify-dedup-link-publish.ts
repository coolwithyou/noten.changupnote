import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Grant, NormalizedGrant } from "@cunote/contracts";
import {
  planDedupLinkPublication,
  planDedupLinksForPublication,
} from "./dedupLinkPublisher";

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
assert.equal(plan.links[0]?.canonicalGrantKey, "kstartup:178246");
assert.equal(plan.links[0]?.memberGrantKey, "bizinfo:PBLN_DEDUP_TECH_BRIDGE");
assert.equal(plan.links[0]?.score, 0.944);
assert.equal(plan.links[0]?.confirmed, false, "분류 없는 legacy 후보는 자동 확정하지 않는다");
assert.equal(plan.links[1]?.canonicalGrantKey, "bizinfo:PBLN_OTHER");
assert.equal(plan.links[1]?.memberGrantKey, "kstartup:178999");

const scopedPlan = planDedupLinksForPublication(
  [normalizedGrant("kstartup", "178246", "2026년 스타트업 테크 브릿지 참여기업 모집공고")],
  [
    normalizedGrant("bizinfo", "PBLN_DEDUP_TECH_BRIDGE", "스타트업 테크 브릿지 참여기업 모집공고"),
    normalizedGrant("bizinfo", "PBLN_UNRELATED", "소상공인 시설개선 융자지원"),
  ],
  { minScore: 0.82 },
);

assert.equal(scopedPlan.publishedEntryCount, 1);
assert.equal(scopedPlan.poolEntryCount, 2);
assert.equal(scopedPlan.scopedCandidateCount, 1);
assert.equal(scopedPlan.linkCount, 1);
assert.equal(scopedPlan.links[0]?.canonicalGrantKey, "bizinfo:PBLN_DEDUP_TECH_BRIDGE");
assert.equal(scopedPlan.links[0]?.memberGrantKey, "kstartup:178246");
assert.equal(scopedPlan.links[0]?.confirmed, true, "강한 동일 공고 근거는 자동 확정한다");

const cliSource = readFileSync("apps/web/src/lib/server/ingestion/publish-dedup.ts", "utf8");
assert.match(cliSource, /const dryRun = !write/);
assert.match(cliSource, /--confirm=PUBLISH_DEDUP_LINKS/);
assert.match(cliSource, /--write and --dry-run cannot be used together/);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "dedup_link_plan_pair_sort",
    "dedup_link_plan_duplicate_merge",
    "dedup_link_plan_self_skip",
    "dedup_link_publication_scopes_to_published_entries",
    "dedup_cli_default_dry_run",
    "dedup_cli_explicit_write_confirmation",
  ],
  plan,
  scopedPlan,
}, null, 2));

function normalizedGrant(
  source: Grant["source"],
  sourceId: string,
  title: string,
): NormalizedGrant<Record<string, unknown>> {
  return {
    raw: {
      source,
      source_id: sourceId,
      payload: { sourceId, title },
      status: "normalized",
    },
    grant: {
      source,
      source_id: sourceId,
      title,
      agency_jurisdiction: "창업진흥원",
      agency_operator: "창업진흥원",
      category_l1: "사업화",
      category_l2: "기술",
      apply_start: "2026-06-01",
      apply_end: "2026-07-31",
      support_amount: null,
      required_documents: null,
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.9,
    },
    criteria: [],
  };
}
