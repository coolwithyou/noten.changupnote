export type GrantInsightSeverity = "info" | "warn" | "critical";

export interface GrantInsightGrantRow {
  source: string;
  status: string;
  categoryL1: string | null;
  agencyJurisdiction: string | null;
  applyStart: Date | null;
  applyEnd: Date | null;
  fRegions: string[];
  overallConfidence: number;
  updatedAt: Date;
}

export interface GrantInsightCriterionRow {
  dimension: string;
  operator: string;
  kind: string;
  confidence: number;
  needsReview: boolean;
}

export interface GrantInsightCursorRow {
  source: string;
  lastPage: number | null;
  lastCollectedAt: Date | null;
}

export interface GrantInsightActivityCounts {
  dedupLinks: number;
  extractionLog: number;
  feedback: number;
  matchEvents: number;
  goldenSet: number;
  evalRuns: number;
}

export interface GrantInsightSnapshotInput {
  asOf: Date;
  staleCursorHours?: number;
  grants: GrantInsightGrantRow[];
  criteria: GrantInsightCriterionRow[];
  cursors: GrantInsightCursorRow[];
  activity: GrantInsightActivityCounts;
}

export interface GrantInsightItem {
  code: string;
  severity: GrantInsightSeverity;
  title: string;
  detail: string;
  metric?: string;
  value?: number;
}

export interface GrantInsightSnapshotData {
  kind: "grant_archive";
  generatedAt: string;
  windowStart: string | null;
  windowEnd: string;
  metrics: Record<string, number>;
  dimensions: Record<string, unknown>;
  insights: GrantInsightItem[];
}

export function buildGrantInsightSnapshot(input: GrantInsightSnapshotInput): GrantInsightSnapshotData {
  const staleCursorHours = input.staleCursorHours ?? 48;
  const statusCounts = countBy(input.grants, (row) => row.status);
  const sourceCounts = countBy(input.grants, (row) => row.source);
  const categoryCounts = countBy(input.grants, (row) => row.categoryL1 ?? "unknown");
  const agencyCounts = countBy(input.grants, (row) => row.agencyJurisdiction ?? "unknown");
  const regionCounts = countMany(input.grants, (row) => row.fRegions.length > 0 ? row.fRegions : ["nationwide"]);
  const dimensionCounts = countBy(input.criteria, (row) => row.dimension);
  const reviewDimensionCounts = countBy(
    input.criteria.filter((row) => row.needsReview),
    (row) => row.dimension,
  );
  const staleCursors = input.cursors.filter((row) =>
    !row.lastCollectedAt || hoursBetween(row.lastCollectedAt, input.asOf) > staleCursorHours
  );

  const openGrants = statusCounts.get("open") ?? 0;
  const upcomingGrants = statusCounts.get("upcoming") ?? 0;
  const unknownStatusGrants = statusCounts.get("unknown") ?? 0;
  const activeGrants = openGrants + upcomingGrants + unknownStatusGrants;
  const textOnlyCriteria = input.criteria.filter((row) => row.operator === "text_only").length;
  const needsReviewCriteria = input.criteria.filter((row) => row.needsReview).length;
  const lowConfidenceCriteria = input.criteria.filter((row) => row.confidence < 0.7).length;
  const criteriaCount = input.criteria.length;

  const metrics: Record<string, number> = {
    totalGrants: input.grants.length,
    activeGrants,
    openGrants,
    upcomingGrants,
    closedGrants: statusCounts.get("closed") ?? 0,
    unknownStatusGrants,
    sourceCount: sourceCounts.size,
    criteriaCount,
    avgCriteriaPerGrant: ratio(criteriaCount, input.grants.length),
    textOnlyCriteria,
    textOnlyRatio: ratio(textOnlyCriteria, criteriaCount),
    needsReviewCriteria,
    needsReviewRatio: ratio(needsReviewCriteria, criteriaCount),
    lowConfidenceCriteria,
    lowConfidenceRatio: ratio(lowConfidenceCriteria, criteriaCount),
    dedupLinkCount: input.activity.dedupLinks,
    extractionLogCount: input.activity.extractionLog,
    feedbackCount: input.activity.feedback,
    matchEventCount: input.activity.matchEvents,
    goldenSetCount: input.activity.goldenSet,
    evalRunCount: input.activity.evalRuns,
    staleCursorCount: staleCursors.length,
  };

  return {
    kind: "grant_archive",
    generatedAt: input.asOf.toISOString(),
    windowStart: oldestCursor(input.cursors),
    windowEnd: input.asOf.toISOString(),
    metrics,
    dimensions: {
      sources: topCounts(sourceCounts, 10),
      statuses: topCounts(statusCounts, 10),
      categories: topCounts(categoryCounts, 12),
      agencies: topCounts(agencyCounts, 12),
      regions: topCounts(regionCounts, 12),
      criteriaDimensions: topCounts(dimensionCounts, 20),
      reviewQueueDimensions: topCounts(reviewDimensionCounts, 20),
      cursors: input.cursors.map((row) => ({
        source: row.source,
        lastPage: row.lastPage,
        lastCollectedAt: row.lastCollectedAt?.toISOString() ?? null,
        ageHours: row.lastCollectedAt ? round(hoursBetween(row.lastCollectedAt, input.asOf)) : null,
      })),
    },
    insights: buildInsights(metrics, staleCursorHours),
  };
}

function buildInsights(metrics: Record<string, number>, staleCursorHours: number): GrantInsightItem[] {
  const insights: GrantInsightItem[] = [];
  const totalGrants = metric(metrics, "totalGrants");
  const activeGrants = metric(metrics, "activeGrants");
  const sourceCount = metric(metrics, "sourceCount");
  const needsReviewRatio = metric(metrics, "needsReviewRatio");
  const textOnlyRatio = metric(metrics, "textOnlyRatio");
  const dedupLinkCount = metric(metrics, "dedupLinkCount");
  const goldenSetCount = metric(metrics, "goldenSetCount");
  const evalRunCount = metric(metrics, "evalRunCount");
  const staleCursorCount = metric(metrics, "staleCursorCount");

  if (totalGrants === 0) {
    insights.push({
      code: "empty_archive",
      severity: "critical",
      title: "아카이브된 지원사업이 없습니다.",
      detail: "K-Startup 또는 기업마당 수집 배치를 먼저 실행해야 매칭과 인사이트를 만들 수 있습니다.",
      metric: "totalGrants",
      value: totalGrants,
    });
    return insights;
  }

  if (sourceCount < 2) {
    insights.push({
      code: "single_source_coverage",
      severity: "warn",
      title: "지원사업 소스가 한 축에 치우쳐 있습니다.",
      detail: "MVP 커버리지는 K-Startup과 기업마당을 함께 봐야 중복과 누락을 판단할 수 있습니다.",
      metric: "sourceCount",
      value: sourceCount,
    });
  }

  if (needsReviewRatio >= 0.25) {
    insights.push({
      code: "review_queue_heavy",
      severity: "warn",
      title: "검수 대기 criteria 비율이 높습니다.",
      detail: "needs_review 항목이 많으면 자동 적격 판정이 conditional로 밀릴 가능성이 큽니다.",
      metric: "needsReviewRatio",
      value: needsReviewRatio,
    });
  }

  if (textOnlyRatio >= 0.25) {
    insights.push({
      code: "text_only_heavy",
      severity: "warn",
      title: "자동 판정 불가 조건 비율이 높습니다.",
      detail: "text_only 조건은 source_span을 보존하되 골든셋과 추출 보강의 우선순위로 보내야 합니다.",
      metric: "textOnlyRatio",
      value: textOnlyRatio,
    });
  }

  if (dedupLinkCount === 0 && sourceCount >= 2) {
    insights.push({
      code: "dedup_not_confirmed",
      severity: "warn",
      title: "복수 소스 중복 링크가 아직 없습니다.",
      detail: "K-Startup과 기업마당이 함께 들어오면 dedup 후보를 발행해 중복 추천을 줄여야 합니다.",
      metric: "dedupLinkCount",
      value: dedupLinkCount,
    });
  }

  if (goldenSetCount === 0 || evalRunCount === 0) {
    const missingMetric = goldenSetCount === 0 ? "goldenSetCount" : "evalRunCount";
    insights.push({
      code: "quality_loop_empty",
      severity: "warn",
      title: "정확도 평가 루프가 아직 비어 있습니다.",
      detail: "골든셋과 eval run이 없으면 정규화/매칭 개선이 실제 정확도를 높였는지 검증하기 어렵습니다.",
      metric: missingMetric,
      value: metric(metrics, missingMetric),
    });
  }

  if (staleCursorCount > 0) {
    insights.push({
      code: "stale_source_cursor",
      severity: "warn",
      title: "오래된 수집 cursor가 있습니다.",
      detail: `${staleCursorHours}시간 넘게 갱신되지 않은 소스는 마감/신규 공고 신선도 점검이 필요합니다.`,
      metric: "staleCursorCount",
      value: staleCursorCount,
    });
  }

  insights.push({
    code: "active_archive_size",
    severity: "info",
    title: "현재 활성 지원사업 풀",
    detail: `open/upcoming/unknown 상태 공고 ${activeGrants.toLocaleString("ko-KR")}건을 매칭 후보로 볼 수 있습니다.`,
    metric: "activeGrants",
    value: activeGrants,
  });

  return insights;
}

function metric(metrics: Record<string, number>, key: string): number {
  return metrics[key] ?? 0;
}

function countBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countMany<T>(rows: T[], keysOf: (row: T) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of keysOf(row)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function topCounts(counts: Map<string, number>, limit: number): Array<{ key: string; count: number }> {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function hoursBetween(left: Date, right: Date): number {
  return (right.getTime() - left.getTime()) / 3_600_000;
}

function oldestCursor(cursors: GrantInsightCursorRow[]): string | null {
  const dates = cursors
    .map((row) => row.lastCollectedAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  return dates[0]?.toISOString() ?? null;
}
