import type { ActionQueueItem, CriterionDimension, MatchCard } from "@cunote/contracts";
import { urgencyForDday } from "./match-card.js";

export interface BuildActionQueueOptions {
  matches: MatchCard[];
  limit?: number;
}

interface ActionAccumulator {
  kind: ActionQueueItem["kind"];
  title: string;
  reason: string;
  ctaLabel: string;
  target: string;
  affectedGrantIds: Set<string>;
  leverageAmount: number;
  urgency: ActionQueueItem["urgency"];
  effort: ActionQueueItem["effort"];
  baseScore: number;
}

export function buildActionQueue({
  matches,
  limit = 5,
}: BuildActionQueueOptions): ActionQueueItem[] {
  const actions = new Map<string, ActionAccumulator>();

  for (const match of matches) {
    if (match.eligibility === "eligible") {
      addAction(actions, `apply:${match.grantId}`, {
        kind: "apply",
        title: `${match.title} 신청 일정 확인`,
        reason: dDayReason(match.dDay),
        ctaLabel: "신청 준비",
        target: match.detailUrl ?? match.grantId,
        affectedGrantIds: new Set([match.grantId]),
        leverageAmount: match.supportAmount.max ?? 0,
        urgency: urgencyForDday(match.dDay),
        effort: "long",
        baseScore: match.fitScore,
      });
    }

    for (const trace of match.ruleTrace) {
      if (trace.result === "unknown") {
        const key = `input:${trace.dimension}`;
        const label = dimensionLabel(trace.dimension);
        addAction(actions, key, {
          kind: "input",
          title: `${label} 정보 확인`,
          reason: `${match.title} 포함 조건부 공고를 확정 또는 제외하는 데 필요합니다.`,
          ctaLabel: "지금 입력",
          target: trace.dimension,
          affectedGrantIds: new Set([match.grantId]),
          leverageAmount: match.supportAmount.max ?? 0,
          urgency: urgencyForDday(match.dDay),
          effort: "quick",
          baseScore: match.fitScore,
        });
      }

      if (trace.result === "text_only") {
        const key = `review:${trace.dimension}`;
        addAction(actions, key, {
          kind: "review",
          title: `${dimensionLabel(trace.dimension)} 원문 확인`,
          reason: "자동 판정이 어려운 조건입니다. 원문 확인 후 신청 여부를 판단해야 합니다.",
          ctaLabel: "원문 확인",
          target: match.detailUrl ?? match.grantId,
          affectedGrantIds: new Set([match.grantId]),
          leverageAmount: match.supportAmount.max ?? 0,
          urgency: urgencyForDday(match.dDay),
          effort: "medium",
          baseScore: match.fitScore,
        });
      }

      if (trace.result === "fail" && trace.kind === "required") {
        const key = `acquire:${trace.dimension}`;
        addAction(actions, key, {
          kind: "acquire",
          title: `${dimensionLabel(trace.dimension)} 조건 준비`,
          reason: `${match.title} 공고의 잠금 조건입니다.`,
          ctaLabel: "준비 조건 보기",
          target: trace.dimension,
          affectedGrantIds: new Set([match.grantId]),
          leverageAmount: match.supportAmount.max ?? 0,
          urgency: urgencyForDday(match.dDay),
          effort: "long",
          baseScore: match.fitScore,
        });
      }
    }
  }

  return [...actions.entries()]
    .map(([id, action]) => toActionQueueItem(id, action))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function addAction(
  actions: Map<string, ActionAccumulator>,
  key: string,
  next: ActionAccumulator,
) {
  const current = actions.get(key);
  if (!current) {
    actions.set(key, next);
    return;
  }

  for (const grantId of next.affectedGrantIds) current.affectedGrantIds.add(grantId);
  current.leverageAmount += next.leverageAmount;
  current.baseScore = Math.max(current.baseScore, next.baseScore);
  current.urgency = maxUrgency(current.urgency, next.urgency);
}

function toActionQueueItem(id: string, action: ActionAccumulator): ActionQueueItem {
  const effortWeight: Record<ActionQueueItem["effort"], number> = {
    quick: 1,
    medium: 2,
    long: 4,
  };
  const urgencyWeight: Record<ActionQueueItem["urgency"], number> = {
    low: 1,
    medium: 1.4,
    high: 2,
  };
  const leverageScore = Math.max(action.leverageAmount / 1_000_000, action.affectedGrantIds.size);
  const score = Math.round(((leverageScore + action.baseScore) * urgencyWeight[action.urgency]) / effortWeight[action.effort]);

  return {
    id,
    kind: action.kind,
    title: action.title,
    reason: action.reason,
    ctaLabel: action.ctaLabel,
    target: action.target,
    affectedGrantIds: [...action.affectedGrantIds],
    affectedGrantCount: action.affectedGrantIds.size,
    leverageAmount: action.leverageAmount,
    urgency: action.urgency,
    effort: action.effort,
    score,
  };
}

function maxUrgency(
  current: ActionQueueItem["urgency"],
  next: ActionQueueItem["urgency"],
): ActionQueueItem["urgency"] {
  const rank: Record<ActionQueueItem["urgency"], number> = { low: 0, medium: 1, high: 2 };
  return rank[next] > rank[current] ? next : current;
}

function dimensionLabel(dimension: CriterionDimension): string {
  const labels: Record<CriterionDimension, string> = {
    region: "지역",
    biz_age: "업력",
    industry: "업종",
    size: "기업규모",
    revenue: "매출",
    employees: "고용",
    founder_age: "대표자 연령",
    founder_trait: "대표자 속성",
    certification: "인증",
    prior_award: "기수혜",
    ip: "지식재산",
    target_type: "신청대상",
    business_status: "영업상태",
    other: "기타 조건",
  };
  return labels[dimension];
}

function dDayReason(dDay: number | null): string {
  if (dDay === null) return "신청 가능한 공고입니다.";
  if (dDay < 0) return "마감 상태 확인이 필요합니다.";
  if (dDay === 0) return "오늘 마감입니다.";
  return `마감 D-${dDay}`;
}
