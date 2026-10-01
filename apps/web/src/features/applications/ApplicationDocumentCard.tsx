"use client";

import { Fragment, type CSSProperties, type ReactNode } from "react";
import {
  Archive,
  BellRing,
  CalendarDays,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Mail,
  MoreHorizontal,
  Save,
  Send,
} from "lucide-react";
import type { FeedbackKind } from "@cunote/contracts";
import type {
  ApplicationPipelineItem,
  ApplicationStage,
  ApplicationWritingStatus,
} from "@/lib/server/applications/pipeline";
import { URGENT_MAX_DDAY } from "@/components/app/notice-card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConversionPollTrigger } from "@/features/apply-sheet/ConversionPollTrigger";
import { koreaDateParts } from "@/lib/calendar/dates";
import { cn } from "@/lib/utils";

export type EditorMode = "management" | "result";

/**
 * 디자인 02 `.sl` 카드의 열 정의. 데스크톱(lg)은 제목 · 3열 · 버튼의 한 행, md는 제목+버튼 행 아래 3열
 * (디자인 ≤1100px 규칙), 그 아래는 세로 스택(02M). 콤마가 든 arbitrary 클래스는 dev(Turbopack)에서
 * 생성되지 않으므로 값은 CSS 변수로 두고 클래스는 `[var(--x)]`로만 참조한다. 목록 컨테이너의 style에 건다.
 */
export const DOCUMENT_CARD_COLUMNS = {
  "--sl-cols-md": "minmax(0,1fr) auto",
  "--sl-cols-lg": "minmax(0,1fr) auto",
} as CSSProperties;

/** 디자인 `.btn-mint` — 기본 변형의 그라디언트·그림자를 걷어내고 민트 잉크 토큰만 남긴다(hex 없음). */
const MINT_BUTTON_CLASS = "[--grad-cta:none] bg-brand-mint-ink shadow-none hover:bg-brand-mint-ink hover:opacity-90";

export function ApplicationDocumentCard({
  item,
  now,
  pending,
  onEdit,
  onMove,
}: {
  item: ApplicationPipelineItem;
  /** 서버 생성 시각(ISO). "오늘" 판정을 SSR·hydration에서 같은 기준으로 하기 위해 쓴다. */
  now: string;
  pending: boolean;
  onEdit: (mode: EditorMode) => void;
  onMove: (item: ApplicationPipelineItem, kind: FeedbackKind, stage: ApplicationStage) => Promise<boolean>;
}) {
  const writing = item.writing ?? null;
  const closed = writing?.completion.closed ?? false;
  const saved = writing ? hasSavedWork(item, writing) : item.draftCount > 0;
  const primary = primaryAction(item);
  const titleHref = primary.kind === "link" ? primary.href : item.detailHref;
  // 마감은 제목 위 뱃지로 표기하므로 메타 줄의 D-day 표기는 접수 중일 때만 남긴다.
  const deadlineLabel = !closed && isActiveStage(item.stage) ? formatDday(item.dDay) : null;
  const statusLine = isActiveStage(item.stage) ? null : applicationStatusLine(item);
  const showsPrepRequest = !closed && !saved && isActiveStage(item.stage)
    && writing?.capability.originalEdit === true && writing.capability.autofill === null;
  const showsClosedCaption = closed && saved;

  return (
    <Card
      className={cn(
        "gap-0 rounded-2xl border border-border-card bg-card py-0 shadow-[var(--shadow-notice)] ring-0 transition-colors hover:border-border-card-hover",

      )}
      data-closed={closed ? "true" : undefined}
    >
      <article
        className="grid grid-cols-1 gap-x-5 gap-y-3.5 px-4 py-4 sm:px-5 sm:py-[18px] md:grid-cols-[var(--sl-cols-md)] md:items-center lg:grid-cols-[var(--sl-cols-lg)]"
        data-package-href={`/api/web/grants/${encodeURIComponent(item.grantId)}/package`}
      >
        <div className="flex min-w-0 flex-col items-start gap-1">
          {closed && item.applyEnd ? (
            <Badge size="admin" className="bg-surface-muted font-extrabold text-text-secondary">
              마감 {formatShortDate(item.applyEnd)}
            </Badge>
          ) : null}
          <h3 className="text-[15.5px] leading-[1.35] font-extrabold tracking-[-0.2px] break-keep text-ink-strong">
            <a className="hover:text-brand-hover" href={titleHref}>{item.title}</a>
          </h3>
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] leading-5 text-text-secondary">
            {joinMeta([
              item.agency ? <span key="agency">{item.agency}</span> : null,
              deadlineLabel ? (
                <span
                  key="dday"
                  className={cn("font-extrabold tabular-nums", isUrgentDday(item.dDay) && "text-danger")}
                >
                  {deadlineLabel}
                </span>
              ) : null,
              writing?.capability.originalFormat ? (
                <span key="format">원본 {writing.capability.originalFormat.toUpperCase()}</span>
              ) : null,
              statusLine ? (
                <span
                  key="status"
                  className={cn(
                    item.stage === "selected" && "font-bold text-brand-mint-ink",
                    (item.stage === "rejected" || item.stage === "blocked") && "font-semibold text-danger",
                  )}
                >
                  {statusLine}
                </span>
              ) : null,
            ])}
          </p>
        </div>

        <div className="col-span-full rounded-xl bg-surface-soft px-3 py-3 md:col-span-1 md:row-start-2">
          <p className="text-xs font-semibold text-text-tertiary">다음 작업</p>
          <p className="mt-1 text-sm font-semibold text-ink">{applicationNextStep(item)}</p>
          <dl className="mt-2" aria-label="최근 저장 상태">
            <StatusCell label="문서 저장" {...(writing ? completionCell(item, writing, now) : NO_INFO_CELL)} />
          </dl>
        </div>
        <details className="col-span-full border-t border-border-subtle pt-3">
          <summary className="cursor-pointer text-xs font-semibold text-text-secondary">자격 조건 · 작성 기능 자세히</summary>
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="문서 진행 상태">
            <StatusCell label="자격 확인" {...(writing ? eligibilityCell(item, writing) : NO_INFO_CELL)} />
            <StatusCell label="작성 기능" {...(writing ? capabilityCell(item, writing) : NO_INFO_CELL)} />
          </dl>
        </details>

        <div className="flex items-center justify-end gap-2 md:col-start-2 md:row-start-1 lg:col-start-2 lg:row-start-1">
          {primary.kind === "link" ? (
            <a
              className={cn(
                buttonVariants({ variant: primary.tone === "outline" ? "outline" : "default", size: "sm" }),
                primary.tone === "mint" && MINT_BUTTON_CLASS,
              )}
              href={primary.href}
            >
              {primary.label}
            </a>
          ) : (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => onEdit("result")}>
              {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
              {primary.label}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={`${item.title} 추가 작업`}
                  disabled={pending}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              {pending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuLinkItem href={item.detailHref}>
                <FileText />
                공고 보기
              </DropdownMenuLinkItem>
              <DropdownMenuItem onClick={() => onEdit("management")}>
                <BellRing />
                메모·리마인더
              </DropdownMenuItem>
              {item.applyEnd || item.reminderAt ? (
                <DropdownMenuLinkItem href={`/api/web/applications/${encodeURIComponent(item.grantId)}/calendar`}>
                  <CalendarDays />
                  일정 .ics 내려받기
                </DropdownMenuLinkItem>
              ) : null}
              <DropdownMenuLinkItem href={`/api/web/grants/${encodeURIComponent(item.grantId)}/package`}>
                <Download />
                서류 패키지
              </DropdownMenuLinkItem>
              {item.stage !== "dismissed" ? (
                <DropdownMenuLinkItem href={`/api/web/applications/${encodeURIComponent(item.grantId)}/reminder-email`}>
                  <Mail />
                  리마인더 메일
                </DropdownMenuLinkItem>
              ) : null}
              <DropdownMenuSeparator />
              {item.stage === "submitted" ? (
                <DropdownMenuItem onClick={() => onEdit("result")}>
                  <CheckCircle2 />
                  결과 입력
                </DropdownMenuItem>
              ) : null}
              {canMarkSubmitted(item.stage) ? (
                <DropdownMenuItem onClick={() => void onMove(item, "applied", "submitted")}>
                  <Send />
                  제출 완료로 이동
                </DropdownMenuItem>
              ) : null}
              {item.stage === "recommended" ? (
                <DropdownMenuItem onClick={() => void onMove(item, "saved", "saved")}>
                  <Save />
                  저장
                </DropdownMenuItem>
              ) : null}
              {item.stage === "dismissed" ? (
                <DropdownMenuItem onClick={() => void onMove(item, "saved", "saved")}>
                  <Save />
                  진행 중으로 되돌리기
                </DropdownMenuItem>
              ) : item.stage !== "selected" && item.stage !== "rejected" && item.stage !== "blocked" ? (
                <DropdownMenuItem onClick={() => void onMove(item, "dismissed", "dismissed")}>
                  <Archive />
                  보류로 이동
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {showsPrepRequest ? (
          <div className="col-span-full border-t border-border-subtle pt-3 text-[13px] text-text-secondary [&_p]:text-left [&>div]:mt-0 [&>div]:items-start">
            <ConversionPollTrigger grantId={item.grantId} />
          </div>
        ) : showsClosedCaption ? (
          <p className="col-span-full border-t border-border-subtle pt-3 text-xs leading-5 text-text-tertiary">
            마감된 공고의 저장본은 열고 내보낼 수 있어요
          </p>
        ) : null}
      </article>
    </Card>
  );
}

/** 메타 조각 사이에 디자인의 `·` 구분자를 끼운다. null 조각은 건너뛴다. */
function joinMeta(parts: Array<ReactNode | null>): ReactNode {
  const present = parts.filter((part): part is ReactNode => part !== null);
  return present.map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? <span aria-hidden>·</span> : null}
      {part}
    </Fragment>
  ));
}

interface StatusCellContent {
  value: ReactNode;
  muted?: boolean;
  sub?: ReactNode;
}

/** `writing` 집계가 없는 구 데이터 — 라벨만 두고 값은 정보 없음으로 표기한다. */
const NO_INFO_CELL: StatusCellContent = { value: "정보 없음", muted: true };

/** 디자인 02 `.pc` — 모바일은 라벨(60px)+값의 가로 행, md 이상은 세로. */
function StatusCell({ label, value, muted, sub }: StatusCellContent & { label: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3 md:flex-col md:items-stretch md:gap-[3px]">
      <dt className="w-15 shrink-0 text-xs font-bold whitespace-nowrap text-text-tertiary md:w-auto">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "text-[13.5px] leading-normal font-semibold break-keep text-ink",
            muted && "font-medium text-text-secondary",
          )}
        >
          {value}
        </span>
        {sub ? (
          <span className="flex flex-wrap items-center gap-1.5 text-xs leading-5 text-text-tertiary">{sub}</span>
        ) : null}
      </dd>
    </div>
  );
}

function eligibilityCell(item: ApplicationPipelineItem, writing: ApplicationWritingStatus): StatusCellContent {
  if (writing.completion.closed) return { value: "마감 공고 · 새 후보에서 제외", muted: true };
  const { confirmed, total, remaining, mismatched } = writing.eligibility;
  if (total === 0) {
    return { value: item.outsideMatches ? "매칭 밖 · 직접 준비" : "필수 조건 판정 없음", muted: true };
  }
  const value = `확인된 조건 ${confirmed}/${total} · 남은 쟁점 ${remaining}`;
  if (mismatched > 0) {
    return { value, sub: <span className="font-bold text-danger">명백한 불일치 {mismatched}</span> };
  }
  if (remaining === 0) {
    return {
      value,
      sub: (
        <span className="inline-flex items-center gap-1.5 font-bold text-brand-mint-ink">
          <span aria-hidden className="inline-block size-2 rounded-full bg-brand-mint" />
          필수 조건 확인 완료
        </span>
      ),
    };
  }
  return { value };
}

function capabilityCell(item: ApplicationPipelineItem, writing: ApplicationWritingStatus): StatusCellContent {
  const { originalEdit, autofill, sectionDrafting } = writing.capability;
  const segments: Array<{ text: string; muted?: boolean }> = [];
  if (writing.completion.closed && hasSavedWork(item, writing)) {
    if (originalEdit) segments.push({ text: "원본 편집" });
    segments.push({ text: "내보내기" });
  } else {
    if (originalEdit) {
      segments.push({ text: "원본 편집" });
      segments.push(autofill
        ? { text: `항목 자동 반영 ${autofill.bound}/${autofill.total} 위치 확인` }
        : { text: "항목 자동 반영 미연결(양식 준비 대기)", muted: true });
    }
    if (sectionDrafting) segments.push({ text: "문안 제안" });
  }
  if (segments.length === 0) return { value: "작성 기능 미연결", muted: true };
  return {
    value: segments.map((segment, index) => (
      <Fragment key={segment.text}>
        {index > 0 ? " · " : null}
        <span className={cn(segment.muted && "font-medium text-text-secondary")}>{segment.text}</span>
      </Fragment>
    )),
  };
}

function completionCell(
  item: ApplicationPipelineItem,
  writing: ApplicationWritingStatus,
  now: string,
): StatusCellContent {
  const completion = writing.completion;
  if (!hasSavedWork(item, writing)) return { value: "저장본 없음", muted: true };
  const written = completion.sectionsTotal === null
    ? `작성한 문항 ${completion.sectionsWritten}`
    : `작성한 문항 ${completion.sectionsWritten}/${completion.sectionsTotal}`;
  if (completion.closed) {
    return { value: completion.lastSavedAt ? `${written} · 저장 ${formatCalendarDate(completion.lastSavedAt)}` : written };
  }
  const savedAt = completion.lastSavedAt ? `마지막 서버 저장 ${formatSavedAt(completion.lastSavedAt, now)}` : null;
  const needsSave = needsFileSave(writing);
  return {
    value: `${written} · 검토할 사실 ${completion.factsToReview}`,
    sub: savedAt || needsSave ? (
      <>
        {savedAt ? <span>{savedAt}</span> : null}
        {needsSave ? (
          <Badge size="admin" className="border-warning-strong/25 bg-warning-strong-soft font-bold text-warning-strong">
            파일 미반영
          </Badge>
        ) : null}
      </>
    ) : null,
  };
}

/** 스튜디오 저장본·문안 저장·초안 행 중 하나라도 있으면 "돌아갈 문서"가 있다. */
export function hasSavedWork(item: ApplicationPipelineItem, writing: ApplicationWritingStatus): boolean {
  return writing.completion.savedCount > 0 || writing.completion.sectionsWritten > 0 || item.draftCount > 0;
}

/**
 * "파일 미반영" 뱃지 — 브라우저의 미저장 변경은 서버가 모르므로 "저장 필요"라 하지 않고, 서버가 아는 사실만 말한다:
 * 문안은 서버에 저장됐지만 원본 파일 저장본(revision)이 한 번도 없으면 문안이 파일에 반영되지 않은 상태다.
 */
export function needsFileSave(writing: ApplicationWritingStatus): boolean {
  return writing.capability.originalEdit
    && writing.completion.sectionsWritten > 0
    && writing.completion.savedCount === 0;
}

export function applicationNextStep(item: ApplicationPipelineItem): string {
  const writing = item.writing;
  if (!isActiveStage(item.stage)) return applicationStatusLine(item);
  if (writing?.completion.closed) return hasSavedWork(item, writing) ? "마감 후에도 저장본을 열고 내보낼 수 있어요" : "마감된 공고예요. 공고 내용과 진행 기록을 확인하세요";
  if (writing && needsFileSave(writing)) return "저장한 문안을 원본에 반영하고 파일을 저장하세요";
  if (writing?.completion.factsToReview) return `작성본에서 사실 ${writing.completion.factsToReview}건을 검토하세요`;
  if (writing && hasSavedWork(item, writing)) return "최근 저장한 작성본을 이어서 준비하세요";
  return "공고 조건을 확인하면서 지원서 작성을 시작하세요";
}

export type PrimaryAction =
  | { kind: "link"; href: string; label: string; tone: "primary" | "mint" | "outline" }
  | { kind: "dialog"; label: string; tone: "outline" };

export function primaryAction(item: ApplicationPipelineItem): PrimaryAction {
  if (isActiveStage(item.stage)) {
    // 저장본 있음 → 문서 열기 / 없음 → 작성 시작(민트) / 마감 공고의 저장본 → 저장본 열기. href는 동일하다.
    const writing = item.writing ?? null;
    const saved = writing ? hasSavedWork(item, writing) : item.draftCount > 0;
    const closed = writing?.completion.closed ?? false;
    const href = `/grants/${encodeURIComponent(item.grantId)}/workspace`;
    if (closed && saved) return { kind: "link", href, label: "저장본 열기", tone: "outline" };
    if (saved) return { kind: "link", href, label: "문서 열기", tone: "primary" };
    return { kind: "link", href, label: "작성 시작", tone: "mint" };
  }
  if (item.stage === "submitted") {
    return { kind: "dialog", label: "결과 입력", tone: "outline" };
  }
  return { kind: "link", href: item.detailHref, label: "상세 보기", tone: "outline" };
}

/** 결과 대기·종료 항목의 상태 문구(제출·선정·탈락·막힘·보류). 진행 중 항목에는 붙이지 않는다. */
export function applicationStatusLine(item: ApplicationPipelineItem): string {
  if (item.stage === "selected") return item.outcomeNote ? `선정 · ${item.outcomeNote}` : "선정";
  if (item.stage === "rejected") return item.outcomeNote ? `탈락 · ${item.outcomeNote}` : "탈락";
  if (item.stage === "blocked") return item.outcomeNote ? `신청 막힘 · ${item.outcomeNote}` : "신청 막힘";
  if (item.stage === "dismissed") return item.outcomeNote ? `보류 · ${item.outcomeNote}` : "보류";
  if (item.stage === "submitted") {
    return item.lastActionAt ? `결과 대기 · 최근 확인 ${formatCalendarDate(item.lastActionAt)}` : "제출 완료 · 결과 대기";
  }
  if (item.stage === "preparing") {
    return item.draftCount > 0 ? `서류 ${item.reviewedDraftCount}/${item.draftCount} 확인` : "서류 확인 전";
  }
  return item.stage === "saved" ? "저장됨" : "추천됨";
}

export function isActiveStage(stage: ApplicationStage): boolean {
  return stage === "preparing" || stage === "saved" || stage === "recommended";
}

function canMarkSubmitted(stage: ApplicationStage): boolean {
  return stage === "recommended" || stage === "saved" || stage === "preparing";
}

function formatSavedAt(value: string, now: string): string {
  const saved = koreaDateParts(value);
  const today = koreaDateParts(now);
  if (saved.year === today.year && saved.month === today.month && saved.day === today.day) {
    const time = new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "Asia/Seoul",
    }).format(new Date(value));
    return `오늘 ${time}`;
  }
  return formatCalendarDate(value);
}

function formatShortDate(value: string): string {
  const { month, day } = koreaDateParts(value);
  return `${month}/${day}`;
}

function formatDday(value: number | null): string | null {
  if (value === null) return null;
  if (value < 0) return "마감";
  if (value === 0) return "D-Day";
  return `D-${value}`;
}

function isUrgentDday(value: number | null): boolean {
  return value !== null && value >= 0 && value <= URGENT_MAX_DDAY;
}

function formatCalendarDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}
