import type { Grant, MatchResult } from "@cunote/contracts";

export interface PriorityResult {
  score: number | null;
  reasons: string[];
}

/** 선정 가능성과 무관한 실행 우선순위 v1. */
export function calculatePriority(
  grant: Grant,
  match: MatchResult,
  options: { asOf?: Date } = {},
): PriorityResult {
  const asOf = options.asOf ?? new Date();
  const dDay = daysUntilDate(grant.apply_end ?? null, asOf);
  if (grant.status === "closed" || (dDay !== null && dDay < 0)) {
    return { score: 0, reasons: ["접수가 종료된 공고예요."] };
  }

  const amount = supportAmountMax(grant.support_amount);
  const hasBenefit = amount > 0 || (grant.benefits?.length ?? 0) > 0;
  const documentCount = grant.required_documents?.filter((document) => document.required !== false).length ?? 0;
  const hardTraces = match.rule_trace.filter((trace) => trace.kind === "required" || trace.kind === "exclusion");
  const unknownCount = hardTraces.filter((trace) => trace.result === "unknown").length;

  const deadlineScore = deadlineComponent(dDay);
  const benefitScore = amount > 0 ? 100 : hasBenefit ? 70 : 30;
  const preparationScore = documentCount === 0 ? 50 : documentCount <= 2 ? 90 : documentCount <= 5 ? 70 : documentCount <= 8 ? 45 : 20;
  const certaintyScore = hardTraces.length === 0 ? 20 : Math.round((1 - unknownCount / hardTraces.length) * 100);
  const score = Math.round(
    deadlineScore * 0.35 + benefitScore * 0.25 + preparationScore * 0.15 + certaintyScore * 0.25,
  );
  const reasons: string[] = [];
  if (dDay !== null && dDay <= 14) reasons.push(`마감 ${dDay === 0 ? "오늘" : `D-${dDay}`}`);
  if (amount > 0) reasons.push(`지원금 최대 ${formatWon(amount)}`);
  else if (hasBenefit) reasons.push("지원 혜택이 구조화되어 있어요.");
  if (documentCount > 0 && documentCount <= 2) reasons.push(`필수 준비서류 ${documentCount}건`);
  if (unknownCount > 0) reasons.push(`추가 확인 조건 ${unknownCount}건`);
  if (reasons.length === 0) reasons.push("마감·혜택·준비 부담을 기준으로 정렬했어요.");
  return { score, reasons: reasons.slice(0, 3) };
}

function deadlineComponent(dDay: number | null): number {
  if (dDay === null) return 30;
  if (dDay <= 3) return 100;
  if (dDay <= 7) return 90;
  if (dDay <= 14) return 75;
  if (dDay <= 30) return 55;
  if (dDay <= 60) return 35;
  return 20;
}

function daysUntilDate(value: string | null, asOf: Date): number | null {
  if (!value) return null;
  const target = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

function supportAmountMax(value: Grant["support_amount"]): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  for (const key of ["max", "max_krw", "amount", "value"]) {
    if (typeof record[key] === "number" && Number.isFinite(record[key])) return Math.max(0, record[key]);
  }
  return 0;
}

function formatWon(value: number): string {
  if (value >= 100_000_000) return `${Math.round(value / 100_000_000)}억원`;
  if (value >= 10_000) return `${Math.round(value / 10_000).toLocaleString("ko-KR")}만원`;
  return `${value.toLocaleString("ko-KR")}원`;
}
