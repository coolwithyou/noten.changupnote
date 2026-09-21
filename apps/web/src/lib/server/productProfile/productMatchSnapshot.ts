import type {
  CriterionConfirmation,
  DashboardResult,
  MatchingProfileView,
  NormalizedGrant,
  ProductTeaserResult,
  OwnedCompanyMatchingResult,
} from "@cunote/contracts";
import {
  activeUnknownQuestionDimensions,
  buildDashboard,
  buildTeaser,
  selectTeaserDisplay,
} from "@cunote/core";
import type { MatchingConfirmationCriterionBinding } from "@cunote/core";
import type { ResolvedProductCompanyProfile } from "./resolveProductCompanyProfile";
import { matchingProfileRevision } from "../repositories/companyProfileConcurrency";

export interface ProductDashboardResult extends DashboardResult {
  profileView: MatchingProfileView;
}

/**
 * Apply the final teaser page only after server annotations have established
 * the exact active-question proof. `matches` must be the complete candidate
 * pool, not an already paginated teaser response.
 */
export function selectProductTeaserDisplay<T extends ProductTeaserResult>(
  teaser: T,
  options: { limit?: number } = {},
): T {
  const selection = selectTeaserDisplay(teaser.matches, options);
  return {
    ...teaser,
    counts: { ...teaser.counts, oneQuestionAway: selection.oneQuestionAwayCount },
    matches: selection.matches,
    recommendableMatches: selection.recommendableMatches,
    reviewNeededMatches: selection.reviewNeededMatches,
  };
}

export function buildProductTeaserSnapshot<TPayload>(input: {
  resolution: Pick<ResolvedProductCompanyProfile, "profile" | "view">;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  limit?: number;
  confirmationsByGrantId?: ReadonlyMap<string, CriterionConfirmation[]>;
  confirmationQuestionBindingsByGrantId?: ReadonlyMap<string, MatchingConfirmationCriterionBinding[]>;
}): ProductTeaserResult {
  const teaser = buildTeaser({
    company: input.resolution.profile,
    grants: input.grants,
    asOf: input.asOf,
    ...(input.confirmationsByGrantId ? { confirmationsByGrantId: input.confirmationsByGrantId } : {}),
    ...(input.confirmationQuestionBindingsByGrantId
      ? { confirmationQuestionBindingsByGrantId: input.confirmationQuestionBindingsByGrantId }
      : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { ...teaser, profileView: input.resolution.view };
}

export function buildOwnedCompanyMatchingSnapshot<TPayload>(input: {
  companyId: string;
  resolution: Pick<ResolvedProductCompanyProfile, "profile" | "view">;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  limit?: number;
  confirmationsByGrantId?: ReadonlyMap<string, CriterionConfirmation[]>;
  confirmationQuestionBindingsByGrantId?: ReadonlyMap<string, MatchingConfirmationCriterionBinding[]>;
}): OwnedCompanyMatchingResult {
  return {
    companyId: input.companyId,
    companyName: input.resolution.profile.name ?? null,
    profileRevision: matchingProfileRevision(input.resolution.profile),
    teaser: {
      ...buildProductTeaserSnapshot(input),
      privacyNote: "계정에 저장한 사업자 정보와 확인 답변을 기준으로 매칭합니다.",
    },
    unknownDimensions: [...activeUnknownQuestionDimensions(input.resolution.profile, input.asOf)],
  };
}

export function buildProductDashboardSnapshot<TPayload>(input: {
  resolution: Pick<ResolvedProductCompanyProfile, "profile" | "view">;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  limit?: number;
  confirmationsByGrantId?: ReadonlyMap<string, CriterionConfirmation[]>;
  confirmationQuestionBindingsByGrantId?: ReadonlyMap<string, MatchingConfirmationCriterionBinding[]>;
}): ProductDashboardResult {
  const dashboard = buildDashboard({
    company: input.resolution.profile,
    grants: input.grants,
    asOf: input.asOf,
    ...(input.confirmationsByGrantId
      ? { confirmationsByGrantId: input.confirmationsByGrantId }
      : {}),
    ...(input.confirmationQuestionBindingsByGrantId
      ? { confirmationQuestionBindingsByGrantId: input.confirmationQuestionBindingsByGrantId }
      : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { ...dashboard, profileView: input.resolution.view };
}
