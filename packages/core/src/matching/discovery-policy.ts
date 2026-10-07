import type { MatchCard } from "@cunote/contracts";
import { evaluateCompoundProjection, type ReviewedCompoundProjection } from "./compound-projection.js";

export interface DiscoveryDecision {
  state: "candidate" | "review" | "upcoming" | "excluded";
  reason: "related_candidate" | "conditions_unconfirmed" | "source_unconfirmed" | "period_unconfirmed" | "not_started" | "closed" | "confirmed_mismatch";
  /** 제외를 설명할 현재 원문 조건만 반환한다. 내부 관련성 점수는 적격 확률이 아니다. */
  criterionIds: string[];
}

/**
 * 탐색용 projection이다. matcher의 eligibility/trace 및 저장된 작성본을 변경하지 않는다.
 * flat 조건의 AND/OR를 추측하지 않는다. 복합식이 없으면 필수 조건 전체가 fail인 경우만
 * 확정 제외한다. 일부 fail + pass/unknown은 확인할 후보로 남긴다.
 */
export function projectDiscoveryCard(card: MatchCard, options: {
  asOf?: Date;
  reviewedExpression?: ReviewedCompoundProjection;
} = {}): DiscoveryDecision {
  const decision = (state: DiscoveryDecision["state"], reason: DiscoveryDecision["reason"], criterionIds: string[] = []): DiscoveryDecision => ({ state, reason, criterionIds });
  if (card.status === "closed" || deadlineHasPassed(card.applyEnd, options.asOf)) return decision("excluded", "closed");
  if (card.matchingEvidence?.level === "discovery") return decision(card.status === "upcoming" ? "upcoming" : "review", "source_unconfirmed");
  const hard = (card.ruleTrace ?? []).filter(trace => trace.kind === "required" || trace.kind === "exclusion");
  const protectedUnknown = hard.some(trace => trace.unresolvedReason && trace.unresolvedReason !== "company_profile_missing");
  const verified = card.matchingEvidence?.level === "verified"
    && /^[a-f0-9]{64}$/.test(card.matchingEvidence.sourceRevisionSha256)
    && card.quality?.extractionReadiness === "reviewed" && !protectedUnknown;
  let mismatch = false;
  let decisive: string[] = [];
  if (verified && options.reviewedExpression) {
    const evaluated = evaluateCompoundProjection(options.reviewedExpression, {
      sourceRevisionSha256: card.matchingEvidence!.sourceRevisionSha256!,
      criteria: hard.map(trace => ({ id: trace.criterionId ?? "", result: trace.result === "pass" || trace.result === "fail" ? trace.result : "unknown" })),
    });
    mismatch = evaluated.result === "fail";
    decisive = evaluated.decisiveCriterionIds;
    if (evaluated.error) return decision("review", "source_unconfirmed");
  } else if (verified && hard.length > 0 && hard.every(trace => trace.result === "fail" && Boolean(trace.sourceSpan?.trim()))) {
    mismatch = true;
    decisive = hard.flatMap(trace => trace.criterionId ? [trace.criterionId] : []);
  }
  if (mismatch) return decision("excluded", "confirmed_mismatch", decisive);
  if (card.status === "upcoming") return decision("upcoming", "not_started");
  if (card.status === "unknown") return decision("review", "period_unconfirmed");
  if (card.eligibility !== "eligible" || (card.recommendationTier && card.recommendationTier !== "recommendable")
    || card.criteriaExtracted === false || protectedUnknown) return decision("review", "conditions_unconfirmed");
  return decision("candidate", "related_candidate");
}

/** 날짜만 있으면 KST 그날 전체를 유지한다. 시각 없는 timestamp 역시 KST로 해석한다. */
export function deadlineHasPassed(end: string | null, asOf?: Date): boolean {
  if (!end || !asOf || !Number.isFinite(asOf.getTime())) return false;
  const value = end.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
    const kstDay = new Date(asOf.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return value < kstDay;
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return false;
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return false;
  const timestamp = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}+09:00`);
  return Number.isFinite(timestamp) && timestamp < asOf.getTime();
}
