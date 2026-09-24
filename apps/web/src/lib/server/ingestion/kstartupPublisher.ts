import type { NormalizedGrant } from "@cunote/contracts";
import type { KStartupAnnouncement } from "@cunote/core";
import type { CunoteDb } from "../db/client";
import { discoverGrantSupplyWork, type GrantSupplyWorkItem } from "../productReadiness/grantSupply";
import {
  planNormalizedGrantPublication,
  publishNormalizedGrants,
  type NormalizedGrantPublishPlan,
  type NormalizedGrantPublishResult,
} from "./normalizedGrantPublisher";

export type KStartupPublishPlan = NormalizedGrantPublishPlan & { source: "kstartup" };
export type KStartupPublishResult = NormalizedGrantPublishResult & {
  source: "kstartup";
  supplyWorkItems?: readonly GrantSupplyWorkItem[];
};

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
  const published = await publishNormalizedGrants(db, entries, {
    source: "kstartup",
    ...options,
  });
  try {
    const discovered = await discoverGrantSupplyWork({
      db,
      source: "kstartup",
      sourceIds: entries.map((entry) => entry.raw.source_id),
    });
    return {
      ...published,
      supplyWorkItems: discovered.items,
      supplyAssessments: discovered.items.flatMap((item) => item.assessment ? [item.assessment] : []),
    } as KStartupPublishResult;
  } catch {
    console.warn(`[grant-supply] kstartup discovery_failed count=${entries.length}`);
    return { ...published, supplyAssessmentError: "assessment_failed" } as KStartupPublishResult;
  }
}
