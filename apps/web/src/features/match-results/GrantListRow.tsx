"use client";

import type { MouseEventHandler, ReactNode } from "react";
import type { MatchCard } from "@cunote/contracts";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MatchEvidenceComparison } from "./MatchEvidenceComparison";
import { cn } from "@/lib/utils";
import {
  AiReadChip,
  ConditionFraction,
  ConditionStatusLine,
  GRANT_CARD_SHELL_CLASS,
  GrantMetaLine,
  GrantTitleLink,
} from "./GrantCardParts";
import type { MatchConditionStatus } from "./logic";

/**
 * 한 줄 행 카드(디자인 01 `.card.pad.lc`). 좌측 세로: 제목 → 메타 줄 → 상태 줄 → 캡션, 우측 보조 버튼.
 * 좁은 폭에서는 버튼이 아래로 내려간다(flex-wrap).
 */
export function GrantListRow({
  match,
  href,
  meta,
  status,
  statusNote,
  caption,
  captionClassName,
  actionLabel = "공고 보기",
  actionHref,
  onDetailOpen,
  menu,
  className,
}: {
  match: MatchCard;
  href: string;
  /** 기관 · D-day(또는 탐색 캡션) · 지원 요약. */
  meta: ReadonlyArray<ReactNode>;
  status?: MatchConditionStatus | null;
  /** 상태 줄 오른쪽에 붙는 짧은 캡션(예: "접수 여부 확인 필요"). */
  statusNote?: ReactNode;
  caption?: ReactNode;
  captionClassName?: string;
  actionLabel?: string;
  /** 버튼 링크. 지정하지 않으면 href. */
  actionHref?: string;
  onDetailOpen?: MouseEventHandler<HTMLAnchorElement> | undefined;
  /** 우상단 ⋯ 메뉴(로그인 회사 결과에서만 전달). */
  menu?: ReactNode;
  className?: string;
}) {
  return (
    <Card data-product-grant={match.grantId} className={cn(GRANT_CARD_SHELL_CLASS, className)}>
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-[18px]">
        <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <GrantTitleLink href={href} onClick={onDetailOpen} className="flex-1">{match.title}</GrantTitleLink>
            {menu ? <div className="-mt-1.5 -mr-2 shrink-0">{menu}</div> : null}
          </div>
          <GrantMetaLine
            items={meta}
            trailing={match.matchingEvidence?.level === "discovery" ? <AiReadChip /> : null}
          />
          {status ? (
            <div className="flex flex-wrap items-center gap-2.5">
              <ConditionStatusLine status={status} />
              {status.frac ? <ConditionFraction>{status.frac}</ConditionFraction> : null}
              {statusNote ? <span className="text-[13px] text-text-secondary">{statusNote}</span> : null}
            </div>
          ) : null}
          <MatchEvidenceComparison match={match} />
          {caption ? (
            <span className={cn("text-[13px] leading-[1.5] text-text-secondary", captionClassName)}>{caption}</span>
          ) : null}
        </div>
        <a
          href={actionHref ?? href}
          onClick={onDetailOpen}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "no-underline")}
        >
          {actionLabel}
        </a>
      </div>
    </Card>
  );
}
