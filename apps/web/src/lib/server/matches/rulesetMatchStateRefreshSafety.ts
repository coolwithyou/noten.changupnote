import { createHash } from "node:crypto";

export interface RulesetRefreshManifest {
  asOf: string;
  currentRulesetVer: string;
  currentScoringVer: string;
  scopeHash: string;
  evaluationInputHash: string;
  targetCompanyCount: number;
  activeGrantCount: number;
  existingStoredStateCount: number;
  plannedStateCount: number;
  missingActiveStateCount: number;
  obsoleteStoredStateCount: number;
  changedEligibilityCount: number;
  rulesetOnlyUpdateCount: number;
  transitions: Record<string, number>;
  transitionReviewGrants: Array<{
    transition: string;
    source: string;
    sourceId: string;
    title: string;
  }>;
}

export interface RulesetRefreshSafetyAssessment {
  manifestMatchesCurrentInputs: boolean;
  planFresh: boolean;
  missingReviewedGrantKeys: string[];
  unpublishedReviewedGrantKeys: string[];
  writeReady: boolean;
}

export function stableSha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function parseRulesetRefreshManifest(value: unknown): RulesetRefreshManifest {
  const record = requiredRecord(value, "refresh manifest");
  const transitions = numberRecord(record.transitions, "transitions");
  if (!Array.isArray(record.transitionReviewGrants)) {
    throw new Error("refresh manifest must include the complete transitionReviewGrants list");
  }
  const manifest: RulesetRefreshManifest = {
    asOf: requiredIsoDate(record.asOf, "asOf"),
    currentRulesetVer: requiredString(record.currentRulesetVer, "currentRulesetVer"),
    currentScoringVer: requiredString(record.currentScoringVer, "currentScoringVer"),
    scopeHash: requiredSha256(record.scopeHash, "scopeHash"),
    evaluationInputHash: requiredSha256(record.evaluationInputHash, "evaluationInputHash"),
    targetCompanyCount: nonNegativeInteger(record.targetCompanyCount, "targetCompanyCount"),
    activeGrantCount: nonNegativeInteger(record.activeGrantCount, "activeGrantCount"),
    existingStoredStateCount: nonNegativeInteger(record.existingStoredStateCount, "existingStoredStateCount"),
    plannedStateCount: nonNegativeInteger(record.plannedStateCount, "plannedStateCount"),
    missingActiveStateCount: nonNegativeInteger(record.missingActiveStateCount, "missingActiveStateCount"),
    obsoleteStoredStateCount: nonNegativeInteger(record.obsoleteStoredStateCount, "obsoleteStoredStateCount"),
    changedEligibilityCount: nonNegativeInteger(record.changedEligibilityCount, "changedEligibilityCount"),
    rulesetOnlyUpdateCount: nonNegativeInteger(record.rulesetOnlyUpdateCount, "rulesetOnlyUpdateCount"),
    transitions,
    transitionReviewGrants: record.transitionReviewGrants.map((item, index) => {
      const row = requiredRecord(item, `transitionReviewGrants[${index}]`);
      return {
        transition: requiredString(row.transition, `transitionReviewGrants[${index}].transition`),
        source: requiredString(row.source, `transitionReviewGrants[${index}].source`),
        sourceId: requiredString(row.sourceId, `transitionReviewGrants[${index}].sourceId`),
        title: requiredString(row.title, `transitionReviewGrants[${index}].title`),
      };
    }),
  };
  const duplicateKeys = duplicates(manifest.transitionReviewGrants.map((item) => `${item.transition}:${reviewGrantKey(item)}`));
  if (duplicateKeys.length > 0) throw new Error(`duplicate transition review grants: ${duplicateKeys.join(", ")}`);
  return manifest;
}

export function assessRulesetRefreshSafety(input: {
  expected: RulesetRefreshManifest;
  actual: RulesetRefreshManifest;
  reviewedGrantKeys: Iterable<string>;
  publishedGrantKeys: Iterable<string>;
  now?: Date;
  maxPlanAgeMs?: number;
}): RulesetRefreshSafetyAssessment {
  const expectedComparable = comparableManifest(input.expected);
  const actualComparable = comparableManifest(input.actual);
  const manifestMatchesCurrentInputs = stableJson(expectedComparable) === stableJson(actualComparable);
  const reviewed = new Set(input.reviewedGrantKeys);
  const published = new Set(input.publishedGrantKeys);
  const ageMs = (input.now ?? new Date()).getTime() - new Date(input.actual.asOf).getTime();
  const planFresh = ageMs >= -5 * 60_000 && ageMs <= (input.maxPlanAgeMs ?? 30 * 60_000);
  const required = input.actual.transitionReviewGrants.map(reviewGrantKey).sort();
  const missingReviewedGrantKeys = required.filter((key) => !reviewed.has(key));
  const unpublishedReviewedGrantKeys = required.filter((key) => !published.has(key));
  return {
    manifestMatchesCurrentInputs,
    planFresh,
    missingReviewedGrantKeys,
    unpublishedReviewedGrantKeys,
    writeReady: manifestMatchesCurrentInputs && planFresh && missingReviewedGrantKeys.length === 0 &&
      unpublishedReviewedGrantKeys.length === 0,
  };
}

export function reviewGrantKey(value: { source: string; sourceId: string }): string {
  return `${value.source}:${value.sourceId}`;
}

export function selectRulesetRefreshTargetCompanyIds(input: {
  companyIds: Iterable<string>;
  activeGrantIds: Iterable<string>;
  states: Array<{ companyId: string; grantId: string; rulesetVer: string; scoringVer: string }>;
  rulesetVer: string;
  scoringVer: string;
}): string[] {
  const activeGrantIds = new Set(input.activeGrantIds);
  const currentCountByCompany = new Map<string, number>();
  for (const state of input.states) {
    if (!activeGrantIds.has(state.grantId) || state.rulesetVer !== input.rulesetVer ||
      state.scoringVer !== input.scoringVer) continue;
    currentCountByCompany.set(state.companyId, (currentCountByCompany.get(state.companyId) ?? 0) + 1);
  }
  return [...input.companyIds].filter((companyId) =>
    (currentCountByCompany.get(companyId) ?? 0) !== activeGrantIds.size).sort();
}

function comparableManifest(value: RulesetRefreshManifest): Omit<RulesetRefreshManifest, "transitionReviewGrants"> & {
  transitionReviewGrants: RulesetRefreshManifest["transitionReviewGrants"];
} {
  return {
    ...value,
    transitions: Object.fromEntries(Object.entries(value.transitions).sort(([left], [right]) => left.localeCompare(right))),
    transitionReviewGrants: [...value.transitionReviewGrants].sort((left, right) =>
      reviewGrantKey(left).localeCompare(reviewGrantKey(right)) || left.transition.localeCompare(right.transition)),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requiredIsoDate(value: unknown, label: string): string {
  const text = requiredString(value, label);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO date`);
  return parsed.toISOString();
}

function requiredSha256(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error(`${label} must be sha256`);
  return text.toLowerCase();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function numberRecord(value: unknown, label: string): Record<string, number> {
  const record = requiredRecord(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, nonNegativeInteger(item, `${label}.${key}`)]));
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  return [...duplicated].sort();
}
