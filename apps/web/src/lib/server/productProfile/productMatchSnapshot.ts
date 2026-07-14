import type {
  DashboardResult,
  MatchingProfileView,
  NormalizedGrant,
  ProductTeaserResult,
} from "@cunote/contracts";
import { buildDashboard, buildTeaser } from "@cunote/core";
import type { ResolvedProductCompanyProfile } from "./resolveProductCompanyProfile";

export interface ProductDashboardResult extends DashboardResult {
  profileView: MatchingProfileView;
}

export function buildProductTeaserSnapshot<TPayload>(input: {
  resolution: Pick<ResolvedProductCompanyProfile, "profile" | "view">;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  limit?: number;
}): ProductTeaserResult {
  const teaser = buildTeaser({
    company: input.resolution.profile,
    grants: input.grants,
    asOf: input.asOf,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { ...teaser, profileView: input.resolution.view };
}

export function buildProductDashboardSnapshot<TPayload>(input: {
  resolution: Pick<ResolvedProductCompanyProfile, "profile" | "view">;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  limit?: number;
}): ProductDashboardResult {
  const dashboard = buildDashboard({
    company: input.resolution.profile,
    grants: input.grants,
    asOf: input.asOf,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return { ...dashboard, profileView: input.resolution.view };
}
