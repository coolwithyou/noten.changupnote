import type { CompanyProfile, NormalizedGrant } from "@cunote/contracts";
import {
  planMatchStateRefresh,
  type BizInfoProgram,
  type FindGrantDedupCandidatesOptions,
  type KStartupAnnouncement,
  type MatchStateRefreshPlan,
} from "@cunote/core";
import {
  planIngestionBatchPublication,
  type IngestionBatchPublicationPlan,
} from "./ingestion/ingestionBatchPlan";

export interface ServicePipelinePlanInput {
  company: CompanyProfile;
  companyId?: string;
  kstartupEntries?: Array<NormalizedGrant<KStartupAnnouncement>>;
  bizinfoEntries?: Array<NormalizedGrant<BizInfoProgram>>;
  existingEntries?: Array<NormalizedGrant<unknown>>;
  dedupOptions?: FindGrantDedupCandidatesOptions;
  asOf?: Date;
}

export interface ServicePipelinePlan {
  asOf: string;
  ingestion: IngestionBatchPublicationPlan;
  matchState: MatchStateRefreshPlan;
  checks: {
    hasPublishedEntries: boolean;
    hasCriteria: boolean;
    matchStateCoversPublishedEntries: boolean;
    hasDecisionTrace: boolean;
  };
  warnings: string[];
}

export function planServicePipeline({
  company,
  companyId,
  kstartupEntries = [],
  bizinfoEntries = [],
  existingEntries = [],
  dedupOptions = {},
  asOf = new Date(),
}: ServicePipelinePlanInput): ServicePipelinePlan {
  const publishedEntries: Array<NormalizedGrant<unknown>> = [
    ...kstartupEntries,
    ...bizinfoEntries,
  ];
  const ingestion = planIngestionBatchPublication({
    kstartupEntries,
    bizinfoEntries,
    existingEntries,
    dedupOptions,
  });
  const matchState = planMatchStateRefresh({
    company,
    grants: publishedEntries,
    asOf,
    ...(companyId ? { companyId } : {}),
  });
  const checks = {
    hasPublishedEntries: ingestion.publishedEntryCount > 0,
    hasCriteria: ingestion.criteriaCount > 0,
    matchStateCoversPublishedEntries: matchState.grantCount === ingestion.publishedEntryCount,
    hasDecisionTrace: matchState.states.every((state) => state.match.rule_trace.length > 0),
  };

  return {
    asOf: asOf.toISOString(),
    ingestion,
    matchState,
    checks,
    warnings: pipelineWarnings(checks),
  };
}

function pipelineWarnings(checks: ServicePipelinePlan["checks"]): string[] {
  const warnings: string[] = [];
  if (!checks.hasPublishedEntries) warnings.push("no published entries planned");
  if (!checks.hasCriteria) warnings.push("no grant criteria planned");
  if (!checks.matchStateCoversPublishedEntries) warnings.push("match state plan does not cover every published entry");
  if (!checks.hasDecisionTrace) warnings.push("at least one match state has no rule trace");
  return warnings;
}
