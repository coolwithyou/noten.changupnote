import type { CompanyProfile, MatchResult, NormalizedGrant } from "@cunote/contracts";
import { planMatchStateRefresh, type MatchStateRefreshItem } from "./plan-match-state-refresh.js";

export type ScopedMatchRefreshScope = "none" | "pair" | "company" | "grant" | "manual";

export interface ScopedRefreshCompany {
  companyId: string;
  profile: CompanyProfile;
}

export interface ExistingMatchStateSnapshot {
  companyId: string;
  grantId: string;
  eligibility: MatchResult["eligibility"];
  fitScore: number;
  rulesetVer: string;
  scoringVer: string;
  ruleTrace: MatchResult["rule_trace"];
  eligibleFrom: string | null;
  eligibleUntil: string | null;
}

export interface ScopedMatchStateRefreshItem extends MatchStateRefreshItem {
  companyId: string;
  changed: boolean;
  changeReasons: string[];
}

export interface ScopedMatchStateRefreshPlan {
  scope: ScopedMatchRefreshScope;
  asOf: string;
  companyCount: number;
  grantCount: number;
  stateCount: number;
  changedCount: number;
  unchangedCount: number;
  states: ScopedMatchStateRefreshItem[];
}

export function planScopedMatchStateRefresh<TPayload>(input: {
  scope: ScopedMatchRefreshScope;
  companies: ScopedRefreshCompany[];
  grants: Array<NormalizedGrant<TPayload>>;
  existingStates?: ExistingMatchStateSnapshot[];
  asOf?: Date;
}): ScopedMatchStateRefreshPlan {
  const asOf = validDate(input.asOf ?? new Date(), "asOf");
  validateCardinality(input.scope, input.companies.length, input.grants.length);
  if (input.scope === "none" || input.scope === "manual") {
    return {
      scope: input.scope,
      asOf: asOf.toISOString(),
      companyCount: 0,
      grantCount: 0,
      stateCount: 0,
      changedCount: 0,
      unchangedCount: 0,
      states: [],
    };
  }
  const existingByKey = new Map((input.existingStates ?? []).map((state) => [stateKey(state.companyId, state.grantId), state]));
  const states = input.companies.flatMap((company): ScopedMatchStateRefreshItem[] => {
    const planned = planMatchStateRefresh({
      company: company.profile,
      grants: input.grants,
      asOf,
      companyId: company.companyId,
    });
    return planned.states.map((state) => {
      const existing = existingByKey.get(stateKey(company.companyId, state.grantId));
      const changeReasons = matchStateChangeReasons(state, existing);
      return { ...state, companyId: company.companyId, changed: changeReasons.length > 0, changeReasons };
    });
  });
  return {
    scope: input.scope,
    asOf: asOf.toISOString(),
    companyCount: input.companies.length,
    grantCount: input.grants.length,
    stateCount: states.length,
    changedCount: states.filter((state) => state.changed).length,
    unchangedCount: states.filter((state) => !state.changed).length,
    states,
  };
}

function matchStateChangeReasons(
  planned: MatchStateRefreshItem,
  existing: ExistingMatchStateSnapshot | undefined,
): string[] {
  if (!existing) return ["missing_state"];
  const reasons: string[] = [];
  if (existing.eligibility !== planned.eligibility) reasons.push("eligibility");
  if (existing.fitScore !== Math.round(planned.fitScore)) reasons.push("fit_score");
  if (existing.rulesetVer !== planned.rulesetVer) reasons.push("ruleset_version");
  if (existing.scoringVer !== planned.scoringVer) reasons.push("scoring_version");
  if (existing.eligibleFrom !== planned.eligibleFrom) reasons.push("eligible_from");
  if (existing.eligibleUntil !== planned.eligibleUntil) reasons.push("eligible_until");
  if (stableStringify(existing.ruleTrace) !== stableStringify(planned.match.rule_trace)) reasons.push("rule_trace");
  return reasons;
}

function validateCardinality(scope: ScopedMatchRefreshScope, companies: number, grants: number): void {
  if (scope === "none" || scope === "manual") return;
  if (scope === "pair" && (companies !== 1 || grants !== 1)) throw new Error("pair scope requires exactly one company and one grant");
  if (scope === "company" && companies !== 1) throw new Error("company scope requires exactly one company");
  if (scope === "grant" && grants !== 1) throw new Error("grant scope requires exactly one grant");
  if (companies === 0 || grants === 0) throw new Error(`${scope} scope requires non-empty companies and grants`);
}
function stateKey(companyId: string, grantId: string): string {
  return `${companyId}\u0000${grantId}`;
}
function validDate(value: Date, label: string): Date {
  if (Number.isNaN(value.getTime())) throw new Error(`${label} must be a valid date`);
  return value;
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
