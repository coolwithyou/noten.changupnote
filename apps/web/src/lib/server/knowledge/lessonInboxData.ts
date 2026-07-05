/**
 * lesson 인박스 데이터 조립 계층 (읽기 전용 뷰 모델).
 *
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §6(큐레이션)·§7 Step 2.
 * 저장 로직은 knowledgeRepo(listLessons / listKnowledgeSources)가 단일 원천이며,
 * 여기서는 그 결과를 인박스 화면·API가 함께 쓰는 직렬화 뷰 모델(JSON-safe)로 변환만 한다.
 *   - Date 컬럼(reviewBy/validFrom/curatedAt/createdAt/updatedAt)은 ISO 문자열로 직렬화해
 *     서버 컴포넌트 초기 props 와 GET API 재페치 응답의 형태를 일치시킨다.
 *   - counts 는 요청 필터(sourceId)를 존중하되 status 와 무관하게 전 상태를 집계한다(탭 배지용).
 */
import {
  LESSON_STATUSES,
  listKnowledgeSources,
  listLessons,
  type EvidenceTier,
  type KnowledgeSourceKind,
  type LessonScope,
  type LessonSourceKind,
  type LessonSourceRef,
  type LessonStatus,
  type LessonTarget,
  type ReviewLessonRow,
} from "./knowledgeRepo";

export interface LessonSourceMetaDto {
  id: string;
  title: string;
  kind: KnowledgeSourceKind;
  sourceDate: string;
}

/** 클라이언트로 전달되는 JSON-safe lesson 뷰(Date → ISO 문자열). */
export interface LessonInboxItemDto {
  id: string;
  target: LessonTarget;
  scope: LessonScope;
  instruction: string;
  rationale: string;
  sourceKind: LessonSourceKind;
  evidenceTier: EvidenceTier;
  sourceRefs: LessonSourceRef[];
  sourceId: string | null;
  goldenCaseRef: string | null;
  programRound: string | null;
  status: LessonStatus;
  reviewBy: string | null;
  validFrom: string;
  curatedBy: string | null;
  curatedAt: string | null;
  curationNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LessonInboxDto {
  status: LessonStatus;
  sourceId: string | null;
  lessons: LessonInboxItemDto[];
  sources: Record<string, LessonSourceMetaDto>;
  counts: Record<LessonStatus, number>;
}

const toIso = (value: Date | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

export function isLessonStatus(value: string | null | undefined): value is LessonStatus {
  return typeof value === "string" && (LESSON_STATUSES as readonly string[]).includes(value);
}

export function serializeLesson(row: ReviewLessonRow): LessonInboxItemDto {
  return {
    id: row.id,
    target: row.target,
    scope: (row.scope ?? {}) as LessonScope,
    instruction: row.instruction,
    rationale: row.rationale,
    sourceKind: row.sourceKind,
    evidenceTier: row.evidenceTier,
    sourceRefs: Array.isArray(row.sourceRefs) ? (row.sourceRefs as LessonSourceRef[]) : [],
    sourceId: row.sourceId,
    goldenCaseRef: row.goldenCaseRef,
    programRound: row.programRound,
    status: row.status,
    reviewBy: toIso(row.reviewBy),
    validFrom: toIso(row.validFrom) ?? new Date(0).toISOString(),
    curatedBy: row.curatedBy,
    curatedAt: toIso(row.curatedAt),
    curationNote: row.curationNote,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

/**
 * 인박스 화면·GET API 공용 데이터 조립.
 * sourceId 필터는 전 상태 집계(counts)에도 적용하고, status 필터는 반환 목록에만 적용한다.
 */
export async function getLessonInboxData(filter: {
  status?: LessonStatus | undefined;
  sourceId?: string | undefined;
}): Promise<LessonInboxDto> {
  const status = filter.status ?? "proposed";
  const all = await listLessons(filter.sourceId ? { sourceId: filter.sourceId } : {});

  const counts = Object.fromEntries(
    LESSON_STATUSES.map((s) => [s, 0]),
  ) as Record<LessonStatus, number>;
  for (const lesson of all) counts[lesson.status] += 1;

  const filtered = all.filter((lesson) => lesson.status === status);

  const sourceRows = await listKnowledgeSources();
  const sources: Record<string, LessonSourceMetaDto> = {};
  for (const source of sourceRows) {
    sources[source.id] = {
      id: source.id,
      title: source.title,
      kind: source.kind,
      sourceDate: source.sourceDate,
    };
  }

  return {
    status,
    sourceId: filter.sourceId ?? null,
    lessons: filtered.map(serializeLesson),
    sources,
    counts,
  };
}
