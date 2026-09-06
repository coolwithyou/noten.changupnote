import type {
  CriterionConfirmation,
  DashboardResult,
  MatchingProfileView,
  NormalizedGrant,
  ProductTeaserResult,
  OwnedCompanyMatchingResult,
} from "@cunote/contracts";
import { activeUnknownQuestionDimensions, buildDashboard, buildTeaser } from "@cunote/core";
import type { ResolvedProductCompanyProfile } from "./resolveProductCompanyProfile";
import { matchingProfileRevision } from "../repositories/companyProfileConcurrency";

export interface ProductDashboardResult extends DashboardResult {
  profileView: MatchingProfileView;
}

export function buildProductTeaserSnapshot<TPayload>(input: {
  resolution: Pick<ResolvedProductCompanyProfile, "profile" | "view">;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  limit?: number;
  confirmationsByGrantId?: ReadonlyMap<string, CriterionConfirmation[]>;
}): ProductTeaserResult {
  const teaser = buildTeaser({
    company: input.resolution.profile,
    grants: input.grants,
    asOf: input.asOf,
    ...(input.confirmationsByGrantId ? { confirmationsByGrantId: input.confirmationsByGrantId } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { ...teaser, profileView: input.resolution.view };
}

export function buildOwnedCompanyMatchingSnapshot<TPayload>(input: {
  companyId: string;
  resolution: Pick<ResolvedProductCompanyProfile, "profile" | "view">;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  confirmationsByGrantId?: ReadonlyMap<string, CriterionConfirmation[]>;
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
}): ProductDashboardResult {
  const dashboard = buildDashboard({
    company: input.resolution.profile,
    grants: input.grants,
    asOf: input.asOf,
    ...(input.confirmationsByGrantId
      ? { confirmationsByGrantId: input.confirmationsByGrantId }
      : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { ...dashboard, profileView: input.resolution.view };
}
