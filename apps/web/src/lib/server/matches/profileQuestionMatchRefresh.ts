import type { CompanyProfile, NormalizedGrant, ProfileQuestionRefreshDto } from "@cunote/contracts";
import {
  selectProfileUpdateRefreshGrants,
  type ProfileUpdateImpact,
  type ServiceRepositories,
} from "@cunote/core";
import { refreshMatchStates } from "./matchStateRefresh";

export async function refreshProfileQuestionMatchStates<TPayload>(input: {
  repositories: ServiceRepositories<TPayload>;
  companyId: string;
  userId?: string;
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  impact: ProfileUpdateImpact;
  asOf: Date;
}): Promise<ProfileQuestionRefreshDto> {
  const scopedGrants = selectProfileUpdateRefreshGrants(input.grants, input.impact);
  if (scopedGrants.length === 0) {
    return { scope: "company_dimension", plannedCount: 0, savedCount: 0 };
  }
  const { savedCount } = await refreshMatchStates({
    repositories: input.repositories,
    companyId: input.companyId,
    ...(input.userId ? { userId: input.userId } : {}),
    company: input.company,
    grants: scopedGrants,
    asOf: input.asOf,
    write: true,
  });
  return {
    scope: "company_dimension",
    plannedCount: scopedGrants.length,
    savedCount,
  };
}
