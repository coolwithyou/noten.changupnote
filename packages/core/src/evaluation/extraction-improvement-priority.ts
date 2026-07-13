import type {
  CompanyProfile,
  GrantExtractionWarningCode,
  GrantSource,
  MatchExtractionReadiness,
  NormalizedGrant,
} from "@cunote/contracts";
import { resolveGrantExtractionManifest } from "../extraction/manifest.js";
import { matchNormalizedGrant } from "../matching/match.js";

export type ExtractionImprovementAction =
  | "archive_attachments"
  | "register_or_convert_attachments"
  | "reextract"
  | "repair_evidence"
  | "human_review";

export interface ExtractionImprovementCandidate {
  grantId: string;
  source: GrantSource;
  sourceId: string;
  title: string;
  readiness: MatchExtractionReadiness;
  warnings: GrantExtractionWarningCode[];
  primaryAction: ExtractionImprovementAction;
  actions: ExtractionImprovementAction[];
  eligibleBlockedCompanyCount: number;
  conditionalCompanyCount: number;
  ineligibleCompanyCount: number;
  hardUnknownConditionCount: number;
  deadlineDays: number | null;
  effort: "quick" | "medium" | "long";
  priorityScore: number;
}

export interface ExtractionImprovementPlan {
  grantCount: number;
  companyCount: number;
  candidateCount: number;
  totalEligibleBlockedCompanyCount: number;
  actionCounts: Partial<Record<ExtractionImprovementAction, number>>;
  bySource: Partial<Record<GrantSource, {
    candidateCount: number;
    eligibleBlockedCompanyCount: number;
    actionCounts: Partial<Record<ExtractionImprovementAction, number>>;
  }>>;
  candidates: ExtractionImprovementCandidate[];
}

export function planExtractionImprovements<TPayload>(input: {
  grants: Array<NormalizedGrant<TPayload>>;
  companies: CompanyProfile[];
  asOf?: Date;
}): ExtractionImprovementPlan {
  const asOf = input.asOf ?? new Date();
  const candidates = input.grants.flatMap((grant) => {
    const manifest = resolveGrantExtractionManifest(grant);
    if (manifest.readiness === "reviewed") return [];
    const actions = actionsFor(manifest.readiness, manifest.warnings);
    const effort = effortFor(actions[0]!);
    let eligibleBlockedCompanyCount = 0;
    let conditionalCompanyCount = 0;
    let ineligibleCompanyCount = 0;
    let hardUnknownConditionCount = 0;
    for (const company of input.companies) {
      const match = matchNormalizedGrant(grant, company);
      if (match.eligibility === "eligible") {
        if (match.review_gate?.tier !== "recommendable") eligibleBlockedCompanyCount += 1;
      } else if (match.eligibility === "conditional") {
        conditionalCompanyCount += 1;
      } else {
        ineligibleCompanyCount += 1;
      }
      hardUnknownConditionCount += match.rule_trace.filter((trace) =>
        trace.result === "unknown" && (trace.kind === "required" || trace.kind === "exclusion")).length;
    }
    if (eligibleBlockedCompanyCount === 0 && conditionalCompanyCount === 0) return [];
    const deadlineDays = daysUntil(grant.grant.apply_end, asOf);
    const impactScore = eligibleBlockedCompanyCount * 100 + conditionalCompanyCount * 12 +
      Math.min(100, hardUnknownConditionCount * 2) + deadlineWeight(deadlineDays);
    return [{
      grantId: manifest.grantId,
      source: grant.grant.source,
      sourceId: grant.grant.source_id,
      title: grant.grant.title,
      readiness: manifest.readiness,
      warnings: manifest.warnings,
      primaryAction: actions[0]!,
      actions,
      eligibleBlockedCompanyCount,
      conditionalCompanyCount,
      ineligibleCompanyCount,
      hardUnknownConditionCount,
      deadlineDays,
      effort,
      priorityScore: Math.round(impactScore / effortDivisor(effort)),
    }];
  }).sort((left, right) =>
    right.priorityScore - left.priorityScore ||
    right.eligibleBlockedCompanyCount - left.eligibleBlockedCompanyCount ||
    left.grantId.localeCompare(right.grantId));

  const bySource: ExtractionImprovementPlan["bySource"] = {};
  for (const source of [...new Set(candidates.map((candidate) => candidate.source))]) {
    const sourceCandidates = candidates.filter((candidate) => candidate.source === source);
    bySource[source] = {
      candidateCount: sourceCandidates.length,
      eligibleBlockedCompanyCount: sum(sourceCandidates.map((candidate) => candidate.eligibleBlockedCompanyCount)),
      actionCounts: histogram(sourceCandidates.map((candidate) => candidate.primaryAction)),
    };
  }
  return {
    grantCount: input.grants.length,
    companyCount: input.companies.length,
    candidateCount: candidates.length,
    totalEligibleBlockedCompanyCount: sum(candidates.map((candidate) => candidate.eligibleBlockedCompanyCount)),
    actionCounts: histogram(candidates.map((candidate) => candidate.primaryAction)),
    bySource,
    candidates,
  };
}

function actionsFor(
  readiness: MatchExtractionReadiness,
  warnings: GrantExtractionWarningCode[],
): ExtractionImprovementAction[] {
  const actions: ExtractionImprovementAction[] = [];
  if (warnings.includes("attachment_fetch_incomplete")) actions.push("archive_attachments");
  if (warnings.includes("attachment_conversion_incomplete") || warnings.includes("attachment_conversion_failed")) {
    actions.push("register_or_convert_attachments");
  }
  if (
    readiness === "unstructured" ||
    warnings.includes("criteria_missing") ||
    warnings.includes("text_only_criterion_present") ||
    warnings.includes("source_field_missing") ||
    warnings.includes("source_section_missing")
  ) actions.push("reextract");
  if (warnings.includes("hard_criterion_evidence_missing")) actions.push("repair_evidence");
  if (readiness === "structured_unreviewed" || warnings.includes("criterion_review_required")) actions.push("human_review");
  return unique(actions.length > 0 ? actions : ["human_review"]);
}

function effortFor(action: ExtractionImprovementAction): ExtractionImprovementCandidate["effort"] {
  if (action === "human_review" || action === "repair_evidence") return "quick";
  if (action === "archive_attachments" || action === "register_or_convert_attachments") return "medium";
  return "long";
}
function effortDivisor(effort: ExtractionImprovementCandidate["effort"]): number {
  return effort === "quick" ? 1 : effort === "medium" ? 2 : 3;
}
function deadlineWeight(days: number | null): number {
  if (days === null || days < 0) return 0;
  if (days <= 7) return 80;
  if (days <= 21) return 40;
  return 10;
}
function daysUntil(value: string | null | undefined, asOf: Date): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.ceil((timestamp - asOf.getTime()) / 86_400_000);
}
function histogram<T extends string>(values: T[]): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
