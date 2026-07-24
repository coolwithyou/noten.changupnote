"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, HelpCircleIcon, MoreHorizontalIcon } from "lucide-react";
import type { GrantConfirmationSubmitResult, MatchCard, ProductTeaserResult } from "@cunote/contracts";
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
import { ConfirmationSheet } from "./ConfirmationSheet";
import {
  criterionResultText,
  formatDday,
  groupMatchesForDisplay,
  isUrgentDday,
  matchVerdictStatus,
  writeSupportCta,
} from "./logic";
import { buildSupportSummary, type SupportSummary } from "./support-summary";

const DEFAULT_VISIBLE_OPEN = 5;

export function ProgramsExperience({
  teaser,
  onPrepare,
  onOpenProfile,
  preparing,
  newGrantIds = new Set<string>(),
  onConfirmationSaved,
  onRequestConfirmation,
  autoOpenConfirmationGrantId,
}: {
  teaser: ProductTeaserResult;
  onPrepare: (grantId?: string) => void;
  onOpenProfile: () => void;
  preparing: boolean;
  newGrantIds?: ReadonlySet<string>;
  /** 확인 질문 저장 성공 시 재계산 카드를 상위 teaser 상태에 반영한다(4상태 버킷 이동). */
  onConfirmationSaved?: (result: GrantConfirmationSubmitResult) => void;
  /** 익명 결과에서는 회사 저장·로그인 후 같은 질문으로 복귀시키는 경계. */
  onRequestConfirmation?: (match: MatchCard) => void;
  /** 저장·로그인 복귀 후 자동으로 열 확인 질문 대상. */
  autoOpenConfirmationGrantId?: string | null;
}) {
  const groups = groupMatchesForDisplay(teaser.matches);
  const [showAllOpen, setShowAllOpen] = useState(false);
  // 시트 내용은 닫힘 애니메이션 동안 유지해야 하므로 대상과 열림 상태를 분리한다.
  const [confirmTarget, setConfirmTarget] = useState<MatchCard | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const autoOpenedGrantIdRef = useRef<string | null>(null);

  function openConfirmation(match: MatchCard) {
    if (onRequestConfirmation) {
      onRequestConfirmation(match);
      return;
    }
    setConfirmTarget(match);
    setConfirmOpen(true);
  }
  useEffect(() => {
    if (
      !autoOpenConfirmationGrantId
      || autoOpenedGrantIdRef.current === autoOpenConfirmationGrantId
    ) return;
    const match = teaser.matches.find((item) => item.grantId === autoOpenConfirmationGrantId);
    if (!match) return;
    autoOpenedGrantIdRef.current = autoOpenConfirmationGrantId;
    setConfirmTarget(match);
    setConfirmOpen(true);
  }, [autoOpenConfirmationGrantId, teaser.matches]);
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
                onOpenConfirmation={openConfirmation}
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
                onOpenConfirmation={openConfirmation}
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
          onOpenConfirmation={openConfirmation}
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
          onOpenConfirmation={openConfirmation}
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
          onOpenConfirmation={openConfirmation}
        />
      </div>

      {confirmTarget ? (
        <ConfirmationSheet
          grantId={confirmTarget.grantId}
          grantTitle={confirmTarget.title}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          {...(onConfirmationSaved ? { onSaved: onConfirmationSaved } : {})}
        />
      ) : null}
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
  onOpenConfirmation,
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
  onOpenConfirmation: (match: MatchCard) => void;
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
                onOpenConfirmation={onOpenConfirmation}
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
  onOpenConfirmation,
}: {
  match: MatchCard;
  status: NoticeCardStatus;
  isNew?: boolean;
  note?: string;
  className?: string;
  onOpenProfile: () => void;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
  onOpenConfirmation: (match: MatchCard) => void;
}) {
  const [open, setOpen] = useState(false);
  const cardStatus = status === "upcoming" ? status : matchVerdictStatus(match);
  const supportSummary = buildSupportSummary(match);
  if (!open) {
    return (
      <NoticeCard
        title={match.title}
        dday={status === "upcoming" && match.dDay === null ? "접수 예정" : formatDday(match.dDay)}
        supportSummary={supportSummary}
        status={status === "closed" ? "closed" : cardStatus}
        {...(isNew === undefined ? {} : { isNew })}
        {...(note === undefined ? {} : { note })}
        onClick={() => setOpen(true)}
        expanded={false}
        {...(className === undefined ? {} : { className })}
      />
    );
  }

  return (
    <ExpandedProgramCard
      match={match}
      status={status}
      supportSummary={supportSummary}
      onClose={() => setOpen(false)}
      onOpenProfile={onOpenProfile}
      onPrepare={onPrepare}
      preparing={preparing}
      onOpenConfirmation={onOpenConfirmation}
      {...(className === undefined ? {} : { className })}
    />
  );
}

function ExpandedProgramCard({
  match,
  status,
  supportSummary,
  onClose,
  onOpenProfile,
  onPrepare,
  preparing,
  onOpenConfirmation,
  className,
}: {
  match: MatchCard;
  status: NoticeCardStatus;
  supportSummary: SupportSummary;
  onClose: () => void;
  onOpenProfile: () => void;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
  onOpenConfirmation: (match: MatchCard) => void;
  className?: string;
}) {
  const passed = match.ruleTrace.filter((criterion) => criterion.result === "pass");
  const needsCheck = match.ruleTrace.filter(
    (criterion) => criterion.result === "unknown" || criterion.result === "text_only",
  );
  const primaryCheck = needsCheck[0];
  const detailHref = match.detailUrl ?? `/grants/${encodeURIComponent(match.grantId)}`;
  // 확인하기 CTA — one_answer/check_source 판정이고 발행된 확인 질문이 있을 때만(현재 테이블이
  // 비어 있어 미노출, B-4 승격 파이프라인 이후 활성). 어휘는 4상태 그대로, 결과 예고 문구 금지(D9).
  const verdict = matchVerdictStatus(match);
  const confirmationCount = match.confirmationQuestionCount ?? 0;
  const showConfirmation =
    (verdict === "one_answer" || verdict === "check_source") && confirmationCount > 0;
  // 자가신고 확인이 판정에 반영된 카드(결정 3) — open 승격이든 결격 확정이든 동일하게 정직 표기.
  const userConfirmedCount = match.userConfirmedCount ?? 0;
  // 재확인(답변 수정) 진입점 — verdict 로는 가리지 않는다. 확인하기 CTA 가 이미 보이는 카드는
  // 같은 시트를 여는 중복 진입점이 되므로 그때만 생략(시트가 GET 으로 기존 답변을 복원).
  const showReconfirm = userConfirmedCount > 0 && confirmationCount > 0 && !showConfirmation;

  return (
    <Card className={cn("gap-0 rounded-2xl border-border-card px-[22px] py-5 shadow-[var(--shadow-notice-hover)] ring-0", className)}>
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 break-words text-[17px] leading-snug font-bold tracking-[-0.2px] text-ink">{match.title}</h3>
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

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-2">
        {status === "upcoming" ? (
          <Badge variant="outline" className="border-brand-mint-soft bg-brand-mint-soft text-brand-mint-ink">
            접수 예정
          </Badge>
        ) : (
          <VerdictBadge status={status} />
        )}
        {userConfirmedCount > 0 ? (
          <Badge variant="outline" className="border-border-subtle text-text-secondary">
            본인 확인 기반
          </Badge>
        ) : null}
        <span
          className={cn(
            "text-[13.5px] font-extrabold tabular-nums",
            isUrgentDday(match.dDay) ? "text-danger" : "text-text-secondary",
          )}
        >
          {formatDday(match.dDay)}
        </span>
        <span
          aria-label={supportSummary.accessibleText}
          className="ml-auto max-w-full break-words text-right text-[15px] font-bold text-ink tabular-nums"
        >
          {supportSummary.text}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="카드 접기"
          aria-expanded={true}
        >
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

      {showConfirmation ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-soft px-3.5 py-3 text-sm leading-6 text-text-nav">
          <span className="min-w-0 flex-1">
            이 공고의 확인 질문 {confirmationCount}개 — 답한 내용은 판정에 바로 반영돼요
          </span>
          <Button
            type="button"
            variant="brand-soft"
            size="sm"
            className="shrink-0"
            onClick={() => onOpenConfirmation(match)}
          >
            확인하기
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
        {showReconfirm ? (
          <Button
            type="button"
            variant="link"
            onClick={() => onOpenConfirmation(match)}
            className="h-auto w-fit px-0 text-sm font-semibold"
          >
            확인 내용 수정
          </Button>
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
