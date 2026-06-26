import type { NormalizedGrant } from "@cunote/contracts";
import type { BizInfoProgram } from "@cunote/core";
import type { CunoteDb } from "../db/client";
import {
  planNormalizedGrantPublication,
  publishNormalizedGrants,
  type NormalizedGrantPublishPlan,
  type NormalizedGrantPublishResult,
} from "./normalizedGrantPublisher";

export type BizInfoPublishPlan = NormalizedGrantPublishPlan & { source: "bizinfo" };
export type BizInfoPublishResult = NormalizedGrantPublishResult & { source: "bizinfo" };

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
  return publishNormalizedGrants(db, entries, {
    source: "bizinfo",
    ...options,
  }) as Promise<BizInfoPublishResult>;
}
