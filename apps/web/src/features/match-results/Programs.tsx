"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, MoreHorizontalIcon } from "lucide-react";
import type {
  CriterionDimension,
  GrantConfirmationSubmitResult,
  MatchCard,
  MatchingProfileAnswerRequest,
  NextQuestionDto,
  ProductTeaserResult,
} from "@cunote/contracts";
import { explainMatch } from "@cunote/core";
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
import { withCompanyContext } from "@/lib/navigation/companyContext";
import { createMatchJourneyRecorder } from "@/lib/client/matchJourney";
import { observeProductCards } from "@/lib/client/productCardExposure";
import { ConfirmationSheet } from "./ConfirmationSheet";
import { InlineGrantConfirmation } from "./InlineGrantConfirmation";
import { InlineProfileCondition } from "./InlineProfileCondition";
import {
  formatDday,
  groupMatchesForDisplay,
  isUrgentDday,
  matchCriterionPresentation,
  matchConfirmationCtaState,
  matchDetailHref,
  matchVerdictStatus,
  writeSupportCta,
  writeSupportNote,
} from "./logic";
import { buildSupportSummary, type SupportSummary } from "./support-summary";

const DEFAULT_VISIBLE_OPEN = 5;
const JourneyContext = createContext<ReturnType<typeof createMatchJourneyRecorder> | null>(null);
const ProfileQuestionContext = createContext<{
  question: NextQuestionDto | null;
  onAnswer?: ((answer: MatchingProfileAnswerRequest) => Promise<void>) | undefined;
  submitting: boolean;
}>({ question: null, submitting: false });

export function ProgramsExperience({
  teaser,
  onPrepare,
  onOpenProfile,
  profileQuestion = null,
  onProfileAnswer,
  profileSubmitting = false,
  preparing,
  newGrantIds = new Set<string>(),
  onConfirmationSaved,
  onRequestConfirmation,
  autoOpenConfirmationGrantId,
  autoOpenConfirmationQuestionId,
  virtualBizNo = null,
  companyId = null,
}: {
  teaser: ProductTeaserResult;
  onPrepare: (grantId?: string) => void;
  onOpenProfile: (dimension?: CriterionDimension) => void;
  profileQuestion?: NextQuestionDto | null;
  onProfileAnswer?: (answer: MatchingProfileAnswerRequest) => Promise<void>;
  profileSubmitting?: boolean;
  preparing: boolean;
  newGrantIds?: ReadonlySet<string>;
  /** 확인 질문 저장 성공 시 재계산 카드를 상위 teaser 상태에 반영한다(4상태 버킷 이동). */
  onConfirmationSaved?: ((result: GrantConfirmationSubmitResult) => void) | undefined;
  /** 익명 결과에서는 회사 저장·로그인 후 같은 질문으로 복귀시키는 경계. */
  onRequestConfirmation?: (match: MatchCard) => void;
  /** 저장·로그인 복귀 후 자동으로 열 확인 질문 대상. */
  autoOpenConfirmationGrantId?: string | null;
  /** 익명 handoff가 보존한 exact 질문. 현재 proof와 같을 때만 inline 복귀를 인정한다. */
  autoOpenConfirmationQuestionId?: string | null;
  /** 등록된 개발용 가상 기업만 공고 상세의 읽기 전용 맥락으로 전달한다. */
  virtualBizNo?: string | null;
  companyId?: string | null;
}) {
  const [recordJourney] = useState(createMatchJourneyRecorder);
  useEffect(() => { recordJourney.begin(companyId); }, [companyId, recordJourney]);
  const profileQuestionContextValue = useMemo(() => ({
    question: profileQuestion,
    ...(onProfileAnswer ? { onAnswer: onProfileAnswer } : {}),
    submitting: profileSubmitting,
  }), [onProfileAnswer, profileQuestion, profileSubmitting]);
  const groups = groupMatchesForDisplay(teaser.matches);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rootRef.current || !companyId) return;
    const tokens = new Map(teaser.matches.flatMap((match) => match.exposureToken ? [[match.grantId, match.exposureToken] as const] : []));
    return observeProductCards(rootRef.current, tokens, companyId);
  }, [companyId, teaser.matches]);
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
    if (autoOpenConfirmationQuestionId) {
      const currentQuestionId = explainMatch(match).confirmationReadiness.representativeQuestionId;
      if (currentQuestionId !== autoOpenConfirmationQuestionId) return;
      autoOpenedGrantIdRef.current = autoOpenConfirmationGrantId;
      return;
    }
    autoOpenedGrantIdRef.current = autoOpenConfirmationGrantId;
    setConfirmTarget(match);
    setConfirmOpen(true);
  }, [autoOpenConfirmationGrantId, autoOpenConfirmationQuestionId, teaser.matches]);
  const visibleOpen = showAllOpen ? groups.open : groups.open.slice(0, DEFAULT_VISIBLE_OPEN);
  const unavailable = [...groups.preparable, ...groups.closed];

  return (
    <ProfileQuestionContext.Provider value={profileQuestionContextValue}>
    <JourneyContext.Provider value={recordJourney}>
    <div ref={rootRef}>
      {visibleOpen.length > 0 ? (
      <section className="mt-10">
        <h2 className="mb-3 text-[15px] font-extrabold text-ink">
          살펴볼 공고 <span className="text-text-secondary">표시 중 {visibleOpen.length}건</span>
        </h2>
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
              onConfirmationSaved={onConfirmationSaved}
              virtualBizNo={virtualBizNo}
              companyId={companyId}
            />
          ))}
        </div>
        {!showAllOpen && groups.open.length > DEFAULT_VISIBLE_OPEN ? (
          <Button type="button" variant="ghost" onClick={() => setShowAllOpen(true)} className="mt-2 w-full text-brand">
            {groups.open.length - DEFAULT_VISIBLE_OPEN}건 더 보기
          </Button>
        ) : null}
      </section>
      ) : null}

      <div className="mt-8 border-t border-border-subtle">
        {groups.oneQuestionAway.length > 0 ? (
          <ResultBucket
            label="질문 하나로 지원 여부 확인"
            countClassName="text-brand"
            matches={groups.oneQuestionAway}
            status="one_answer"
            defaultOpen
            defaultExpanded
            onOpenProfile={onOpenProfile}
            onPrepare={onPrepare}
            preparing={preparing}
            onOpenConfirmation={openConfirmation}
            onConfirmationSaved={onConfirmationSaved}
            virtualBizNo={virtualBizNo}
            companyId={companyId}
          />
        ) : null}
        {groups.oneAnswer.length > 0 ? (
        <ResultBucket
          label="회사 정보 추가 확인"
          countClassName="text-brand"
          matches={groups.oneAnswer}
          status="one_answer"
          onOpenProfile={onOpenProfile}
          onPrepare={onPrepare}
          preparing={preparing}
          onOpenConfirmation={openConfirmation}
          onConfirmationSaved={onConfirmationSaved}
          virtualBizNo={virtualBizNo}
          companyId={companyId}
        />
        ) : null}
        {groups.checkSource.length > 0 ? (
        <ResultBucket
          label="공고 조건 확인"
          matches={groups.checkSource}
          status="check_source"
          defaultOpen
          onOpenProfile={onOpenProfile}
          onPrepare={onPrepare}
          preparing={preparing}
          onOpenConfirmation={openConfirmation}
          onConfirmationSaved={onConfirmationSaved}
          virtualBizNo={virtualBizNo}
          companyId={companyId}
        />
        ) : null}
        {unavailable.length > 0 ? (
        <ResultBucket
          label="현재 신청 어려움"
          matches={unavailable}
          status="closed"
          onOpenProfile={onOpenProfile}
          onPrepare={onPrepare}
          preparing={preparing}
          onOpenConfirmation={openConfirmation}
          onConfirmationSaved={onConfirmationSaved}
          virtualBizNo={virtualBizNo}
          companyId={companyId}
        />
        ) : null}
        {groups.upcoming.length > 0 ? (
        <ResultBucket
          label="접수 예정"
          matches={groups.upcoming}
          status="closed"
          onOpenProfile={onOpenProfile}
          onPrepare={onPrepare}
          preparing={preparing}
          onOpenConfirmation={openConfirmation}
          onConfirmationSaved={onConfirmationSaved}
          virtualBizNo={virtualBizNo}
          companyId={companyId}
          upcoming
        />
        ) : null}
      </div>

      {confirmTarget ? (
        <ConfirmationSheet
          companyId={companyId}
          grantId={confirmTarget.grantId}
          grantTitle={confirmTarget.title}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          {...(onConfirmationSaved ? { onSaved: onConfirmationSaved } : {})}
        />
      ) : null}
    </div>
    </JourneyContext.Provider>
    </ProfileQuestionContext.Provider>
  );
}

function ResultBucket({
  label,
  countClassName,
  defaultOpen = false,
  defaultExpanded = false,
  matches,
  status,
  onOpenProfile,
  onPrepare,
  preparing,
  onOpenConfirmation,
  onConfirmationSaved,
  virtualBizNo = null,
  companyId = null,
  upcoming = false,
}: {
  label: string;
  countClassName?: string;
  defaultOpen?: boolean;
  defaultExpanded?: boolean;
  matches: MatchCard[];
  status: VerdictStatus;
  onOpenProfile: (dimension?: CriterionDimension) => void;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
  onOpenConfirmation: (match: MatchCard) => void;
  onConfirmationSaved?: ((result: GrantConfirmationSubmitResult) => void) | undefined;
  virtualBizNo?: string | null;
  companyId?: string | null;
  upcoming?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-border-subtle">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between px-1 py-[17px] text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/20">
        <span className="text-[15px] font-bold text-ink">
          {label} <span className={cn("text-text-secondary tabular-nums", countClassName)}>표시 중 {matches.length}건</span>
        </span>
        <ChevronDownIcon className={cn("size-4 text-text-quaternary transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2.5 pb-4">
          {matches.map((match) => (
              <ExpandableProgramCard
                key={match.grantId}
                match={match}
                status={upcoming ? "upcoming" : status}
                onOpenProfile={onOpenProfile}
                onPrepare={onPrepare}
                preparing={preparing}
                onOpenConfirmation={onOpenConfirmation}
                onConfirmationSaved={onConfirmationSaved}
                defaultExpanded={defaultExpanded}
                virtualBizNo={virtualBizNo}
                companyId={companyId}
              />
            ))}
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
  onConfirmationSaved,
  defaultExpanded = false,
  virtualBizNo = null,
  companyId = null,
}: {
  match: MatchCard;
  status: NoticeCardStatus;
  isNew?: boolean;
  note?: string;
  className?: string;
  onOpenProfile: (dimension?: CriterionDimension) => void;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
  onOpenConfirmation: (match: MatchCard) => void;
  onConfirmationSaved?: ((result: GrantConfirmationSubmitResult) => void) | undefined;
  defaultExpanded?: boolean;
  virtualBizNo?: string | null;
  companyId?: string | null;
}) {
  const [open, setOpen] = useState(defaultExpanded);
  const recordJourney = useContext(JourneyContext);
  const cardStatus = status === "upcoming" ? status : matchVerdictStatus(match);
  const supportSummary = buildSupportSummary(match);
  const explanation = explainMatch(match);
  if (!open) {
    return (
      <div data-product-grant={match.grantId}>
      <NoticeCard
        title={match.title}
        dday={status === "upcoming" && match.dDay === null ? "접수 예정" : formatDday(match.dDay)}
        supportSummary={supportSummary}
        status={status === "closed" ? "closed" : cardStatus}
        {...(isNew === undefined ? {} : { isNew })}
        note={note ?? explanation.summary}
        onClick={() => { recordJourney?.(companyId, match, "card_open"); setOpen(true); }}
        expanded={false}
        {...(className === undefined ? {} : { className })}
      />
      </div>
    );
  }

  return (
    <div data-product-grant={match.grantId}>
    <ExpandedProgramCard
      match={match}
      status={status}
      supportSummary={supportSummary}
      onClose={() => setOpen(false)}
      onOpenProfile={(dimension) => { recordJourney?.(companyId, match, "profile_start"); onOpenProfile(dimension); }}
      onPrepare={(grantId) => { recordJourney?.(companyId, match, "preparation_start"); onPrepare(grantId); }}
      preparing={preparing}
      onOpenConfirmation={(target) => { recordJourney?.(companyId, match, "confirmation_start"); onOpenConfirmation(target); }}
      onConfirmationSaved={onConfirmationSaved}
      onDetailOpen={() => recordJourney?.(companyId, match, "detail_open")}
      virtualBizNo={virtualBizNo}
      companyId={companyId}
      {...(className === undefined ? {} : { className })}
    />
    </div>
  );
}

export function ExpandedProgramCard({
  onDetailOpen,
  match,
  status,
  supportSummary,
  onClose,
  onOpenProfile,
  onPrepare,
  preparing,
  onOpenConfirmation,
  onConfirmationSaved,
  virtualBizNo,
  companyId = null,
  className,
}: {
  onDetailOpen?: () => void;
  match: MatchCard;
  status: NoticeCardStatus;
  supportSummary: SupportSummary;
  onClose: () => void;
  onOpenProfile: (dimension?: CriterionDimension) => void;
  onPrepare: (grantId?: string) => void;
  preparing: boolean;
  onOpenConfirmation: (match: MatchCard) => void;
  onConfirmationSaved?: ((result: GrantConfirmationSubmitResult) => void) | undefined;
  virtualBizNo?: string | null;
  companyId?: string | null;
  className?: string;
}) {
  const criteria = matchCriterionPresentation(match);
  const explanation = explainMatch(match);
  const profileQuestionContext = useContext(ProfileQuestionContext);
  const conditions = [...explanation.conditions].sort(
    (left, right) => conditionOrder(left) - conditionOrder(right),
  );
  const pendingConditionCount = conditions.filter((condition) => condition.pending).length;
  const resolvedConditionCount = conditions.length - pendingConditionCount;
  const primaryProfileInput = explanation.profile[0];
  const baseDetailHref = matchDetailHref(match, virtualBizNo);
  const detailHref = companyId ? withCompanyContext(baseDetailHref, companyId) : baseDetailHref;
  // 확인하기 CTA — exact 질문 주석이 user_confirmation으로 분류한 경우에만 연다. preferred-only
  // eligible 카드도 우대 확인을 보완할 수 있으며, 이 CTA 자체는 eligibility/verdict를 바꾸지 않는다.
  const confirmationCta = matchConfirmationCtaState(match);
  const showConfirmation = confirmationCta.showConfirmation;
  // 자가신고 확인이 판정에 반영된 카드(결정 3) — open 승격이든 결격 확정이든 동일하게 정직 표기.
  const userConfirmedCount = match.userConfirmedCount ?? 0;
  // 재확인(답변 수정) 진입점 — verdict 로는 가리지 않는다. 확인하기 CTA 가 이미 보이는 카드는
  // 같은 시트를 여는 중복 진입점이 되므로 그때만 생략(시트가 GET 으로 기존 답변을 복원).
  const showReconfirm = confirmationCta.showReconfirm;
  const exactConfirmationQuestionId = explanation.confirmationReadiness.status === "one_question_away"
    ? explanation.confirmationReadiness.representativeQuestionId
    : null;

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

      <div className="mt-4 border-t border-border-subtle pt-4">
        <p className="text-[15px] leading-6 font-semibold text-ink">{explanation.summary}</p>
        {!explanation.discovery ? (
          <p className="mt-1 text-[13px] leading-5 text-text-secondary">
            충족 확인 {explanation.passed} · 미충족 {explanation.failed} · 미확인 {explanation.unknown}
          </p>
        ) : null}
      </div>

      {conditions.length > 0 ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-border-subtle bg-surface-soft/60">
          <div className="border-b border-border-subtle px-3.5 py-2.5 text-[12px] font-bold text-text-secondary">
            {pendingConditionCount > 0 ? (
              <span className="text-brand">지금 확인할 조건 {pendingConditionCount}개</span>
            ) : (
              <span>지원 여부를 결정하는 조건 {conditions.length}개</span>
            )}
            {resolvedConditionCount > 0 ? <span> · 확인됨 {resolvedConditionCount}개</span> : null}
          </div>
          {conditions.map((condition, index) => (
            <ConditionRow
              key={`${condition.trace.criterionId ?? condition.trace.dimension}-${condition.trace.kind}-${index}`}
              condition={condition}
              detailHref={detailHref}
              onOpenProfile={onOpenProfile}
              onOpenConfirmation={() => onOpenConfirmation(match)}
              questionId={match.confirmationQuestionBindings?.find((binding) => (
                binding.criterionId === condition.trace.criterionId
              ))?.questionId ?? null}
              companyId={companyId}
              grantId={match.grantId}
              onConfirmationSaved={onConfirmationSaved}
              onPrepare={(grantId) => onPrepare(grantId)}
              profileQuestion={profileQuestionContext.question?.dimension === condition.trace.dimension
                ? profileQuestionContext.question
                : null}
              onProfileAnswer={profileQuestionContext.onAnswer}
              profileSubmitting={profileQuestionContext.submitting}
              canConfirm={showConfirmation && condition.trace.criterionId !== explanation.confirmationReadiness.representativeCriterionId}
              inlineAnswer={condition.trace.criterionId === explanation.confirmationReadiness.representativeCriterionId}
              bordered={index > 0}
            />
          ))}
        </div>
      ) : explanation.discovery ? (
        <div className="mt-3 rounded-xl bg-surface-soft px-3.5 py-3 text-sm leading-6 text-text-nav">
          맞춤 자격 판단 전 단계예요. 공고 원문에서 모집 대상과 제외 조건을 확인해 주세요.
        </div>
      ) : null}

      {criteria.preferredPassed.length > 0 || criteria.preferredNeedsInput.length > 0 || criteria.evaluationNotes.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-text-secondary">
          {criteria.preferredPassed.length > 0 ? <span>우대 확인 {criteria.preferredPassed.length}건</span> : null}
          {criteria.preferredNeedsInput.length > 0 ? (
            <span>우대점수 추가 확인 {criteria.preferredNeedsInput.length}건</span>
          ) : null}
          {criteria.evaluationNotes.length > 0 ? (
            <span>선정평가·준비 {criteria.evaluationNotes.length}건</span>
          ) : null}
        </div>
      ) : null}

      {explanation.reviewNotes.length > 0 ? (
        <p className="mt-3 rounded-xl bg-surface-soft px-3.5 py-3 text-sm leading-6 text-text-nav">
          {explanation.reviewNotes.join(" · ")}
        </p>
      ) : null}

      {match.ranking?.reasons.length ? (
        <div className="mt-2.5 rounded-xl bg-surface-brand px-4 py-3.5 text-sm leading-[1.65] text-text-nav">
          {match.ranking.reasons.slice(0, 2).join(" · ")}
        </div>
      ) : null}

      {exactConfirmationQuestionId && !match.confirmationQuestionBindings?.some((binding) => (
        binding.questionId === exactConfirmationQuestionId
      )) ? (
        companyId && onConfirmationSaved ? (
          <InlineGrantConfirmation
            companyId={companyId}
            grantId={match.grantId}
            questionId={exactConfirmationQuestionId}
            onSaved={onConfirmationSaved}
            onPrepare={onPrepare}
            onFallback={() => onOpenConfirmation(match)}
          />
        ) : (
          <div className="mt-4 rounded-2xl border border-brand-tint bg-surface-brand px-4 py-4 sm:px-5">
            <p className="text-xs font-extrabold text-brand">이 조건 하나만 확인하면 돼요</p>
            <p className="mt-2 text-sm leading-6 font-semibold text-ink">
              {explanation.confirmation[0]?.requirement ?? "공고별 확인 질문"}
            </p>
            <Button type="button" onClick={() => onOpenConfirmation(match)} className="mt-3 w-full sm:w-auto">
              회사 정보를 저장하고 답하기
            </Button>
          </div>
        )
      ) : null}

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <a href={detailHref} onClick={onDetailOpen} className="text-sm font-semibold text-brand no-underline hover:text-brand-hover">
          공고 상세 및 조건 근거 보기
        </a>
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
        {explanation.action === "preparation" && match.writeSupport === "manual_form" ? (
          <span className="text-sm leading-6 text-text-muted">
            {writeSupportNote(match.writeSupport)}
          </span>
        ) : null}
        {explanation.action === "company_profile" && primaryProfileInput ? (
          <Button
            type="button"
            onClick={() => onOpenProfile(primaryProfileInput.trace.dimension)}
            className="sm:ml-auto"
          >
            회사 정보 확인하기
          </Button>
        ) : explanation.action === "user_confirmation" && showConfirmation && !exactConfirmationQuestionId ? (
          <Button type="button" onClick={() => onOpenConfirmation(match)} className="sm:ml-auto">
            공고별 질문에 답하기
          </Button>
        ) : explanation.action === "preparation" ? (
          <Button
            type="button"
            onClick={() => onPrepare(match.grantId)}
            disabled={preparing}
            className="sm:ml-auto"
          >
            {preparing ? "준비 중…" : writeSupportCta(match.writeSupport)}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

type ExplainedCondition = ReturnType<typeof explainMatch>["conditions"][number];

function conditionOrder(condition: ExplainedCondition): number {
  if (condition.trace.result === "fail") return 0;
  if (condition.action === "company_profile" || condition.action === "user_confirmation") return 1;
  if (condition.pending) return 2;
  return 3;
}

function ConditionRow({
  condition,
  detailHref,
  onOpenProfile,
  onOpenConfirmation,
  questionId,
  companyId,
  grantId,
  onConfirmationSaved,
  onPrepare,
  profileQuestion,
  onProfileAnswer,
  profileSubmitting,
  canConfirm,
  inlineAnswer,
  bordered,
}: {
  condition: ExplainedCondition;
  detailHref: string;
  onOpenProfile: (dimension?: CriterionDimension) => void;
  onOpenConfirmation: () => void;
  questionId: string | null;
  companyId: string | null;
  grantId: string;
  onConfirmationSaved?: ((result: GrantConfirmationSubmitResult) => void) | undefined;
  onPrepare: (grantId: string) => void;
  profileQuestion: NextQuestionDto | null;
  onProfileAnswer?: ((answer: MatchingProfileAnswerRequest) => Promise<void>) | undefined;
  profileSubmitting: boolean;
  canConfirm: boolean;
  inlineAnswer: boolean;
  bordered: boolean;
}) {
  const hasInlineProfile = condition.action === "company_profile"
    && profileQuestion !== null
    && onProfileAnswer !== undefined;
  const hasInlineConfirmation = condition.action === "user_confirmation" && questionId !== null;
  return (
    <article className={cn("px-3.5 py-3.5", bordered && "border-t border-border-subtle")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "shrink-0",
            condition.trace.result === "pass" && "border-brand-mint-soft bg-brand-mint-soft text-brand-mint-ink",
            condition.trace.result === "fail" && "border-danger/20 bg-danger/5 text-danger",
          )}
        >
          {condition.statusLabel}
        </Badge>
        <span className="text-xs font-semibold text-text-secondary">
          {condition.trace.kind === "exclusion" ? "제외 조건" : "필수 조건"}
        </span>
      </div>
      {condition.asksUser ? (
        <p className="mt-3 text-[15px] leading-6 font-bold text-ink">
          귀사가 아래 공고 조건에 해당하나요?
        </p>
      ) : null}
      <dl className="mt-3 grid gap-3 text-[13px] leading-5 sm:grid-cols-2">
        <ConditionFact label={condition.asksUser ? "확인할 조건" : "공고 조건"} value={condition.requirement} />
        {!condition.pending || condition.hasCompanyValue || condition.action === "company_profile" ? (
          <ConditionFact label="회사 정보" value={condition.companyValue} />
        ) : null}
        <ConditionFact label={condition.asksUser ? "확인하면" : "현재 판단"} value={condition.reason} />
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold text-text-tertiary">
            {condition.asksUser ? "확인 방법" : "다음 행동"}
          </dt>
          <dd className="mt-0.5 break-words font-medium text-text-nav">
            {conditionActionText(
              condition,
              canConfirm,
              inlineAnswer,
              hasInlineProfile,
              hasInlineConfirmation,
            )}
          </dd>
          {condition.action === "company_profile" && !hasInlineProfile ? (
            <Button
              type="button"
              variant="link"
              onClick={() => onOpenProfile(condition.trace.dimension)}
              className="mt-1 h-auto px-0 text-[13px]"
            >
              이 회사 정보 확인하기
            </Button>
          ) : condition.action === "user_confirmation" && canConfirm && !hasInlineConfirmation ? (
            <Button
              type="button"
              variant="link"
              onClick={onOpenConfirmation}
              className="mt-1 h-auto px-0 text-[13px]"
            >
              이 조건에 답하기
            </Button>
          ) : condition.pending || condition.trace.result === "fail" ? (
            <a href={detailHref} className="mt-1 inline-block font-semibold text-brand hover:text-brand-hover">
              {condition.asksUser ? "공고에서 이 조건 확인하기" : "원문 근거 보기"}
            </a>
          ) : null}
        </div>
      </dl>
      {condition.action === "company_profile" && profileQuestion && onProfileAnswer ? (
        <InlineProfileCondition
          question={profileQuestion}
          requirement={condition.requirement}
          onAnswer={onProfileAnswer}
          submitting={profileSubmitting}
        />
      ) : null}
      {condition.action === "user_confirmation" && questionId && companyId && onConfirmationSaved ? (
        <InlineGrantConfirmation
          companyId={companyId}
          grantId={grantId}
          questionId={questionId}
          onSaved={onConfirmationSaved}
          onPrepare={onPrepare}
          onFallback={onOpenConfirmation}
        />
      ) : condition.action === "user_confirmation" && questionId ? (
        <section className="mt-3 rounded-xl border border-brand-tint bg-surface-brand px-3.5 py-3.5 sm:px-4">
          <p className="text-xs font-extrabold text-brand">이 공고에서 바로 확인</p>
          <p className="mt-1.5 text-[15px] leading-6 font-extrabold text-ink">
            이 조건에 답하면 지원 가능 여부를 다시 확인해요.
          </p>
          <Button type="button" size="sm" onClick={onOpenConfirmation} className="mt-3">
            회사 정보를 저장하고 답하기
          </Button>
        </section>
      ) : null}
      {condition.action === "admin_source_review" && condition.pending ? (
        <div className="mt-3 rounded-xl bg-surface-soft px-3.5 py-3 text-[13px] leading-5 text-text-nav">
          <p className="font-bold text-ink">이 조건은 판단 기준을 확인하고 있어요.</p>
          <p className="mt-1">회사 정보만으로 확정할 수 없어, 창업노트가 원문 기준을 검수한 뒤 답변 버튼을 열어요.</p>
        </div>
      ) : null}
    </article>
  );
}

function ConditionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold text-text-tertiary">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-text-nav">{value}</dd>
    </div>
  );
}

function conditionActionText(
  condition: ExplainedCondition,
  canConfirm: boolean,
  inlineAnswer: boolean,
  hasInlineProfile: boolean,
  hasInlineConfirmation: boolean,
): string {
  if (condition.trace.result === "pass") return "추가로 할 일이 없어요.";
  if (condition.trace.result === "fail") return "공고 원문에서 불일치 근거와 예외 조건을 확인해 주세요.";
  if (condition.action === "company_profile" && hasInlineProfile) return "아래에서 해당하는 회사 정보를 선택해 주세요.";
  if (condition.action === "company_profile") return "이 조건과 비교할 회사 정보를 입력해 주세요.";
  if (condition.action === "user_confirmation" && hasInlineConfirmation) return "아래 질문에 바로 답해 주세요.";
  if (condition.action === "user_confirmation" && inlineAnswer) return "아래 빠른 확인에서 바로 답해 주세요.";
  if (condition.action === "user_confirmation" && canConfirm) return "아래 질문에 답해 주세요.";
  if (condition.action === "user_confirmation") return "현재 답할 수 있는 검수 질문이 없어 원문 근거를 확인해야 해요.";
  if (condition.asksUser) return "공고 상세의 원문 근거에서 해당 여부를 확인해 주세요.";
  return "공고 상세에서 원문 근거를 확인해 주세요.";
}
