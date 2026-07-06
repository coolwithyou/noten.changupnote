/**
 * 지식 관리 대시보드 집계 계층 (읽기 전용 뷰 모델).
 *
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §8(성숙도 지표)·§7 Step 2.
 * lessonInboxData 선례를 따른다: 저장 로직(knowledgeRepo)이 단일 원천이고, 여기서는 그 결과를
 *   대시보드 화면·GET API 가 함께 쓰는 JSON-safe 뷰 모델로 조립만 한다.
 *   - Date 컬럼(createdAt/reviewBy 등)은 ISO 문자열로 직렬화한다.
 *   - 규모(수십~수백)를 감안해 전량 로드 후 JS 집계를 택했다(단순·검증 용이). 성장 시 SQL 집계로 이관.
 *   - 무거운 extraction.ts(pdfjs 포함)를 import 하지 않는다: summarize 는 로컬 사본을 둔다.
 */
import {
  KNOWLEDGE_SOURCE_KINDS,
  LESSON_STATUSES,
  countLessonsBySource,
  listKnowledgeSources,
  listLessons,
  type EvidenceTier,
  type KnowledgeSourceKind,
  type KnowledgeSourceRow,
  type KnowledgeSourceStatus,
  type LessonScope,
  type LessonStatus,
  type LessonStatusCounts,
  type LessonTarget,
} from "./knowledgeRepo";

// ── DTO ────────────────────────────────────────────────────
export interface KnowledgeDashboardTotals {
  /** lesson status 별 카운트(전 상태). */
  lessons: Record<LessonStatus, number>;
  /** 원천 문서 수(전체 + kind 별). */
  sources: { total: number; byKind: Record<KnowledgeSourceKind, number> };
  /** 비-lesson 항목 수(전체 + kind 별: faq_candidate | exemplar | product_feedback ...). */
  nonLessonItems: { total: number; byKind: Record<string, number> };
}

export interface KnowledgeDistributionBucket {
  key: string;
  count: number;
}

export interface KnowledgeDashboardDistributions {
  /** approved+proposed lesson 의 target 별 분포. */
  byTarget: KnowledgeDistributionBucket[];
  /** approved+proposed lesson 의 evidenceTier 별 분포. */
  byEvidenceTier: KnowledgeDistributionBucket[];
  /** approved+proposed lesson 의 scope.program 별 분포(없으면 "(미지정)"). */
  byProgram: KnowledgeDistributionBucket[];
}

export interface WeeklyAccumulationPoint {
  /** ISO 주(월요일) 시작일 YYYY-MM-DD. */
  weekStart: string;
  /** 해당 주 lesson 생성 수. */
  created: number;
  /** 창 시작 이전 누적을 포함한 누적 합계. */
  cumulative: number;
}

export interface ReviewDueLesson {
  id: string;
  /** 지침 요약(120자). */
  instruction: string;
  scope: LessonScope;
  reviewBy: string;
  evidenceTier: EvidenceTier;
}

export interface KnowledgeSourceSummary {
  id: string;
  title: string;
  kind: KnowledgeSourceKind;
  status: KnowledgeSourceStatus;
  sourceDate: string;
  uploadedBy: string;
  createdAt: string;
  lessonCounts: LessonStatusCounts;
  nonLessonItemCount: number;
}

export interface DashboardNonLessonItem {
  sourceId: string;
  sourceTitle: string;
  kind: string;
  content: string;
  quote: string;
  page: number | null;
}

export interface KnowledgeDashboardData {
  generatedAt: string;
  totals: KnowledgeDashboardTotals;
  distributions: KnowledgeDashboardDistributions;
  weeklyAccumulation: WeeklyAccumulationPoint[];
  reviewDue: ReviewDueLesson[];
  sources: KnowledgeSourceSummary[];
  nonLessonItems: DashboardNonLessonItem[];
}

/** 원천 문서 행의 JSON-safe DTO(sources API 응답 공용). 내부 R2 키는 노출하지 않는다. */
export interface KnowledgeSourceDto {
  id: string;
  kind: KnowledgeSourceKind;
  title: string;
  sha256: string;
  status: KnowledgeSourceStatus;
  programHint: string | null;
  institutionHint: string | null;
  sourceDate: string;
  uploadedBy: string;
  extractionModel: string | null;
  extractionPromptVer: string | null;
  nonLessonItemCount: number;
  createdAt: string;
  updatedAt: string;
}

const REVIEW_DUE_HORIZON_DAYS = 90;
const WEEKLY_WINDOW = 12;

const toIso = (value: Date | null | undefined): string =>
  value ? new Date(value).toISOString() : new Date(0).toISOString();

/** 원천 문서 행을 JSON-safe DTO 로 직렬화(sources API 응답용). */
export function serializeKnowledgeSource(row: KnowledgeSourceRow): KnowledgeSourceDto {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    sha256: row.sha256,
    status: row.status,
    programHint: row.programHint,
    institutionHint: row.institutionHint,
    sourceDate: row.sourceDate,
    uploadedBy: row.uploadedBy,
    extractionModel: row.extractionModel,
    extractionPromptVer: row.extractionPromptVer,
    nonLessonItemCount: Array.isArray(row.nonLessonItems) ? row.nonLessonItems.length : 0,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

/**
 * 대시보드에 필요한 전부를 한 번에 조립해 JSON-safe 로 반환한다.
 * - totals: lesson status 별·원천 kind 별·비-lesson kind 별 카운트.
 * - distributions: approved+proposed lesson 의 target/evidenceTier/program 분포.
 * - weeklyAccumulation: 최근 12주 주별 lesson 생성 수 + 누적.
 * - reviewDue: approved lesson 중 reviewBy 가 오늘~90일 내(재검토 큐 씨앗).
 * - sources: 원천 목록 + lesson status 집계 + 비-lesson 수.
 * - nonLessonItems: 전 원천 평탄화.
 */
export async function buildKnowledgeDashboardData(): Promise<KnowledgeDashboardData> {
  const now = new Date();
  const [allLessons, sourceRows] = await Promise.all([listLessons({}), listKnowledgeSources()]);

  // ── totals.lessons ──
  const lessonCounts = Object.fromEntries(LESSON_STATUSES.map((s) => [s, 0])) as Record<LessonStatus, number>;
  for (const lesson of allLessons) lessonCounts[lesson.status] += 1;

  // ── totals.sources ──
  const sourcesByKind = Object.fromEntries(
    KNOWLEDGE_SOURCE_KINDS.map((k) => [k, 0]),
  ) as Record<KnowledgeSourceKind, number>;
  for (const source of sourceRows) sourcesByKind[source.kind] += 1;

  // ── nonLessonItems 평탄화 + kind 별 카운트 ──
  const nonLessonItems: DashboardNonLessonItem[] = [];
  const nonLessonByKind: Record<string, number> = {};
  for (const source of sourceRows) {
    const items = Array.isArray(source.nonLessonItems) ? source.nonLessonItems : [];
    for (const item of items) {
      nonLessonItems.push({
        sourceId: source.id,
        sourceTitle: source.title,
        kind: item.kind,
        content: item.content,
        quote: item.quote,
        page: item.page,
      });
      nonLessonByKind[item.kind] = (nonLessonByKind[item.kind] ?? 0) + 1;
    }
  }

  // ── distributions (approved+proposed lesson 만) ──
  const activeLessons = allLessons.filter((l) => l.status === "approved" || l.status === "proposed");
  const byTarget = tally<LessonTarget>(activeLessons.map((l) => l.target));
  const byEvidenceTier = tally<EvidenceTier>(activeLessons.map((l) => l.evidenceTier));
  const byProgram = tally(
    activeLessons.map((l) => {
      const scope = (l.scope ?? {}) as LessonScope;
      const program = typeof scope.program === "string" ? scope.program.trim() : "";
      return program.length > 0 ? program : "(미지정)";
    }),
  );

  // ── weeklyAccumulation ──
  const weeklyAccumulation = buildWeeklyAccumulation(
    allLessons.map((l) => l.createdAt),
    now,
    WEEKLY_WINDOW,
  );

  // ── reviewDue (approved & reviewBy in [today, today+90d]) ──
  const todayStart = startOfUtcDay(now);
  const horizon = new Date(todayStart);
  horizon.setUTCDate(horizon.getUTCDate() + REVIEW_DUE_HORIZON_DAYS);
  const reviewDue: ReviewDueLesson[] = allLessons
    .filter((l): l is typeof l & { reviewBy: Date } => {
      if (l.status !== "approved" || !l.reviewBy) return false;
      const d = new Date(l.reviewBy);
      return d >= todayStart && d <= horizon;
    })
    .sort((a, b) => new Date(a.reviewBy).getTime() - new Date(b.reviewBy).getTime())
    .map((l) => ({
      id: l.id,
      instruction: summarize(l.instruction, 120),
      scope: (l.scope ?? {}) as LessonScope,
      reviewBy: new Date(l.reviewBy).toISOString(),
      evidenceTier: l.evidenceTier,
    }));

  // ── sources (문서별 lesson 집계) ──
  const sources: KnowledgeSourceSummary[] = await Promise.all(
    sourceRows.map(async (source) => ({
      id: source.id,
      title: source.title,
      kind: source.kind,
      status: source.status,
      sourceDate: source.sourceDate,
      uploadedBy: source.uploadedBy,
      createdAt: toIso(source.createdAt),
      lessonCounts: await countLessonsBySource(source.id),
      nonLessonItemCount: Array.isArray(source.nonLessonItems) ? source.nonLessonItems.length : 0,
    })),
  );

  return {
    generatedAt: now.toISOString(),
    totals: {
      lessons: lessonCounts,
      sources: { total: sourceRows.length, byKind: sourcesByKind },
      nonLessonItems: { total: nonLessonItems.length, byKind: nonLessonByKind },
    },
    distributions: { byTarget, byEvidenceTier, byProgram },
    weeklyAccumulation,
    reviewDue,
    sources,
    nonLessonItems,
  };
}

// ── 내부 헬퍼 ───────────────────────────────────────────────
/** 값 배열을 key 별 카운트로 집계(내림차순 count, 동률은 key 오름차순). */
function tally<T extends string>(values: T[]): KnowledgeDistributionBucket[] {
  const map = new Map<string, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** UTC 자정으로 절삭. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** ISO 주(월요일) 시작(UTC 자정). */
function startOfIsoWeek(d: Date): Date {
  const x = startOfUtcDay(d);
  const day = x.getUTCDay(); // 0=일 .. 6=토
  const shift = day === 0 ? -6 : 1 - day; // 월요일로 이동
  x.setUTCDate(x.getUTCDate() + shift);
  return x;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 최근 `weeks` 주(현재 주 포함) 주별 생성 수 + 누적. 누적은 창 시작 이전 생성분을 시드로 포함한다
 * (진짜 누적). 창 이후(미래)는 무시. weekStart 는 ISO 월요일.
 */
function buildWeeklyAccumulation(
  createdDates: Array<Date | null | undefined>,
  now: Date,
  weeks: number,
): WeeklyAccumulationPoint[] {
  const thisWeekStart = startOfIsoWeek(now);
  const windowStart = new Date(thisWeekStart);
  windowStart.setUTCDate(windowStart.getUTCDate() - 7 * (weeks - 1));

  const buckets: Array<{ start: Date; created: number }> = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(windowStart);
    start.setUTCDate(start.getUTCDate() + 7 * i);
    buckets.push({ start, created: 0 });
  }

  let prior = 0; // 창 시작 이전 생성분(누적 시드).
  for (const raw of createdDates) {
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    if (d < windowStart) {
      prior += 1;
      continue;
    }
    const idx = Math.floor((startOfIsoWeek(d).getTime() - windowStart.getTime()) / WEEK_MS);
    const bucket = buckets[idx];
    if (bucket) bucket.created += 1; // 창 이후(미래)는 무시.
  }

  let cumulative = prior;
  return buckets.map((b) => {
    cumulative += b.created;
    return { weekStart: b.start.toISOString().slice(0, 10), created: b.created, cumulative };
  });
}

/** 문자열을 공백 정규화 후 n자로 자르고 말줄임표(extraction.ts 사본 — pdfjs 의존 회피). */
function summarize(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
