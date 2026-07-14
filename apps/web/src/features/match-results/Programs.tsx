"use client";

import { useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, HelpCircleIcon, MoreHorizontalIcon } from "lucide-react";
import type { MatchCard, ProductTeaserResult } from "@cunote/contracts";
import { NoticeCard, type NoticeCardStatus } from "@/components/app/notice-card";
import { VerdictBadge, type VerdictStatus } from "@/components/app/verdict-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MatchFeedbackControls } from "@/features/opportunity-map/MatchFeedbackControls";
import { cn } from "@/lib/utils";
import {
  criterionResultText,
  formatAmount,
  formatDday,
  groupMatchesForDisplay,
  isUrgentDday,
  matchVerdictStatus,
  writeSupportCta,
} from "./logic";

const DEFAULT_VISIBLE_OPEN = 5;

export function ProgramsExperience({
  teaser,
  onPrepare,
  onOpenProfile,
  preparing,
  newGrantIds = new Set<string>(),
}: {
  teaser: ProductTeaserResult;
  onPrepare: (grantId?: string) => void;
  onOpenProfile: () => void;
  preparing: boolean;
  newGrantIds?: ReadonlySet<string>;
}) {
  const groups = groupMatchesForDisplay(teaser.matches);
  const [showAllOpen, setShowAllOpen] = useState(false);
  const visibleOpen = showAllOpen ? groups.open : groups.open.slice(0, DEFAULT_VISIBLE_OPEN);
  const totalOpen = Math.max(teaser.counts.openNow ?? 0, groups.open.length);
  const totalOneAnswer = Math.max(teaser.counts.oneAnswer ?? 0, groups.oneAnswer.length);
  const totalCheckSource = Math.max(teaser.counts.needsCoreReview ?? 0, groups.checkSource.length);
  const totalPreparable = Math.max(teaser.counts.preparable ?? 0, groups.preparable.length);

  return (
    <div>
      <section className="mt-10">
        <h2 className="mb-3 text-[15px] font-extrabold text-ink">
          지금 신청 가능 <span className="text-brand-mint-ink">{totalOpen}</span>
        </h2>
        {visibleOpen.length > 0 || groups.upcoming.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            {visibleOpen.map((match) => (
              <ExpandableProgramCard
                key={match.grantId}
                match={match}
                status="open"
                isNew={newGrantIds.has(match.grantId)}
                onOpenProfile={onOpenProfile}
                onPrepare={onPrepare}
                preparing={preparing}
              />
            ))}
            {groups.upcoming.slice(0, 1).map((match) => (
              <ExpandableProgramCard
                key={match.grantId}
                match={match}
                status="upcoming"
                className="opacity-55"
                onOpenProfile={onOpenProfile}
                onPrepare={onPrepare}
                preparing={preparing}
              />
            ))}
          </div>
        ) : (
          <p className="rounded-2xl bg-surface-soft px-5 py-6 text-sm leading-6 text-text-secondary">
            현재 정보로 바로 신청할 수 있다고 확인된 공고는 아직 없어요.
          </p>
        )}
        {!showAllOpen && groups.open.length > DEFAULT_VISIBLE_OPEN ? (
          <Button type="button" variant="ghost" onClick={() => setShowAllOpen(true)} className="mt-2 w-full text-brand">
            {groups.open.length - DEFAULT_VISIBLE_OPEN}건 더 보기
          </Button>
        ) : null}
        {totalOpen > groups.open.length ? (
          <Button type="button" variant="link" onClick={() => onPrepare()} disabled={preparing} className="mt-2 w-full">
            {totalOpen.toLocaleString("ko-KR")}건 전체 결과 저장하고 보기
          </Button>
        ) : null}
      </section>

      <div className="mt-8 border-t border-border-subtle">
        <ResultBucket
          label="답하면 확정"
          count={totalOneAnswer}
          countClassName="text-brand"
          matches={groups.oneAnswer}
          status="one_answer"
          emptyCopy="답변으로 바로 확정할 수 있는 공고는 현재 목록에 없어요."
          onOpenProfile={onOpenProfile}
          onPrepare={onPrepare}
          preparing={preparing}
        />
        <ResultBucket
          label="준비하면 열려요"
          count={totalPreparable}
          matches={groups.preparable}
          status="closed"
          emptyCopy="결과를 저장하면 필요한 준비 조건을 이어서 확인할 수 있어요."
          onOpenProfile={onOpenProfile}
          onPrepare={onPrepare}
          preparing={preparing}
        />
        <ResultBucket
          label="원문 확인 필요"
          count={totalCheckSource}
          matches={groups.checkSource}
          status="check_source"
          emptyCopy="원문 확인이 필요한 공고는 현재 목록에 없어요."
          onOpenProfile={onOpenProfile}
          onPrepare={onPrepare}
          preparing={preparing}
        />
      </div>
    </div>
  );
}

function ResultBucket({
  label,
  count,
  countClassName,
  matches,
  status,
  emptyCopy,
  onOpenProfile,
  onPrepare,
  preparing,
}: {
  label: string;
  count: number;
  countClassName?: string;
  matches: MatchCard[];
  status: VerdictStatus;
  emptyCopy: string;
  onOpenProfile: () => void;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border-subtle">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between px-1 py-[17px] text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/20">
        <span className="text-[15px] font-bold text-ink">
          {label} <span className={cn("text-text-secondary tabular-nums", countClassName)}>{count}건</span>
        </span>
        <ChevronDownIcon className={cn("size-4 text-text-quaternary transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2.5 pb-4">
          {matches.length > 0 ? (
            matches.map((match) => (
              <ExpandableProgramCard
                key={match.grantId}
                match={match}
                status={status}
                {...(status === "closed" ? { note: preparableNote(match) } : {})}
                onOpenProfile={onOpenProfile}
                onPrepare={onPrepare}
                preparing={preparing}
              />
            ))
          ) : (
            <p className="rounded-xl bg-surface-soft px-4 py-3 text-sm leading-6 text-text-secondary">{emptyCopy}</p>
          )}
          {count > matches.length ? (
            <div className="flex flex-col items-center gap-1">
              {matches.length > 0 ? (
                <p className="px-1 text-xs text-text-tertiary">
                  우선순위가 높은 {matches.length}건을 먼저 보여드려요.
                </p>
              ) : null}
              <Button type="button" variant="link" onClick={() => onPrepare()} disabled={preparing}>
                {count.toLocaleString("ko-KR")}건 전체 결과 저장하고 보기
              </Button>
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ExpandableProgramCard({
  match,
  status,
  isNew,
  note,
  className,
  onOpenProfile,
  onPrepare,
  preparing,
}: {
  match: MatchCard;
  status: NoticeCardStatus;
  isNew?: boolean;
  note?: string;
  className?: string;
  onOpenProfile: () => void;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cardStatus = status === "upcoming" ? status : matchVerdictStatus(match);
  if (!open) {
    return (
      <NoticeCard
        title={match.title}
        dday={status === "upcoming" && match.dDay === null ? "접수 예정" : formatDday(match.dDay)}
        amount={formatAmount(match.supportAmount)}
        status={status === "closed" ? "closed" : cardStatus}
        {...(isNew === undefined ? {} : { isNew })}
        {...(note === undefined ? {} : { note })}
        onClick={() => setOpen(true)}
        {...(className === undefined ? {} : { className })}
      />
    );
  }

  return (
    <ExpandedProgramCard
      match={match}
      status={status}
      onClose={() => setOpen(false)}
      onOpenProfile={onOpenProfile}
      onPrepare={onPrepare}
      preparing={preparing}
      {...(className === undefined ? {} : { className })}
    />
  );
}

function ExpandedProgramCard({
  match,
  status,
  onClose,
  onOpenProfile,
  onPrepare,
  preparing,
  className,
}: {
  match: MatchCard;
  status: NoticeCardStatus;
  onClose: () => void;
  onOpenProfile: () => void;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
  className?: string;
}) {
  const passed = match.ruleTrace.filter((criterion) => criterion.result === "pass");
  const needsCheck = match.ruleTrace.filter(
    (criterion) => criterion.result === "unknown" || criterion.result === "text_only",
  );
  const primaryCheck = needsCheck[0];
  const detailHref = match.detailUrl ?? `/grants/${encodeURIComponent(match.grantId)}`;

  return (
    <Card className={cn("gap-0 rounded-2xl border-border-card px-[22px] py-5 shadow-[var(--shadow-notice-hover)] ring-0", className)}>
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-[17px] leading-snug font-bold tracking-[-0.2px] text-ink">{match.title}</h3>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`${match.title} 메뉴`} />}
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64 p-3">
            <DropdownMenuLabel>이 공고 정리</DropdownMenuLabel>
            <MatchFeedbackControls grantId={match.grantId} title={match.title} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-2.5 flex items-center gap-2.5">
        {status === "upcoming" ? (
          <Badge variant="outline" className="border-brand-mint-soft bg-brand-mint-soft text-brand-mint-ink">
            접수 예정
          </Badge>
        ) : (
          <VerdictBadge status={status} />
        )}
        <span
          className={cn(
            "text-[13.5px] font-extrabold tabular-nums",
            isUrgentDday(match.dDay) ? "text-danger" : "text-text-secondary",
          )}
        >
          {formatDday(match.dDay)}
        </span>
        <span className="ml-auto text-[15px] font-bold text-ink tabular-nums">{formatAmount(match.supportAmount)}</span>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="카드 접기">
          <ChevronUpIcon />
        </Button>
      </div>

      <div className="mt-4 border-t border-border-subtle pt-4 text-[15px] text-ink">
        충족 <strong>{passed.length}건</strong> <CheckIcon className="inline size-4 text-brand-mint-ink" strokeWidth={3} />
        <span className="mx-2 text-text-quaternary">·</span>
        확인 필요 <strong className="text-brand">{needsCheck.length}건</strong>
      </div>

      {primaryCheck ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-surface-soft px-3.5 py-3 text-sm leading-6 text-text-nav">
          <HelpCircleIcon className="mt-1 size-4 shrink-0 text-brand" />
          <span className="min-w-0 flex-1">
            {primaryCheck.label} — {criterionResultText(primaryCheck.result)}
          </span>
          <Button type="button" variant="link" onClick={onOpenProfile} className="h-auto shrink-0 px-0 text-[13px]">
            내 정보에서 채우기
          </Button>
        </div>
      ) : null}

      {match.ranking?.reasons.length ? (
        <div className="mt-2.5 rounded-xl bg-surface-brand px-4 py-3.5 text-sm leading-[1.65] text-text-nav">
          {match.ranking.reasons.slice(0, 2).join(" · ")}
        </div>
      ) : null}

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <a href={`/grants/${encodeURIComponent(match.grantId)}`} className="text-sm font-semibold text-brand no-underline hover:text-brand-hover">
          조건 전체 보기
        </a>
        {match.detailUrl ? (
          <a href={detailHref} className="text-sm font-semibold text-brand no-underline hover:text-brand-hover">
            공고 상세
          </a>
        ) : null}
        <Button
          type="button"
          onClick={() => onPrepare(match.grantId)}
          disabled={preparing}
          className="sm:ml-auto"
        >
          {preparing ? "준비 중…" : writeSupportCta(match.writeSupport)}
        </Button>
      </div>
    </Card>
  );
}

function preparableNote(match: MatchCard): string {
  const condition = match.ruleTrace.find(
    (criterion) => criterion.result === "fail" || criterion.result === "unknown",
  );
  return condition ? `${condition.label}을 확인·준비하면 다시 판정해요` : "필요한 조건을 준비하면 다시 판정해요";
}
