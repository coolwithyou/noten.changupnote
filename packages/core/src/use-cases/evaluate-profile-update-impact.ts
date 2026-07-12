import type {
  CompanyProfile,
  CriterionDimension,
  Eligibility,
  NormalizedGrant,
  ProfileUpdateImpactDto,
} from "@cunote/contracts";
import { matchNormalizedGrant } from "../matching/match.js";
import { grantKey } from "./match-card.js";

export type ProfileUpdateImpact = ProfileUpdateImpactDto;

export interface EvaluateProfileUpdateImpactInput<TPayload = unknown> {
  grants: Array<NormalizedGrant<TPayload>>;
  beforeProfile: CompanyProfile;
  afterProfile: CompanyProfile;
  dimension: CriterionDimension;
  windowLimit?: number;
}

/**
 * 한 프로필 필드 답변이 실제 판정에 미친 영향을 동일 공고 집합에서 비교한다.
 * 분모는 답변 전에 해당 dimension의 hard unknown 때문에 conditional이었던 공고만 사용한다.
 */
export function evaluateProfileUpdateImpact<TPayload>(
  input: EvaluateProfileUpdateImpactInput<TPayload>,
): ProfileUpdateImpact {
  let targetedConditionalCount = 0;
  let dimensionResolvedGrantCount = 0;
  let conditionalToEligibleCount = 0;
  let conditionalToIneligibleCount = 0;
  let remainingConditionalCount = 0;
  const transitionCounts: Record<string, number> = {};
  const refreshGrantIds: string[] = [];

  for (const grant of input.grants) {
    const before = matchNormalizedGrant(grant, input.beforeProfile);
    const after = matchNormalizedGrant(grant, input.afterProfile);
    const transition = `${before.eligibility}_to_${after.eligibility}`;
    transitionCounts[transition] = (transitionCounts[transition] ?? 0) + 1;
    if (matchStateChanged(before, after)) refreshGrantIds.push(grantKey(grant.grant));

    if (before.eligibility !== "conditional" || !hasHardUnknown(before, input.dimension)) continue;
    targetedConditionalCount += 1;

    if (!hasHardUnknown(after, input.dimension)) dimensionResolvedGrantCount += 1;
    if (after.eligibility === "eligible") conditionalToEligibleCount += 1;
    else if (after.eligibility === "ineligible") conditionalToIneligibleCount += 1;
    else remainingConditionalCount += 1;
  }

  const eligibilityResolvedCount = conditionalToEligibleCount + conditionalToIneligibleCount;
  return {
    scope: "active_grant_window",
    windowLimit: input.grants.length === 0 ? 0 : input.windowLimit ?? input.grants.length,
    dimension: input.dimension,
    evaluatedGrantCount: input.grants.length,
    targetedConditionalCount,
    dimensionResolvedGrantCount,
    eligibilityResolvedCount,
    conditionalToEligibleCount,
    conditionalToIneligibleCount,
    remainingConditionalCount,
    conditionalResolutionRate: ratio(eligibilityResolvedCount, targetedConditionalCount),
    transitionCounts,
    changedMatchStateCount: refreshGrantIds.length,
    refreshGrantIds,
  };
}

export function selectProfileUpdateRefreshGrants<TPayload>(
  grants: Array<NormalizedGrant<TPayload>>,
  impact: Pick<ProfileUpdateImpact, "refreshGrantIds">,
): Array<NormalizedGrant<TPayload>> {
  const ids = new Set(impact.refreshGrantIds);
  return grants.filter((grant) => ids.has(grantKey(grant.grant)));
}

function matchStateChanged(
  before: ReturnType<typeof matchNormalizedGrant>,
  after: ReturnType<typeof matchNormalizedGrant>,
): boolean {
  return (
    before.eligibility !== after.eligibility ||
    before.fit_score !== after.fit_score ||
    before.ruleset_ver !== after.ruleset_ver ||
    before.scoring_ver !== after.scoring_ver ||
    stableStringify(before.rule_trace) !== stableStringify(after.rule_trace)
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hasHardUnknown(
  match: { eligibility: Eligibility; rule_trace: Array<{ dimension: CriterionDimension; kind: string; result: string }> },
  dimension: CriterionDimension,
): boolean {
  return match.rule_trace.some((entry) =>
    entry.dimension === dimension &&
    entry.result === "unknown" &&
    (entry.kind === "required" || entry.kind === "exclusion"));
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}
