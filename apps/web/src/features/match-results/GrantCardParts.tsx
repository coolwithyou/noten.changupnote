import { Fragment, type MouseEventHandler, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  formatDday,
  isUrgentDday,
  type MatchConditionStatus,
  type MatchConditionStatusKind,
} from "./logic";

/**
 * 기회 맵 카드 공통 조각 — 디자인 01(`workbench.css`)의 `.card .gc-t .gc-m .dday .trust-ai .cs .st-src .frac .src`를
 * globals.css 토큰으로 재현한다. 판정 4상태 뱃지(verdict-badge)는 여기서 만들지 않는다.
 */

/** `.card` 껍데기 — 요약 카드·한 줄 행이 같은 테두리·그림자를 쓴다. */
export const GRANT_CARD_SHELL_CLASS =
  "gap-0 rounded-2xl border border-border-card bg-card py-0 text-ink ring-0 shadow-[var(--shadow-notice)] transition-colors hover:border-border-card-hover";

/** 카드 제목 링크(`.gc-t`). */
export function GrantTitleLink({
  href,
  onClick,
  className,
  children,
}: {
  href: string;
  onClick?: MouseEventHandler<HTMLAnchorElement> | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={onClick}
      className={cn(
        "min-w-0 break-words text-[16px] leading-[1.4] font-extrabold tracking-[-0.2px] text-ink-strong no-underline transition-colors hover:text-brand-hover",
        className,
      )}
    >
      {children}
    </a>
  );
}

/** 메타 줄(`.gc-m`) — 기관 · D-day · 지원 요약을 `·`로 잇는다. 빈 항목은 건너뛰고 `trailing`은 구분점 없이 붙인다. */
export function GrantMetaLine({
  items,
  trailing,
  className,
}: {
  items: ReadonlyArray<ReactNode>;
  trailing?: ReactNode;
  className?: string;
}) {
  const present = items.filter((item) => item !== null && item !== undefined && item !== false && item !== "");
  if (present.length === 0 && !trailing) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-[13px] text-text-secondary", className)}>
      {present.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {item}
        </Fragment>
      ))}
      {trailing}
    </div>
  );
}

/** D-day(`.dday`, 임박하면 `.hot`). 상시는 "상시". */
export function DdayText({ dDay }: { dDay: number | null }) {
  return (
    <span className={cn("font-extrabold tabular-nums", isUrgentDday(dDay) ? "text-danger" : "text-text-secondary")}>
      {formatDday(dDay)}
    </span>
  );
}

/** 해석 신뢰 칩(`.trust.trust-ai`) — 원문 미검수(discovery) 카드에만 붙인다. */
export function AiReadChip() {
  return (
    <Badge
      variant="outline"
      className="h-auto rounded-[6px] border-warning-strong/25 bg-warning-strong-soft px-1.5 py-px text-[11px] font-bold text-warning-strong"
    >
      AI가 읽음
    </Badge>
  );
}

const STATUS_TEXT_CLASS: Record<MatchConditionStatusKind, string> = {
  done: "text-brand-mint-ink",
  left: "text-brand-hover",
  mismatch: "text-text-tertiary",
  wait: "text-text-tertiary",
  source: "text-text-secondary",
};

/** 자격 상태 줄(`.cs.cs-done/.cs-left/.cs-no/.cs-wait`, 원문 미확인은 `.st.st-src`). */
export function ConditionStatusLine({
  status,
  className,
}: {
  status: MatchConditionStatus;
  className?: string;
}) {
  return (
    <span
      data-condition-status={status.kind}
      className={cn(
        "inline-flex items-center gap-1.5 text-[13px] font-bold whitespace-nowrap",
        status.kind === "source" && "gap-[7px] text-[13.5px]",
        STATUS_TEXT_CLASS[status.kind],
        className,
      )}
    >
      <ConditionStatusMark kind={status.kind} />
      {status.label}
    </span>
  );
}

function ConditionStatusMark({ kind }: { kind: MatchConditionStatusKind }) {
  if (kind === "source") {
    return <span aria-hidden="true" className="size-[18px] shrink-0 rounded-[4px] border-2 border-text-quaternary bg-background" />;
  }
  if (kind === "wait") {
    return <span aria-hidden="true" className="size-[9px] shrink-0 rounded-full border-2 border-dashed border-text-quaternary" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        kind === "done" && "bg-brand-mint",
        kind === "left" && "bg-brand",
        kind === "mismatch" && "bg-text-quaternary",
      )}
    />
  );
}

/** "확인된 조건 N/M"(`.frac`). */
export function ConditionFraction({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-[12.5px] text-text-tertiary tabular-nums", className)}>{children}</span>;
}

/** 원문 인용 미세 캡션(`.src`). */
export function SourceCaption({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-[11.5px] leading-[1.5] text-text-source", className)}>{children}</span>;
}
