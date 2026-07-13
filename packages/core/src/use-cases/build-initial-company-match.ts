import type {
  CompanyInitialMatchResult,
  CompanyProfile,
  NormalizedGrant,
} from "@cunote/contracts";
import { buildDashboard } from "./build-dashboard.js";

export interface BuildInitialCompanyMatchOptions<TPayload = unknown> {
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  limit?: number;
}

/**
 * 사업자정보 자동채움 직후 반환할 첫 결과를 만든다.
 * counts와 nextQuestion은 전달된 전체 공고를 기준으로 계산하고 matches만 limit한다.
 */
export function buildInitialCompanyMatch<TPayload>({
  company,
  grants,
  asOf = new Date(),
  limit = 12,
}: BuildInitialCompanyMatchOptions<TPayload>): CompanyInitialMatchResult {
  const dashboard = buildDashboard({ company, grants, asOf, limit });
  return {
    asOf: asOf.toISOString(),
    evaluatedGrantCount: grants.length,
    counts: dashboard.counts,
    matches: dashboard.matches,
    nextQuestion: dashboard.nextQuestion ?? null,
    rulesetVer: dashboard.rulesetVer,
    scoringVer: dashboard.scoringVer,
  };
}
