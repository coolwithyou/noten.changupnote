import type { NormalizedGrant } from "@cunote/contracts";
import type {
  BizInfoProgram,
  FindGrantDedupCandidatesOptions,
  KStartupAnnouncement,
} from "@cunote/core";
import {
  planBizInfoPublication,
  type BizInfoPublishPlan,
} from "./bizinfoPublisher";
import {
  planDedupLinksForPublication,
  type DedupLinksForPublicationPlan,
} from "./dedupLinkPublisher";
import {
  planKStartupPublication,
  type KStartupPublishPlan,
} from "./kstartupPublisher";

export interface IngestionBatchPublicationInput {
  kstartupEntries?: Array<NormalizedGrant<KStartupAnnouncement>>;
  bizinfoEntries?: Array<NormalizedGrant<BizInfoProgram>>;
  existingEntries?: Array<NormalizedGrant<unknown>>;
  dedupOptions?: FindGrantDedupCandidatesOptions;
}

export interface IngestionBatchPublicationPlan {
  sourceCount: number;
  publishedEntryCount: number;
  rawCount: number;
  grantCount: number;
  criteriaCount: number;
  kstartup?: KStartupPublishPlan;
  bizinfo?: BizInfoPublishPlan;
  dedup: DedupLinksForPublicationPlan;
}

export function planIngestionBatchPublication({
  kstartupEntries = [],
  bizinfoEntries = [],
  existingEntries = [],
  dedupOptions = {},
}: IngestionBatchPublicationInput): IngestionBatchPublicationPlan {
  const publishedEntries: Array<NormalizedGrant<unknown>> = [
    ...kstartupEntries,
    ...bizinfoEntries,
  ];
  const candidatePool: Array<NormalizedGrant<unknown>> = [
    ...existingEntries,
    ...publishedEntries,
  ];

  const plan: IngestionBatchPublicationPlan = {
    sourceCount: [kstartupEntries.length, bizinfoEntries.length].filter((count) => count > 0).length,
    publishedEntryCount: publishedEntries.length,
    rawCount: publishedEntries.length,
    grantCount: publishedEntries.length,
    criteriaCount: publishedEntries.reduce((sum, entry) => sum + entry.criteria.length, 0),
    dedup: planDedupLinksForPublication(publishedEntries, candidatePool, dedupOptions),
  };

  if (kstartupEntries.length > 0) {
    plan.kstartup = planKStartupPublication(kstartupEntries);
  }
  if (bizinfoEntries.length > 0) {
    plan.bizinfo = planBizInfoPublication(bizinfoEntries);
  }

  return plan;
}
