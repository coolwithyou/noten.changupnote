/**
 * 공고 요약 화면의 "문서 열기" 재개 CTA 근거(디자인 2라운드 03 장면 F).
 *
 * 회사·공고별로 서버에 남아 있는 문서 저장본 수와 마지막 서버 저장 시각만 구한다.
 *   - 저장본 = 폐기(archived)되지 않은 초안 행. 같은 documentKey 는 최신 행 1건만 센다
 *     (`listGrantDocumentDraftsForGrant` 의 uniqueLatest 규칙과 같다). 최신 행이 archived 면
 *     그 문서는 폐기된 것으로 보고 과거 행으로 되살리지 않는다.
 *   - 마지막 서버 저장 = 초안 행 갱신 시각(필드 답변·본문 저장)과 문서 revision head
 *     (Studio 저장본) 시각 중 늦은 쪽.
 * 이 모듈은 DB 에 닿지 않는 순수 타입·포맷 함수만 둔다(클라이언트 번들 안전). 조회는 `lib/server/documents/draftResume.ts`.
 */
export interface DraftResumeSummary {
  savedCount: number;
  lastSavedAt: Date;
}

export interface DraftResumeRow {
  documentKey: string;
  status: string;
  updatedAt: Date;
  headSavedAt: Date | null;
}

const DISCARDED_DRAFT_STATUSES: ReadonlySet<string> = new Set(["archived"]);

/** 초안 행 목록을 저장본 수·마지막 저장 시각으로 접는다(순수 함수, 입력 순서 무관). */
export function summarizeDraftResume(rows: readonly DraftResumeRow[]): DraftResumeSummary | null {
  const ordered = [...rows].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  const seen = new Set<string>();
  let savedCount = 0;
  let lastSavedAt: Date | null = null;
  for (const row of ordered) {
    if (seen.has(row.documentKey)) continue;
    seen.add(row.documentKey);
    if (DISCARDED_DRAFT_STATUSES.has(row.status)) continue;
    savedCount += 1;
    for (const candidate of [row.updatedAt, row.headSavedAt]) {
      if (!candidate) continue;
      if (!lastSavedAt || candidate.getTime() > lastSavedAt.getTime()) lastSavedAt = candidate;
    }
  }
  if (savedCount === 0 || !lastSavedAt) return null;
  return { savedCount, lastSavedAt };
}

/** "저장본 N · 마지막 서버 저장 M월 D일 HH:mm · 같은 문서와 작성 상태로 돌아가요" (Asia/Seoul). */
export function formatDraftResumeCaption(input: {
  savedCount: number;
  lastSavedAt: Date;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  return [
    `저장본 ${input.savedCount.toLocaleString("ko-KR")}`,
    `마지막 서버 저장 ${formatDraftSavedAt(input.lastSavedAt, now)}`,
    "같은 문서와 작성 상태로 돌아가요",
  ].join(" · ");
}

/**
 * 서울 기준 저장 시각. 디자인 장면 F 의 "오늘 18:06" 처럼 같은 날이면 "오늘 HH:mm",
 * 다른 날이면 "M월 D일 HH:mm", 해가 다르면 "YYYY년 M월 D일 HH:mm".
 */
export function formatDraftSavedAt(value: Date, now: Date): string {
  const saved = seoulParts(value);
  const today = seoulParts(now);
  const time = `${saved.hour}:${saved.minute}`;
  if (saved.year === today.year && saved.month === today.month && saved.day === today.day) {
    return `오늘 ${time}`;
  }
  const monthDay = `${Number(saved.month)}월 ${Number(saved.day)}일 ${time}`;
  return saved.year === today.year ? monthDay : `${saved.year}년 ${monthDay}`;
}

function seoulParts(value: Date): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute") };
}
