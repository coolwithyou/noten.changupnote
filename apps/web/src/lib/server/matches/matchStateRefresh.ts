import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import {
  planMatchStateRefresh,
  type MatchStateRefreshPlan,
  type ServiceRepositories,
} from "@cunote/core";

export interface RefreshMatchStatesInput<TPayload = unknown> {
  repositories: ServiceRepositories<TPayload>;
  companyId: string;
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  write: boolean;
}

export interface RefreshMatchStatesResult {
  plan: MatchStateRefreshPlan;
  savedCount: number;
}

export async function refreshMatchStates<TPayload>({
  repositories,
  companyId,
  company,
  grants,
  asOf,
  write,
}: RefreshMatchStatesInput<TPayload>): Promise<RefreshMatchStatesResult> {
  const plan = planMatchStateRefresh({
    company,
    grants,
    asOf,
    companyId,
  });

  if (!write) {
    return { plan, savedCount: 0 };
  }

  await Promise.all(plan.states.map((state) => repositories.matches.saveMatchState({
    companyId,
    grantId: state.grantId,
    match: state.match,
    eligibleFrom: parsePlanDate(state.eligibleFrom),
    eligibleUntil: parsePlanDate(state.eligibleUntil),
  })));

  return { plan, savedCount: plan.states.length };
}

function parsePlanDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
