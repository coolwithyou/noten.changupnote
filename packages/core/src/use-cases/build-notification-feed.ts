import type {
  MatchCard,
  NotificationFeedResult,
  NotificationItem,
  NotificationPriority,
  RuleTraceChip,
} from "@cunote/contracts";

export interface BuildNotificationFeedOptions {
  matches: MatchCard[];
  asOf?: Date;
  limit?: number;
}

export function buildNotificationFeed({
  matches,
  asOf = new Date(),
  limit = 8,
}: BuildNotificationFeedOptions): NotificationFeedResult {
  const notifications: NotificationItem[] = [];
  const deadlineGrantIds = new Set<string>();

  for (const match of matches) {
    if (match.eligibility !== "eligible" || match.dDay === null || match.dDay < 0 || match.dDay > 7) {
      continue;
    }
    deadlineGrantIds.add(match.grantId);
    notifications.push({
      id: `deadline:${match.grantId}`,
      kind: "deadline",
      title: deadlineTitle(match),
      body: "지원 가능성이 높은 공고입니다. 신청 준비 시트와 제출 서류를 확인하세요.",
      priority: match.dDay <= 3 ? "high" : "medium",
      target: `grant:${match.grantId}`,
      grantId: match.grantId,
      dDay: match.dDay,
      rulesetVer: match.rulesetVer,
    });
  }

  for (const match of matches) {
    if (match.eligibility !== "eligible" || deadlineGrantIds.has(match.grantId)) continue;
    notifications.push({
      id: `new_match:${match.grantId}`,
      kind: "new_match",
      title: `지금 신청 가능한 공고: ${match.title}`,
      body: `자격조건 확인도 ${match.fitScore}%인 공고입니다. 상세 조건과 신청 준비 항목을 확인하세요.`,
      priority: "medium",
      target: `grant:${match.grantId}`,
      grantId: match.grantId,
      dDay: match.dDay,
      rulesetVer: match.rulesetVer,
    });
  }

  for (const match of matches) {
    if (match.bucket === "soon") {
      const unlock = match.ruleTrace.find((trace) => trace.unlock?.kind === "time")?.unlock;
      if (unlock) {
        notifications.push({
          id: `soon_eligible:${match.grantId}`,
          kind: "soon_eligible",
          title: `곧 적격: ${match.title}`,
          body: unlock.detail,
          priority: "medium",
          target: `grant:${match.grantId}`,
          grantId: match.grantId,
          etaDate: unlock.etaDate ?? null,
          rulesetVer: match.rulesetVer,
        });
      }
    }

    const actionable = firstActionableTrace(match.ruleTrace);
    if (match.eligibility === "conditional" && actionable) {
      notifications.push({
        id: `needs_input:${actionable.dimension}`,
        kind: "needs_input",
        title: `${actionable.label} 확인 필요`,
        body: `${match.title} 포함 조건부 공고를 확정하거나 제외하는 데 필요합니다.`,
        priority: "low",
        target: `profile:${actionable.dimension}`,
        grantId: match.grantId,
        rulesetVer: match.rulesetVer,
      });
    }
  }

  return {
    generatedAt: asOf.toISOString(),
    notifications: dedupeNotifications(notifications)
      .sort(compareNotifications)
      .slice(0, limit),
  };
}

function firstActionableTrace(traces: RuleTraceChip[]): RuleTraceChip | undefined {
  return traces.find((trace) => trace.result === "unknown" || trace.result === "text_only");
}

function dedupeNotifications(notifications: NotificationItem[]): NotificationItem[] {
  const byId = new Map<string, NotificationItem>();
  for (const notification of notifications) {
    const current = byId.get(notification.id);
    if (!current || compareNotifications(notification, current) < 0) {
      byId.set(notification.id, notification);
    }
  }
  return [...byId.values()];
}

function compareNotifications(left: NotificationItem, right: NotificationItem): number {
  const priorityDelta = priorityRank(right.priority) - priorityRank(left.priority);
  if (priorityDelta !== 0) return priorityDelta;

  const dDayDelta = dDayRank(left.dDay) - dDayRank(right.dDay);
  if (dDayDelta !== 0) return dDayDelta;

  return left.title.localeCompare(right.title, "ko");
}

function priorityRank(priority: NotificationPriority): number {
  return { low: 1, medium: 2, high: 3 }[priority];
}

function dDayRank(dDay: number | null | undefined): number {
  return typeof dDay === "number" && dDay >= 0 ? dDay : Number.POSITIVE_INFINITY;
}

function deadlineTitle(match: MatchCard): string {
  if (match.dDay === 0) return `오늘 마감: ${match.title}`;
  return `마감 D-${match.dDay}: ${match.title}`;
}
