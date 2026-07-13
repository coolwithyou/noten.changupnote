import type {
  GrantExtractionWarningCode,
  GrantSource,
  MatchExtractionReadiness,
  NormalizedGrant,
} from "@cunote/contracts";
import { resolveGrantExtractionManifest } from "./manifest.js";

export interface ExtractionReadinessReport {
  grantCount: number;
  readinessCounts: Partial<Record<MatchExtractionReadiness, number>>;
  warningCounts: Partial<Record<GrantExtractionWarningCode, number>>;
  attachmentStatusCounts: Record<string, number>;
  bySource: Partial<Record<GrantSource, {
    grantCount: number;
    readinessCounts: Partial<Record<MatchExtractionReadiness, number>>;
    warningCounts: Partial<Record<GrantExtractionWarningCode, number>>;
  }>>;
  incompleteSamples: Array<{
    grantId: string;
    title: string;
    readiness: MatchExtractionReadiness;
    warnings: GrantExtractionWarningCode[];
    attachmentsExpected: number;
    attachmentsFetched: number;
    attachmentsConverted: number;
  }>;
}

export function buildExtractionReadinessReport<TPayload>(
  grants: Array<NormalizedGrant<TPayload>>,
  options: { sampleLimit?: number } = {},
): ExtractionReadinessReport {
  const sampleLimit = boundedSampleLimit(options.sampleLimit);
  const entries = grants.map((grant) => ({ grant, manifest: resolveGrantExtractionManifest(grant) }));
  const bySource: ExtractionReadinessReport["bySource"] = {};

  for (const source of unique(grants.map((grant) => grant.grant.source))) {
    const sourceEntries = entries.filter((entry) => entry.grant.grant.source === source);
    bySource[source] = {
      grantCount: sourceEntries.length,
      readinessCounts: histogram(sourceEntries.map((entry) => entry.manifest.readiness)),
      warningCounts: histogram(sourceEntries.flatMap((entry) => entry.manifest.warnings)),
    };
  }

  return {
    grantCount: grants.length,
    readinessCounts: histogram(entries.map((entry) => entry.manifest.readiness)),
    warningCounts: histogram(entries.flatMap((entry) => entry.manifest.warnings)),
    attachmentStatusCounts: histogram(grants.flatMap((grant) =>
      (grant.raw.attachments ?? []).map((attachment) => attachment.conversion?.status ?? "pending"))),
    bySource,
    incompleteSamples: entries
      .filter((entry) => entry.manifest.readiness === "partial" || entry.manifest.readiness === "unstructured")
      .sort((left, right) =>
        warningPriority(right.manifest.warnings) - warningPriority(left.manifest.warnings) ||
        left.manifest.grantId.localeCompare(right.manifest.grantId))
      .slice(0, sampleLimit)
      .map(({ grant, manifest }) => ({
        grantId: manifest.grantId,
        title: grant.grant.title,
        readiness: manifest.readiness,
        warnings: manifest.warnings,
        attachmentsExpected: manifest.attachmentsExpected,
        attachmentsFetched: manifest.attachmentsFetched,
        attachmentsConverted: manifest.attachmentsConverted,
      })),
  };
}

function warningPriority(warnings: GrantExtractionWarningCode[]): number {
  const weights: Partial<Record<GrantExtractionWarningCode, number>> = {
    criteria_missing: 100,
    source_field_missing: 80,
    source_section_missing: 80,
    attachment_conversion_failed: 70,
    attachment_fetch_incomplete: 60,
    attachment_conversion_incomplete: 50,
    hard_criterion_evidence_missing: 40,
    text_only_criterion_present: 30,
    criterion_review_required: 20,
  };
  return warnings.reduce((sum, warning) => sum + (weights[warning] ?? 0), 0);
}

function histogram<T extends string>(values: T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function boundedSampleLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value)) return 20;
  return Math.max(0, Math.min(100, value));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
