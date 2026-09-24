import type { NormalizedGrant } from "@cunote/contracts";
import type { BizInfoProgram } from "@cunote/core";
import type { CunoteDb } from "../db/client";
import { discoverGrantSupplyWork, type GrantSupplyWorkItem } from "../productReadiness/grantSupply";
import {
  planNormalizedGrantPublication,
  publishNormalizedGrants,
  type NormalizedGrantPublishPlan,
  type NormalizedGrantPublishResult,
} from "./normalizedGrantPublisher";

export type BizInfoPublishPlan = NormalizedGrantPublishPlan & { source: "bizinfo" };
export type BizInfoPublishResult = NormalizedGrantPublishResult & {
  source: "bizinfo";
  supplyWorkItems?: readonly GrantSupplyWorkItem[];
};

export function planBizInfoPublication(
  entries: Array<NormalizedGrant<BizInfoProgram>>,
): BizInfoPublishPlan {
  return planNormalizedGrantPublication("bizinfo", entries) as BizInfoPublishPlan;
}

export async function publishBizInfoGrants(
  db: CunoteDb,
  entries: Array<NormalizedGrant<BizInfoProgram>>,
  options: {
    page?: number;
    collectedAt?: Date;
  } = {},
): Promise<BizInfoPublishResult> {
  const published = await publishNormalizedGrants(db, entries, {
    source: "bizinfo",
    ...options,
  });
  try {
    const discovered = await discoverGrantSupplyWork({
      db,
      source: "bizinfo",
      sourceIds: entries.map((entry) => entry.raw.source_id),
    });
    return {
      ...published,
      supplyWorkItems: discovered.items,
      supplyAssessments: discovered.items.flatMap((item) => item.assessment ? [item.assessment] : []),
    } as BizInfoPublishResult;
  } catch {
    console.warn(`[grant-supply] bizinfo discovery_failed count=${entries.length}`);
    return { ...published, supplyAssessmentError: "assessment_failed" } as BizInfoPublishResult;
  }
}
