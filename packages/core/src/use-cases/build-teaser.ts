import type { CompanyEvidence, CompanyProfile, NormalizedGrant, TeaserResult } from "@cunote/contracts";
import { matchGrantCriteria } from "../matching/match.js";
import {
  companyAttributes,
  countByEligibility,
  daysUntil,
  sortMatchedGrants,
  supportAmountMax,
  toMatchCard,
  type MatchedGrant,
} from "./match-card.js";

export interface BuildTeaserOptions<TPayload = unknown> {
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  limit?: number;
  companyEvidence?: CompanyEvidence | null;
}

export function buildTeaser<TPayload>({
  company,
  grants,
  asOf = new Date(),
  limit = 8,
  companyEvidence,
}: BuildTeaserOptions<TPayload>): TeaserResult {
  const matched = grants.map<MatchedGrant<TPayload>>((item) => ({
    item,
    match: matchGrantCriteria(item.criteria, company),
  }));
  const sorted = sortMatchedGrants(matched);
  const counts = countByEligibility(matched.map((entry) => entry.match));
  const deadlineSoon = matched.filter((entry) => {
    const dDay = daysUntil(entry.item.grant.apply_end ?? null, asOf);
    return entry.match.eligibility !== "ineligible" && dDay !== null && dDay >= 0 && dDay <= 7;
  }).length;

  const result: TeaserResult = {
    attributes: companyAttributes(company),
    estimatedMaxAmount: sumAmount(matched, "eligible"),
    conditionalUpside: sumAmount(matched, "conditional"),
    counts: {
      ...counts,
      deadlineSoon,
    },
    matches: sorted.slice(0, limit).map((entry) => toMatchCard(entry, { asOf })),
    privacyNote: "사업자번호 원문, 대표자명, 상세주소는 저장하거나 표시하지 않습니다.",
  };
  if (companyEvidence !== undefined) result.companyEvidence = companyEvidence;
  return result;
}

function sumAmount<TPayload>(
  matched: Array<MatchedGrant<TPayload>>,
  eligibility: "eligible" | "conditional",
): number {
  return matched
    .filter((entry) => entry.match.eligibility === eligibility)
    .reduce((sum, entry) => sum + supportAmountMax(entry.item.grant.support_amount), 0);
}
