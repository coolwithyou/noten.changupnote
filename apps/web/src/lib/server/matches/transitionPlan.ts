import type { CompanyProfile } from "@cunote/contracts";
import {
  planMatchTransitions,
  type MatchTransitionPlan,
} from "@cunote/core";
import { createServiceRepositories } from "@/lib/server/repositories/factory";

export interface LoadDueMatchTransitionPlanOptions {
  asOf?: Date;
  limit?: number;
  userId?: string;
}

export async function loadDueMatchTransitionPlan(
  options: LoadDueMatchTransitionPlanOptions = {},
): Promise<MatchTransitionPlan> {
  const asOf = options.asOf ?? new Date();
  const repositories = createServiceRepositories({
    loadGrants: async () => [],
    loadCompanyProfile: async () => EMPTY_PROFILE,
  });
  const query = {
    asOf,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.userId ? { userId: options.userId } : {}),
  };
  const candidates = await repositories.matches.listDueMatchTransitions(query);
  return planMatchTransitions(candidates, { asOf });
}

const EMPTY_PROFILE: CompanyProfile = {};
