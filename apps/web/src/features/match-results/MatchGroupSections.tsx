"use client";

import { useState, type ReactNode } from "react";
import type { GrantConfirmationSubmitResult, MatchCard } from "@cunote/contracts";
import { explainMatch, projectDiscoveryCard } from "@cunote/core";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { withCompanyContext } from "@/lib/navigation/companyContext";
import { DiscoverySelectionsPanel } from "./DiscoverySelectionsPanel";
import { DdayText, SourceCaption } from "./GrantCardParts";
import { GrantCardMenu } from "./GrantCardMenu";
import { GrantListRow } from "./GrantListRow";
import { GrantSummaryCard } from "./GrantSummaryCard";
import { InlineGrantConfirmation } from "./InlineGrantConfirmation";
import { MatchSection } from "./MatchSection";
import {
  discoveryReasonLabel,
  matchConditionStatus,
  matchDetailHref,
  matchDiscoveryCaption,
  type MatchConditionStatus,
  type MatchDisplayGroups,
} from "./logic";
import { buildSupportSummary } from "./support-summary";

/** 목록 상단 한 줄 안내(디자인 01). 제외는 확인된 필수조건 불일치뿐임을 밝힌다. */
export const EXCLUSION_POLICY_NOTE =
  "확인한 필수조건이 맞지 않는 공고만 제외했어요. 우대 조건·업종 키워드·빈 정보는 제외 사유가 아니에요.";
/** 살펴볼 공고 기본 노출 장수(디자인 2열 × 3줄). */
export const DEFAULT_VISIBLE_OPEN = 6;
export const EXCLUDED_SECTION_DESCRIPTION =
  "현재 확인한 필수조건 불일치로 제외한 공고입니다. 마감한 공고는 검토 목록에 포함하지 않습니다.";
/** 접수 기간을 원문에서 확인하지 못한 카드의 메타 줄 문구(디자인 01 "공고 조건 확인" 행). */
const PERIOD_UNCONFIRMED_META = "접수 기간 원문 미확인";

const WAIT_STATUS: MatchConditionStatus = { kind: "wait", label: "검토 준비 중", frac: null };
const SOURCE_STATUS: MatchConditionStatus = { kind: "source", label: "원문 확인 필요", frac: null };

export interface MatchGroupSectionsProps {
  groups: MatchDisplayGroups;
  companyId?: string | null;
  virtualBizNo?: string | null;
  newGrantIds?: ReadonlySet<string>;
  /** 인라인 답변이 불가능할 때(익명·질문 미결속) 확인 시트 또는 회사 저장 경계로 보낸다. */
  onOpenConfirmation: (match: MatchCard) => void;
  onConfirmationSaved?: ((result: GrantConfirmationSubmitResult) => void) | undefined;
  onPrepare: (grantId: string) => void;
  /** "공고 보기"·제목 클릭 시 여정 기록(detail_open). */
  onDetailOpen?: ((match: MatchCard) => void) | undefined;
  /** 모든 그룹이 비었을 때의 안내. 지정하지 않으면 아무것도 그리지 않는다. */
  emptyCopy?: string;
  /** 마지막 섹션 뒤에 붙는 슬롯(페이지네이션 버튼 등). */
  children?: ReactNode;
}

/**
 * 기회 맵 공통 화면(디자인 01) — 익명 `/matches`와 로그인 `/dashboard`가 같은 순서·문구로 그린다.
 * 0 안내 → 1 살펴볼 공고(2열) → 2 질문 하나로 지원 여부 확인(2열+질문 박스) → 3 회사 정보 추가 확인 →
 * 4 회사 정보를 더 확인할 후보(접기) → 5 공고 조건 확인 → 6·7 다시 살펴볼/제외된 공고 → 8 접수 예정.
 * 빈 섹션은 그리지 않는다.
 */
export function MatchGroupSections({
  groups,
  companyId = null,
  virtualBizNo = null,
  newGrantIds,
  onOpenConfirmation,
  onConfirmationSaved,
  onPrepare,
  onDetailOpen,
  emptyCopy,
  children,
}: MatchGroupSectionsProps) {
  const [showAllOpen, setShowAllOpen] = useState(false);
  const visibleOpen = showAllOpen ? groups.open : groups.open.slice(0, DEFAULT_VISIBLE_OPEN);
  const hiddenOpenCount = groups.open.length - visibleOpen.length;
  const showDiscoveryPanel = Boolean(companyId) && !virtualBizNo;
  const isEmpty = groups.open.length === 0
    && groups.oneQuestionAway.length === 0
    && groups.oneAnswer.length === 0
    && groups.preparable.length === 0
    && groups.checkSource.length === 0
    && groups.closed.length === 0
    && groups.upcoming.length === 0;

  function hrefFor(match: MatchCard): string {
    const base = matchDetailHref(match, virtualBizNo);
    return companyId ? withCompanyContext(base, companyId) : base;
  }
  /** 로그인 회사 결과에만 ⋯ 정리 메뉴를 붙인다(피드백 API가 회사 맥락을 요구). */
  function menuFor(match: MatchCard) {
    return companyId ? <GrantCardMenu grantId={match.grantId} title={match.title} /> : undefined;
  }
  function detailHandler(match: MatchCard) {
    return onDetailOpen ? () => onDetailOpen(match) : undefined;
  }
  function supportText(match: MatchCard) {
    return buildSupportSummary(match).text;
  }

  return (
    <div>
      <Alert className="mt-7 rounded-xl border-border-muted bg-surface-soft px-3.5 py-2.5">
        <AlertDescription className="text-[13px] leading-[1.55] text-text-nav">{EXCLUSION_POLICY_NOTE}</AlertDescription>
      </Alert>

      {isEmpty && emptyCopy ? (
        <Empty className="mt-[26px] min-h-40 rounded-2xl border border-border-subtle bg-surface-soft">
          <EmptyDescription>{emptyCopy}</EmptyDescription>
        </Empty>
      ) : null}

      {visibleOpen.length > 0 ? (
        <MatchSection title="살펴볼 공고" count={`표시 중 ${visibleOpen.length.toLocaleString("ko-KR")}건`}>
          <div className="grid gap-3.5 md:grid-cols-2">
            {visibleOpen.map((match) => (
              <GrantSummaryCard
                key={match.grantId}
                match={match}
                href={hrefFor(match)}
                isNew={newGrantIds?.has(match.grantId) ?? false}
                onDetailOpen={detailHandler(match)}
                menu={menuFor(match)}
              />
            ))}
          </div>
          {hiddenOpenCount > 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowAllOpen(true)}
              className="mt-3 w-full text-brand-hover"
            >
              {hiddenOpenCount.toLocaleString("ko-KR")}건 더 보기
            </Button>
          ) : null}
        </MatchSection>
      ) : null}

      {groups.oneQuestionAway.length > 0 ? (
        <MatchSection title="질문 하나로 지원 여부 확인" count={`${groups.oneQuestionAway.length.toLocaleString("ko-KR")}건`}>
          <div className="grid gap-3.5 md:grid-cols-2">
            {groups.oneQuestionAway.map((match) => (
              <GrantSummaryCard
                key={match.grantId}
                match={match}
                href={hrefFor(match)}
                isNew={newGrantIds?.has(match.grantId) ?? false}
                onDetailOpen={detailHandler(match)}
                menu={menuFor(match)}
              >
                <OneQuestionBox
                  match={match}
                  companyId={companyId}
                  onConfirmationSaved={onConfirmationSaved}
                  onPrepare={onPrepare}
                  onOpenConfirmation={onOpenConfirmation}
                />
              </GrantSummaryCard>
            ))}
          </div>
        </MatchSection>
      ) : null}

      {groups.oneAnswer.length > 0 ? (
        <MatchSection title="회사 정보 추가 확인" count={`${groups.oneAnswer.length.toLocaleString("ko-KR")}건`}>
          <div className="flex flex-col gap-2.5">
            {groups.oneAnswer.map((match) => (
              <GrantListRow
                key={match.grantId}
                match={match}
                href={hrefFor(match)}
                meta={[
                  match.agency?.trim() ? <span key="agency">{match.agency.trim()}</span> : null,
                  <DdayText key="dday" dDay={match.dDay} />,
                  <span key="support">{supportText(match)}</span>,
                ]}
                status={matchConditionStatus(match)}
                caption={explainMatch(match).summary}
                onDetailOpen={detailHandler(match)}
                menu={menuFor(match)}
              />
            ))}
          </div>
        </MatchSection>
      ) : null}

      {groups.preparable.length > 0 ? (
        <MatchSection
          title="회사 정보를 더 확인할 후보"
          count={`${groups.preparable.length.toLocaleString("ko-KR")}건`}
          collapsible
          defaultOpen
        >
          <div className="flex flex-col gap-2.5">
            {groups.preparable.map((match) => (
              <GrantListRow
                key={match.grantId}
                match={match}
                href={hrefFor(match)}
                meta={[
                  match.agency?.trim() ? <span key="agency">{match.agency.trim()}</span> : null,
                  <DdayText key="dday" dDay={match.dDay} />,
                  <span key="support">{supportText(match)}</span>,
                ]}
                status={WAIT_STATUS}
                caption={explainMatch(match).summary}
                onDetailOpen={detailHandler(match)}
                menu={menuFor(match)}
              />
            ))}
          </div>
        </MatchSection>
      ) : null}

      {groups.checkSource.length > 0 ? (
        <MatchSection title="공고 조건 확인" count={`${groups.checkSource.length.toLocaleString("ko-KR")}건`}>
          <div className="flex flex-col gap-2.5">
            {groups.checkSource.map((match) => {
              const periodUnconfirmed = projectDiscoveryCard(match).reason === "period_unconfirmed";
              return (
                <GrantListRow
                  key={match.grantId}
                  match={match}
                  href={hrefFor(match)}
                  meta={[
                    match.agency?.trim() ? <span key="agency">{match.agency.trim()}</span> : null,
                    periodUnconfirmed
                      ? <span key="period">{PERIOD_UNCONFIRMED_META}</span>
                      : <DdayText key="dday" dDay={match.dDay} />,
                    <span key="support">{supportText(match)}</span>,
                  ]}
                  status={SOURCE_STATUS}
                  statusNote={periodUnconfirmed ? matchDiscoveryCaption(match) : undefined}
                  actionLabel="공고 상세 보기"
                  onDetailOpen={detailHandler(match)}
                  menu={menuFor(match)}
                />
              );
            })}
          </div>
        </MatchSection>
      ) : null}

      {showDiscoveryPanel ? (
        <DiscoverySelectionsPanel key={companyId!} companyId={companyId!} />
      ) : groups.closed.length > 0 ? (
        <ExcludedMatchesSection matches={groups.closed} hrefFor={hrefFor} onDetailOpen={onDetailOpen} />
      ) : null}

      {groups.upcoming.length > 0 ? (
        <MatchSection title="접수 예정" count={`${groups.upcoming.length.toLocaleString("ko-KR")}건`}>
          <div className="flex flex-col gap-2.5">
            {groups.upcoming.map((match) => (
              <GrantListRow
                key={match.grantId}
                match={match}
                href={hrefFor(match)}
                meta={[
                  match.agency?.trim() ? <span key="agency">{match.agency.trim()}</span> : null,
                  <span key="support">{supportText(match)}</span>,
                ]}
                caption={matchDiscoveryCaption(match) ?? discoveryReasonLabel({ state: "upcoming", reason: "not_started" })}
                captionClassName="text-brand-hover"
                onDetailOpen={detailHandler(match)}
                menu={menuFor(match)}
              />
            ))}
          </div>
        </MatchSection>
      ) : null}

      {children}
    </div>
  );
}

/**
 * 질문 하나로 카드의 인라인 질문 박스(디자인 `.q`). 회사가 있고 저장 콜백이 있으면 기존 InlineGrantConfirmation을
 * 그대로 넣고, 익명이면 질문 문구와 "회사 정보를 저장하고 답하기" 경계 버튼만 보여 준다.
 */
function OneQuestionBox({
  match,
  companyId,
  onConfirmationSaved,
  onPrepare,
  onOpenConfirmation,
}: {
  match: MatchCard;
  companyId: string | null;
  onConfirmationSaved?: ((result: GrantConfirmationSubmitResult) => void) | undefined;
  onPrepare: (grantId: string) => void;
  onOpenConfirmation: (match: MatchCard) => void;
}) {
  const explanation = explainMatch(match);
  const question = explanation.confirmation[0];
  const questionId = explanation.confirmationReadiness.representativeQuestionId;
  const label = question?.trace.label?.trim();
  const sourceSpan = question?.trace.sourceSpan?.trim();
  const title = label || question?.requirement || "공고별 확인 질문";
  const sourceQuote = sourceSpan && sourceSpan !== title ? `원문 “${sourceSpan}”` : null;

  if (companyId && onConfirmationSaved && questionId) {
    return (
      <InlineGrantConfirmation
        companyId={companyId}
        grantId={match.grantId}
        questionId={questionId}
        onSaved={onConfirmationSaved}
        onPrepare={onPrepare}
        onFallback={() => onOpenConfirmation(match)}
        className="mt-0.5 rounded-xl border-border-brand-soft px-3.5 py-3 sm:px-3.5"
        footer={sourceQuote ? <SourceCaption className="mt-2 block">{sourceQuote}</SourceCaption> : null}
      />
    );
  }

  return (
    <div className="mt-0.5 flex flex-col gap-2 rounded-xl border border-border-brand-soft bg-surface-brand px-3.5 py-3">
      <p className="text-sm leading-[1.5] font-bold text-ink-strong">{title}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="sm" onClick={() => onOpenConfirmation(match)}>
          회사 정보를 저장하고 답하기
        </Button>
      </div>
      {sourceQuote ? <SourceCaption>{sourceQuote}</SourceCaption> : null}
    </div>
  );
}

/**
 * 익명 결과의 "제외된 공고 보기"(디자인 `.exl/.exr`). 회사가 있으면 서버 저장 선택이 있는
 * DiscoverySelectionsPanel이 대신 그리므로, 여기에는 복원 버튼이 없다.
 */
export function ExcludedMatchesSection({
  matches,
  hrefFor,
  onDetailOpen,
  defaultOpen = false,
}: {
  matches: readonly MatchCard[];
  hrefFor: (match: MatchCard) => string;
  onDetailOpen?: ((match: MatchCard) => void) | undefined;
  defaultOpen?: boolean;
}) {
  return (
    <MatchSection
      title={`제외된 공고 보기 · ${matches.length.toLocaleString("ko-KR")}건`}
      collapsible
      defaultOpen={defaultOpen}
      description={EXCLUDED_SECTION_DESCRIPTION}
    >
      <div className="overflow-hidden rounded-2xl border border-border-card bg-card">
        {matches.map((match) => {
          const decision = projectDiscoveryCard(match);
          const failedTraces = match.ruleTrace
            .filter((trace) => trace.result === "fail" && (trace.kind === "required" || trace.kind === "exclusion"))
            .filter((trace) => decision.criterionIds.length === 0
              || (trace.criterionId !== undefined && decision.criterionIds.includes(trace.criterionId)));
          return (
            <div
              key={match.grantId}
              data-product-grant={match.grantId}
              className="flex flex-wrap items-start justify-between gap-4 border-t border-border-subtle px-5 py-3.5 first:border-t-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <a
                  href={hrefFor(match)}
                  onClick={onDetailOpen ? () => onDetailOpen(match) : undefined}
                  className="text-[14.5px] font-bold text-ink-strong no-underline hover:text-brand-hover"
                >
                  {match.title}
                </a>
                <span className="text-[13px] text-text-secondary">{discoveryReasonLabel(decision)}</span>
                {failedTraces.map((trace, index) => {
                  const quote = trace.sourceSpan?.trim() || trace.label;
                  const companyValue = trace.companyValue?.trim();
                  return (
                    <span key={`${trace.criterionId ?? trace.dimension}:${index}`} className="text-[12.5px] text-text-tertiary">
                      원문 “{quote}”{companyValue ? ` · 회사 정보: ${companyValue}` : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </MatchSection>
  );
}
