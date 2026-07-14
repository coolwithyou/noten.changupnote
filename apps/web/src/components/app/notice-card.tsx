"use client";

import type { MouseEventHandler, ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VerdictBadge, type VerdictStatus } from "@/components/app/verdict-badge";
import { cn } from "@/lib/utils";

/** 판정 4상태 + upcoming(접수 예정). upcoming은 판정 뱃지 대신 접수 예정 안내를 노출한다. */
export type NoticeCardStatus = VerdictStatus | "upcoming";

export interface NoticeCardSupportSummary {
  text: string;
  accessibleText: string;
}

export interface NoticeCardProps {
  /** 공고 제목 */
  title: string;
  /**
   * D-day 표기.
   * - 판정형: "D-7" 형식(정규식 `D-<숫자>`). 숫자 N ≤ 14면 레드 강조, 아니면 회색.
   * - upcoming: "7/21 접수 시작" 같은 자유 문구(회색 표기 + 접수 예정 안내 병기).
   */
  dday: string;
  /** 금액을 우선하고 비금전 혜택을 대체 표시하는 지원 요약. */
  supportSummary: NoticeCardSupportSummary;
  /** 판정 4상태 또는 upcoming. */
  status: NoticeCardStatus;
  /** NEW 뱃지 노출 여부. */
  isNew?: boolean;
  /** 하단 한 줄 안내(예: "이노비즈 인증을 취득하면 열려요"). */
  note?: string;
  /** 상세로 이동하는 링크. 지정 시 앵커로 렌더(onClick보다 우선). */
  href?: string;
  /** href가 없을 때의 클릭 핸들러(펼침/토글 등). 지정 시 버튼으로 렌더. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** 토글 버튼의 현재 펼침 상태. */
  expanded?: boolean;
  className?: string;
}

/** D-day 레드 강조 임계(D-N ≤ 이 값이면 레드). 매칭 펼침 카드·신청 리스트와 공유하는 단일 기준. */
export const URGENT_MAX_DDAY = 14;

function isUrgent(status: NoticeCardStatus, dday: string): boolean {
  if (status === "upcoming") return false;
  const match = /^D-(\d+)$/.exec(dday.trim());
  return match !== null && Number(match[1]) <= URGENT_MAX_DDAY;
}

/**
 * 공고 접힘 카드 — 정확히 4요소(제목 / 판정 뱃지 / D-day / 지원 요약)를 노출한다.
 * 시각 스펙은 docs/design/2026-07-14-components/NoticeCard.dc.html을 토큰으로 재현.
 */
export function NoticeCard({
  title,
  dday,
  supportSummary,
  status,
  isNew,
  note,
  href,
  onClick,
  expanded,
  className,
}: NoticeCardProps) {
  const urgent = isUrgent(status, dday);
  const shell = cn(
    "group block rounded-lg border border-border-card bg-card px-5 py-4.5 text-ink no-underline shadow-[var(--shadow-notice)] transition-all hover:border-border-card-hover hover:shadow-[var(--shadow-notice-hover)]",
    className,
  );
  const trailingIcon = href ? (
    <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-text-quaternary" />
  ) : onClick ? (
    <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-text-quaternary" />
  ) : null;

  const body: ReactNode = (
    <>
      <div className="flex items-start gap-2">
        {isNew ? (
          <Badge className="h-auto rounded-[6px] bg-brand-mint-soft px-1.5 py-0.5 text-[11px] font-extrabold text-brand-mint-ink">
            NEW
          </Badge>
        ) : null}
        <span className="min-w-0 flex-1 break-words text-base font-bold tracking-[-0.2px] text-ink">{title}</span>
        {trailingIcon}
      </div>
      <div className="mt-[11px] flex flex-wrap items-center gap-x-2.5 gap-y-2">
        {status !== "upcoming" ? <VerdictBadge status={status} /> : null}
        <span
          className={cn(
            "text-[13.5px] tabular-nums",
            urgent ? "font-extrabold text-danger" : "font-semibold text-text-secondary",
          )}
        >
          {dday}
        </span>
        <span
          aria-label={supportSummary.accessibleText}
          className="ml-auto max-w-full break-words text-right text-[15px] font-bold text-ink tabular-nums"
        >
          {supportSummary.text}
        </span>
        {status === "upcoming" && dday !== "접수 예정" ? (
          <span className="text-[13px] font-bold whitespace-nowrap text-text-secondary">접수 예정</span>
        ) : null}
      </div>
      {note ? (
        <div className="mt-2.5 rounded-[10px] bg-surface-soft px-3 py-[9px] text-[13.5px] text-text-nav">
          {note}
        </div>
      ) : null}
    </>
  );

  if (href) {
    return (
      <a href={href} className={shell}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <Button
        type="button"
        variant="ghost"
        onClick={onClick}
        aria-expanded={expanded ?? false}
        className={cn(shell, "h-auto w-full justify-start whitespace-normal hover:bg-card text-left")}
      >
        {body}
      </Button>
    );
  }
  return <div className={shell}>{body}</div>;
}
