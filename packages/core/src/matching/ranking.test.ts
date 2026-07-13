import assert from "node:assert/strict";
import type { CompanyProfile, Grant, NormalizedGrant } from "@cunote/contracts";
import { matchNormalizedGrant } from "./match.js";
import { withMatchRanking } from "./ranking.js";
import { sortMatchedGrants, toMatchCard, type MatchedGrant } from "../use-cases/match-card.js";

const company: CompanyProfile = { industries: ["소프트웨어 개발"], industry_codes: ["J62"] };
const asOf = new Date("2026-07-12T00:00:00.000Z");
const relevant = normalized("relevant", "AI 소프트웨어 사업화", ["J62"]);
const unrelated = normalized("unrelated", "농식품 시설 개선", ["C10"]);

const entries: MatchedGrant[] = [unrelated, relevant].map((item) => {
  const eligibilityMatch = matchNormalizedGrant(item, company);
  const ranked = withMatchRanking(item, company, eligibilityMatch, { asOf });
  assert.equal(ranked.eligibility, eligibilityMatch.eligibility, "ranking must not change eligibility");
  return { item, match: ranked };
});
const sorted = sortMatchedGrants(entries);
assert.equal(sorted[0]?.item.grant.source_id, "relevant");
assert.equal(toMatchCard(sorted[0]!, { asOf }).ranking?.relevanceScore, 70);

const ineligibleHighRanking: MatchedGrant = {
  item: relevant,
  match: { ...entries[1]!.match, eligibility: "ineligible", review_gate: { tier: "not_recommended", scoreDisplay: "hidden", reasons: [] } },
};
const eligibleLowRanking: MatchedGrant = {
  item: unrelated,
  match: { ...entries[0]!.match, eligibility: "eligible", review_gate: { tier: "recommendable", scoreDisplay: "numeric", reasons: [] } },
};
assert.equal(sortMatchedGrants([ineligibleHighRanking, eligibleLowRanking])[0], eligibleLowRanking);

function normalized(sourceId: string, title: string, industries: string[]): NormalizedGrant {
  const grant: Grant = {
    source: "kstartup",
    source_id: sourceId,
    title,
    apply_end: "2026-07-31",
    status: "open",
    f_regions: [],
    f_industries: industries,
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 1,
  };
  return {
    raw: { source: grant.source, source_id: sourceId, payload: {}, status: "normalized" },
    grant,
    criteria: [],
  };
}

console.log("ranking.test.ts: all assertions passed");
