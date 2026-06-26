import type { NormalizedGrant, StatsResult } from "@cunote/contracts";
import { daysUntil, supportAmountMax } from "./match-card.js";

export interface BuildStatsOptions<TPayload = unknown> {
  grants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
}

export function buildStats<TPayload>({
  grants,
  asOf = new Date(),
}: BuildStatsOptions<TPayload>): StatsResult {
  const openGrants = grants.filter((entry) => entry.grant.status === "open");
  const totalAmount = openGrants.reduce(
    (sum, entry) => sum + supportAmountMax(entry.grant.support_amount),
    0,
  );
  const deadlineSoonCount = openGrants.filter((entry) => {
    const dDay = daysUntil(entry.grant.apply_end ?? null, asOf);
    return dDay !== null && dDay >= 0 && dDay <= 7;
  }).length;

  return {
    openCount: openGrants.length,
    totalAmount,
    deadlineSoonCount,
    updatedAt: asOf.toISOString(),
  };
}
