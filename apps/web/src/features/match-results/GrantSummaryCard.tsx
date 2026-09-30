"use client";

import type { MouseEventHandler, ReactNode } from "react";
import type { MatchCard } from "@cunote/contracts";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  AiReadChip,
  ConditionFraction,
  ConditionStatusLine,
  DdayText,
  GRANT_CARD_SHELL_CLASS,
  GrantMetaLine,
  GrantTitleLink,
} from "./GrantCardParts";
import { matchConditionStatus, type MatchConditionStatus } from "./logic";
import { buildSupportSummary } from "./support-summary";

/**
 * 2열 그리드용 요약 카드(디자인 01 `.card.gc`). 구성 순서 고정:
 * 제목 → 기관 · D-day (· AI가 읽음) → 지원 요약 → 관련성 이유 ≤2줄 → 푸터(자격 상태 + 확인된 조건 N/M | 공고 보기) → 슬롯.
 * 조건 표·펼침 상세는 두지 않는다(공고 요약 페이지의 아코디언 담당).
 */
export function GrantSummaryCard({
  match,
  href,
  isNew = false,
  status,
  onDetailOpen,
  menu,
  children,
  className,
}: {
  match: MatchCard;
  href: string;
  isNew?: boolean;
  /** 지정하지 않으면 matchConditionStatus(match). */
  status?: MatchConditionStatus;
  onDetailOpen?: MouseEventHandler<HTMLAnchorElement> | undefined;
  /** 우상단 ⋯ 메뉴(로그인 회사 결과에서만 전달). */
  menu?: ReactNode;
  /** 질문 하나로 카드의 인라인 질문 박스 등 푸터 아래 슬롯. */
  children?: ReactNode;
  className?: string;
}) {
  const conditionStatus = status ?? matchConditionStatus(match);
  const support = buildSupportSummary(match);
  const reasons = match.ranking?.reasons.slice(0, 2) ?? [];
  const agency = match.agency?.trim();

  return (
    <Card data-product-grant={match.grantId} className={cn(GRANT_CARD_SHELL_CLASS, className)}>
      <div className="flex min-h-[184px] flex-col gap-2 px-5 py-[18px]">
        <div className="flex items-start gap-2">
          {isNew ? (
            <Badge className="mt-0.5 h-auto rounded-[6px] bg-brand-mint-soft px-1.5 py-0.5 text-[11px] font-extrabold text-brand-mint-ink">
              NEW
            </Badge>
          ) : null}
          <GrantTitleLink href={href} onClick={onDetailOpen} className="flex-1">{match.title}</GrantTitleLink>
          {menu ? <div className="-mt-1.5 -mr-2 shrink-0">{menu}</div> : null}
        </div>
        <GrantMetaLine
          items={[
            agency ? <span key="agency">{agency}</span> : null,
            <DdayText key="dday" dDay={match.dDay} />,
          ]}
          trailing={match.matchingEvidence?.level === "discovery" ? <AiReadChip /> : null}
        />
        <p aria-label={support.accessibleText} className="text-[15px] font-bold text-ink tabular-nums">
          {support.text}
        </p>
        {reasons.map((reason, index) => (
          <p key={`${index}:${reason}`} className="text-[12.5px] leading-[1.45] text-text-tertiary">
            {reason}
          </p>
        ))}
        <div className="mt-auto flex items-end justify-between gap-3 pt-1.5">
          <div className="flex min-w-0 flex-col gap-[3px]">
            <ConditionStatusLine status={conditionStatus} />
            {conditionStatus.frac ? <ConditionFraction>{conditionStatus.frac}</ConditionFraction> : null}
          </div>
          <a
            href={href}
            onClick={onDetailOpen}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "no-underline")}
          >
            공고 보기
          </a>
        </div>
        {children}
      </div>
    </Card>
  );
}
