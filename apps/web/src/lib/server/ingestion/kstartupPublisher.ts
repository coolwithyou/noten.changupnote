import type { NormalizedGrant } from "@cunote/contracts";
import type { KStartupAnnouncement } from "@cunote/core";
import type { CunoteDb } from "../db/client";
import {
  planNormalizedGrantPublication,
  publishNormalizedGrants,
  type NormalizedGrantPublishPlan,
  type NormalizedGrantPublishResult,
} from "./normalizedGrantPublisher";

export type KStartupPublishPlan = NormalizedGrantPublishPlan & { source: "kstartup" };
export type KStartupPublishResult = NormalizedGrantPublishResult & { source: "kstartup" };

export function planKStartupPublication(
  entries: Array<NormalizedGrant<KStartupAnnouncement>>,
): KStartupPublishPlan {
  return planNormalizedGrantPublication("kstartup", entries) as KStartupPublishPlan;
}

export async function publishKStartupGrants(
  db: CunoteDb,
  entries: Array<NormalizedGrant<KStartupAnnouncement>>,
  options: {
    page?: number;
    collectedAt?: Date;
  } = {},
): Promise<KStartupPublishResult> {
  return publishNormalizedGrants(db, entries, {
    source: "kstartup",
    ...options,
  }) as Promise<KStartupPublishResult>;
}
