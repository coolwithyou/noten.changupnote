import type { CompanyProfile, CriterionConfirmation, NormalizedGrant, ProfileQuestionRefreshDto } from "@cunote/contracts";
import {
  planMatchStateRefresh,
  selectProfileUpdateRefreshGrants,
  type ProfileUpdateImpact,
  type MatchStateInputBinding,
  type ServiceRepositories,
} from "@cunote/core";

export async function refreshProfileQuestionMatchStates<TPayload>(input: {
  repositories: ServiceRepositories<TPayload>;
  companyId: string;
  stateScope: "company" | "request" | "user";
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  impact: ProfileUpdateImpact;
  asOf: Date;
  confirmationsByGrantId?: ReadonlyMap<string, CriterionConfirmation[]>;
  inputBindings?: MatchStateInputBinding[];
}): Promise<ProfileQuestionRefreshDto> {
  const scopedGrants = selectProfileUpdateRefreshGrants(input.grants, input.impact);
  if (scopedGrants.length === 0) {
    return {
      scope: input.stateScope === "company" ? "company_dimension" : "user_dimension",
      status: "no_op",
      plannedCount: 0,
      savedCount: 0,
      failedCount: 0,
      failedGrantIds: [],
    };
  }
  if (input.stateScope !== "company") {
    return {
      scope: "user_dimension",
      status: "skipped_user_scope",
      plannedCount: scopedGrants.length,
      savedCount: 0,
      failedCount: 0,
      failedGrantIds: [],
    };
  }

  try {
    const plan = planMatchStateRefresh({
      company: input.company,
      grants: scopedGrants,
      asOf: input.asOf,
      companyId: input.companyId,
      ...(input.confirmationsByGrantId ? { confirmationsByGrantId: input.confirmationsByGrantId } : {}),
    });
    const bindingByGrantId = new Map((input.inputBindings ?? [])
      .filter((binding) => binding.companyId === input.companyId)
      .map((binding) => [binding.grantId, binding]));
    if (plan.states.some((state) => !bindingByGrantId.has(state.grantId))) {
      throw new Error("company match_state refresh requires pre-read input bindings");
    }
    const results = await Promise.allSettled(plan.states.map((state) => input.repositories.matches.saveMatchState({
      companyId: input.companyId,
      grantId: state.grantId,
      match: state.match,
      inputBinding: bindingByGrantId.get(state.grantId)!,
      calculationAsOf: input.asOf,
      eligibleFrom: parsePlanDate(state.eligibleFrom),
      eligibleUntil: parsePlanDate(state.eligibleUntil),
    })));
    const staleGrantIds = results.flatMap((result, index) =>
      result.status === "fulfilled" && result.value.status !== "saved" ? [plan.states[index]!.grantId] : []);
    const failedGrantIds = results.flatMap((result, index) =>
      result.status === "rejected" ? [plan.states[index]!.grantId] : []);
    const unsavedGrantIds = [...failedGrantIds, ...staleGrantIds];
    const savedCount = results.length - unsavedGrantIds.length;
    return {
      scope: "company_dimension",
      status: unsavedGrantIds.length === 0 ? "succeeded" : savedCount === 0 ? "failed" : "partial",
      plannedCount: plan.states.length,
      savedCount,
      failedCount: unsavedGrantIds.length,
      failedGrantIds: unsavedGrantIds,
      ...(staleGrantIds.length > 0 ? { staleCount: staleGrantIds.length, staleGrantIds } : {}),
    };
  } catch (error) {
    console.warn("profile_question_match_refresh_not_completed", error);
    const failedGrantIds = scopedGrants.map((grant) => `${grant.raw.source}:${grant.raw.source_id}`);
    return {
      scope: "company_dimension",
      status: "failed",
      plannedCount: scopedGrants.length,
      savedCount: 0,
      failedCount: scopedGrants.length,
      failedGrantIds,
    };
  }
}

function parsePlanDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
