import type { MatchResult } from "@cunote/contracts";

export type MatchTransitionKind = "becomes_eligible" | "becomes_ineligible";

export type MatchTransitionReason = "eligible_from_due" | "eligible_until_due";

export interface MatchTransitionCandidate {
  companyId: string;
  grantId: string;
  eligibility: MatchResult["eligibility"];
  eligibleFrom?: Date | string | null;
  eligibleUntil?: Date | string | null;
  updatedAt?: Date | string | null;
}

export interface MatchTransitionAction {
  companyId: string;
  grantId: string;
  kind: MatchTransitionKind;
  reason: MatchTransitionReason;
  dueAt: string;
  previousEligibility: MatchResult["eligibility"];
}

export interface MatchTransitionPlan {
  asOf: string;
  counts: Record<MatchTransitionKind, number>;
  transitions: MatchTransitionAction[];
}

export function planMatchTransitions(
  candidates: MatchTransitionCandidate[],
  options: { asOf?: Date } = {},
): MatchTransitionPlan {
  const asOf = options.asOf ?? new Date();
  const transitions = candidates.flatMap((candidate) => dueTransitions(candidate, asOf))
    .sort(compareTransitions);

  return {
    asOf: asOf.toISOString(),
    counts: {
      becomes_eligible: transitions.filter((item) => item.kind === "becomes_eligible").length,
      becomes_ineligible: transitions.filter((item) => item.kind === "becomes_ineligible").length,
    },
    transitions,
  };
}

function dueTransitions(candidate: MatchTransitionCandidate, asOf: Date): MatchTransitionAction[] {
  const transitions: MatchTransitionAction[] = [];
  const eligibleFrom = parseTransitionDate(candidate.eligibleFrom);
  const eligibleUntil = parseTransitionDate(candidate.eligibleUntil);

  if (candidate.eligibility === "ineligible" && eligibleFrom && eligibleFrom.getTime() <= asOf.getTime()) {
    transitions.push({
      companyId: candidate.companyId,
      grantId: candidate.grantId,
      kind: "becomes_eligible",
      reason: "eligible_from_due",
      dueAt: eligibleFrom.toISOString(),
      previousEligibility: candidate.eligibility,
    });
  }

  if (candidate.eligibility !== "ineligible" && eligibleUntil && eligibleUntil.getTime() <= asOf.getTime()) {
    transitions.push({
      companyId: candidate.companyId,
      grantId: candidate.grantId,
      kind: "becomes_ineligible",
      reason: "eligible_until_due",
      dueAt: eligibleUntil.toISOString(),
      previousEligibility: candidate.eligibility,
    });
  }

  return transitions;
}

function parseTransitionDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function compareTransitions(left: MatchTransitionAction, right: MatchTransitionAction): number {
  const dueDelta = left.dueAt.localeCompare(right.dueAt);
  if (dueDelta !== 0) return dueDelta;
  const companyDelta = left.companyId.localeCompare(right.companyId);
  if (companyDelta !== 0) return companyDelta;
  return left.grantId.localeCompare(right.grantId);
}
