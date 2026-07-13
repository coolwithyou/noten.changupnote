import type {
  CompanyProfile,
  GrantSource,
  MatchResult,
  NormalizedGrant,
} from "@cunote/contracts";
import { matchNormalizedGrant } from "../matching/match.js";
import { calculateMatchTransitionWindow, countByEligibility, grantKey } from "./match-card.js";

export interface PlanMatchStateRefreshOptions<TPayload = unknown> {
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  companyId?: string;
}

export interface MatchStateRefreshItem {
  companyId?: string;
  grantId: string;
  source: GrantSource;
  sourceId: string;
  title: string;
  eligibility: MatchResult["eligibility"];
  fitScore: number;
  eligibleFrom: string | null;
  eligibleUntil: string | null;
  rulesetVer: string;
  scoringVer: string;
  match: MatchResult;
}

export interface MatchStateRefreshPlan {
  asOf: string;
  companyId?: string;
  grantCount: number;
  counts: {
    eligible: number;
    conditional: number;
    ineligible: number;
  };
  transitionWindowCounts: {
    eligibleFrom: number;
    eligibleUntil: number;
  };
  states: MatchStateRefreshItem[];
}

export function planMatchStateRefresh<TPayload>({
  company,
  grants,
  asOf = new Date(),
  companyId,
}: PlanMatchStateRefreshOptions<TPayload>): MatchStateRefreshPlan {
  const states = grants.map<MatchStateRefreshItem>((item) => {
    const match = matchNormalizedGrant(item, company);
    const transitionWindow = calculateMatchTransitionWindow(match, { asOf });
    return {
      ...(companyId ? { companyId } : {}),
      grantId: grantKey(item.grant),
      source: item.grant.source,
      sourceId: item.grant.source_id,
      title: item.grant.title,
      eligibility: match.eligibility,
      fitScore: match.fit_score,
      eligibleFrom: transitionWindow.eligibleFrom?.toISOString() ?? null,
      eligibleUntil: transitionWindow.eligibleUntil?.toISOString() ?? null,
      rulesetVer: match.ruleset_ver,
      scoringVer: match.scoring_ver,
      match,
    };
  });

  return {
    ...(companyId ? { companyId } : {}),
    asOf: asOf.toISOString(),
    grantCount: grants.length,
    counts: countByEligibility(states.map((state) => state.match)),
    transitionWindowCounts: {
      eligibleFrom: states.filter((state) => state.eligibleFrom !== null).length,
      eligibleUntil: states.filter((state) => state.eligibleUntil !== null).length,
    },
    states,
  };
}
