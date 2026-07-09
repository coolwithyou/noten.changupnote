"use client";

import { useState } from "react";
import { StatusBadge, eligibilityTone } from "@/components/app/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { WRITE_SUPPORT_LABELS } from "@cunote/contracts";
import type { ActionResult, MatchCard, OpportunityBucket, WriteSupportLevel } from "@cunote/contracts";
import { recordWebMatchEvent } from "@/lib/client/matchEvents";
import { MatchFeedbackControls } from "./MatchFeedbackControls";

type MatchStatusFilter = "all" | "eligible" | "conditional" | "ineligible" | "now" | "soon" | "preparable";
type MatchSortKey = "recommended" | "fit" | "deadline" | "amount";

interface MatchesPayload {
  matches: MatchCard[];
  cursor: string | null;
  hasMore: boolean;
  total: number;
}

const BUCKETS: Array<{ bucket: OpportunityBucket; title: string; description: string }> = [
  { bucket: "now", title: "지금 받을 수 있어요", description: "필수 조건이 충족된 공고" },
  { bucket: "conditional", title: "확인이 필요해요", description: "입력 또는 원문 확인이 필요한 공고" },
  { bucket: "preparable", title: "준비하면 열려요", description: "잠금 조건을 해소해야 하는 공고" },
  { bucket: "soon", title: "곧 받을 수 있어요", description: "시간 조건으로 열릴 가능성" },
];

const STATUS_FILTERS: Array<{ value: MatchStatusFilter; label: string }> = [
  { value: "all", label: "전체" },
  { value: "eligible", label: "적격" },
  { value: "conditional", label: "확인 필요" },
  { value: "ineligible", label: "부적격" },
  { value: "now", label: "지금" },
  { value: "preparable", label: "준비" },
  { value: "soon", label: "예정" },
];

const SORT_OPTIONS: Array<{ value: MatchSortKey; label: string }> = [
  { value: "recommended", label: "추천순" },
  { value: "fit", label: "적합도순" },
  { value: "deadline", label: "마감순" },
  { value: "amount", label: "지원금순" },
];
const SORT_SELECT_ITEMS = SORT_OPTIONS.map((option) => ({ label: option.label, value: option.value }));

export function OpportunityMap({ matches }: { matches: MatchCard[] }) {
  const [visibleMatches, setVisibleMatches] = useState(matches);
  const [status, setStatus] = useState<MatchStatusFilter>("all");
  const [sort, setSort] = useState<MatchSortKey>("recommended");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(matches.length);
  const [requestState, setRequestState] = useState<"idle" | "loading" | "loadingMore" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const ineligibleMatches = visibleMatches.filter((match) => match.eligibility === "ineligible");

  return (
    <Card aria-labelledby="opportunity-map-title">
      <CardHeader className="gap-4">
        <div>
          <CardTitle id="opportunity-map-title">지원사업 상태 보드</CardTitle>
          <CardDescription>조건 충족, 확인 필요, 준비 가능 공고를 한 화면에서 봅니다.</CardDescription>
        </div>
        <CardAction className="relative col-start-auto row-start-auto justify-self-auto lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:justify-self-end">
          <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-end" aria-label="지원사업 필터와 정렬">
          <ToggleGroup
            className="max-w-full overflow-x-auto"
            aria-label="상태 필터"
            value={[status]}
            onValueChange={(value) => {
              const nextStatus = value[0] as MatchStatusFilter | undefined;
              if (nextStatus) updateStatus(nextStatus);
            }}
            variant="outline"
            size="sm"
            spacing={1}
          >
            {STATUS_FILTERS.map((filter) => (
              <ToggleGroupItem
                key={filter.value}
                disabled={requestState === "loading" || requestState === "loadingMore"}
                value={filter.value}
                aria-label={filter.label}
              >
                {filter.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">정렬</span>
            <Select
              items={SORT_SELECT_ITEMS}
              value={sort}
              disabled={requestState === "loading" || requestState === "loadingMore"}
              onValueChange={(value) => {
                if (typeof value === "string") updateSort(value as MatchSortKey);
              }}
            >
              <SelectTrigger id="match-sort" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SORT_SELECT_ITEMS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <span>
          {total.toLocaleString("ko-KR")}건 중 {visibleMatches.length.toLocaleString("ko-KR")}건 표시
        </span>
        {status !== "all" || sort !== "recommended" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={requestState === "loading" || requestState === "loadingMore"}
            onClick={resetMatches}
          >
            초기화
          </Button>
        ) : null}
      </div>
      {error ? (
        <Alert variant="destructive" aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {requestState === "loading" ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Spinner data-icon="inline-start" /> 매칭 결과를 갱신하는 중입니다.
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
        {BUCKETS.map((bucket) => {
          const bucketMatches = visibleMatches.filter((match) => match.bucket === bucket.bucket);
          return (
            <div key={bucket.bucket} className="flex min-h-96 flex-col gap-3 rounded-[var(--radius-lg)] border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-semibold leading-5 text-foreground">{bucket.title}</h3>
                  <p className="text-xs leading-5 text-muted-foreground">{bucket.description}</p>
                </div>
                <strong className="rounded-full bg-background px-2 py-0.5 text-xs font-semibold tabular-nums text-foreground ring-1 ring-border">
                  {bucketMatches.length}
                </strong>
              </div>
              <div className="flex flex-1 flex-col gap-3">
                {bucketMatches.slice(0, 4).map((match) => (
                  <OpportunityCard key={match.grantId} match={match} />
                ))}
                {bucketMatches.length === 0 ? (
                  <Empty className="min-h-48">
                    <EmptyDescription>해당 공고가 없습니다.</EmptyDescription>
                  </Empty>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {ineligibleMatches.length > 0 ? <IneligibleDisclosure matches={ineligibleMatches} /> : null}
      {hasMore ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={requestState === "loadingMore" || requestState === "loading"}
            onClick={() => loadMatches({ nextCursor: cursor, mode: "append" })}
          >
            {requestState === "loadingMore" ? <Spinner data-icon="inline-start" /> : null}
            {requestState === "loadingMore" ? "불러오는 중" : "더 보기"}
          </Button>
        </div>
      ) : null}
      </CardContent>
    </Card>
  );

  function updateStatus(nextStatus: MatchStatusFilter) {
    setStatus(nextStatus);
    void loadMatches({ nextStatus, nextSort: sort, nextCursor: null, mode: "replace" });
  }

  function updateSort(nextSort: MatchSortKey) {
    setSort(nextSort);
    void loadMatches({ nextStatus: status, nextSort, nextCursor: null, mode: "replace" });
  }

  function resetMatches() {
    setStatus("all");
    setSort("recommended");
    setVisibleMatches(matches);
    setTotal(matches.length);
    setCursor(null);
    setHasMore(false);
    setError(null);
    setRequestState("idle");
  }

  async function loadMatches({
    nextStatus = status,
    nextSort = sort,
    nextCursor = null,
    mode,
  }: {
    nextStatus?: MatchStatusFilter;
    nextSort?: MatchSortKey;
    nextCursor?: string | null;
    mode: "replace" | "append";
  }) {
    setRequestState(mode === "append" ? "loadingMore" : "loading");
    setError(null);

    const params = new URLSearchParams({
      status: nextStatus,
      sort: nextSort,
      limit: "16",
    });
    if (nextCursor) params.set("cursor", nextCursor);

    try {
      const response = await fetch(`/api/web/matches?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json() as ActionResult<MatchesPayload>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "매칭 결과를 불러오지 못했습니다.");
      }

      setVisibleMatches((current) => (mode === "append" ? [...current, ...payload.data!.matches] : payload.data!.matches));
      setCursor(payload.data.cursor);
      setHasMore(payload.data.hasMore);
      setTotal(payload.data.total);
      setRequestState("idle");
    } catch (caught) {
      setRequestState("error");
      setError(caught instanceof Error ? caught.message : "매칭 결과를 불러오지 못했습니다.");
    }
  }
}

function OpportunityCard({ match }: { match: MatchCard }) {
  const unlock = match.ruleTrace.find((trace) => trace.unlock)?.unlock;
  const writeSupportTone = writeSupportBadgeTone(match.writeSupport);
  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <StatusBadge tone={matchEligibilityTone(match)}>
          {matchEligibilityLabel(match)}
        </StatusBadge>
        <span className="text-xs font-medium text-muted-foreground">
          {match.dDay === null ? "일정 확인" : match.dDay < 0 ? "마감 확인" : `D-${match.dDay}`}
        </span>
      </div>
      <h4 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">{match.title}</h4>
      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{matchEvidenceSummary(match)}</p>
      {writeSupportTone || match.benefits.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {writeSupportTone ? (
            <StatusBadge tone={writeSupportTone}>
              {WRITE_SUPPORT_LABELS[match.writeSupport]}
            </StatusBadge>
          ) : null}
          {match.benefits.slice(0, 2).map((benefit) => (
            <StatusBadge key={`${match.grantId}:${benefit.family}`} tone="brand">
              {benefit.label}
            </StatusBadge>
          ))}
        </div>
      ) : null}
      {unlock ? (
        <span className="rounded-[var(--radius-md)] bg-muted px-2 py-1 text-xs leading-5 text-muted-foreground">
          {unlock.detail}{unlock.etaDate ? ` · ${formatEtaDate(unlock.etaDate)}` : ""}
        </span>
      ) : null}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{match.agency ?? "기관 미확인"}</span>
        <strong className="font-semibold text-foreground">적합도 {match.fitScore}</strong>
      </div>
      <span className="text-xs font-medium text-muted-foreground">{formatSupportAmount(match.supportAmount)}</span>
    </>
  );

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border bg-background p-3 shadow-[var(--shadow-subtle)]">
      {match.detailUrl ? (
        <a
          className="flex flex-col gap-3"
          href={match.detailUrl}
          aria-label={`${match.title} 신청 준비 시트 보기`}
          onClick={() => recordWebMatchEvent({
            grantId: match.grantId,
            event: "clicked",
            rulesetVer: match.rulesetVer,
          })}
        >
          {content}
        </a>
      ) : (
        <div className="flex flex-col gap-3">{content}</div>
      )}
      <MatchFeedbackControls grantId={match.grantId} title={match.title} />
    </div>
  );
}

function IneligibleDisclosure({ matches }: { matches: MatchCard[] }) {
  return (
    <details className="rounded-[var(--radius-lg)] border bg-muted/20 p-4">
      <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-foreground">
        <span>부적격 사유</span>
        <strong className="text-muted-foreground">{matches.length}건</strong>
      </summary>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {matches.slice(0, 6).map((match) => (
          <div className="rounded-[var(--radius-lg)] border bg-background p-3" key={match.grantId}>
            <div>
              <span className="text-xs text-muted-foreground">{match.agency ?? "기관 미확인"}</span>
              <h4 className="mt-1 text-sm font-semibold leading-5 text-foreground">{match.title}</h4>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{ineligibleReason(match)}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function ineligibleReason(match: MatchCard): string {
  const reason = match.ruleTrace.find((trace) => trace.result === "fail")
    ?? match.ruleTrace.find((trace) => trace.result === "text_only")
    ?? match.ruleTrace.find((trace) => trace.result === "unknown");
  if (!reason) return "세부 조건 확인 필요";
  if (reason.companyValue) return `${reason.label} - ${reason.companyValue}`;
  if (reason.sourceSpan) return `${reason.label} - ${reason.sourceSpan}`;
  return reason.label;
}

function matchEligibilityLabel(match: MatchCard): string {
  if (isLowEvidenceEligible(match)) return "추정 적격";
  if (match.eligibility === "eligible") return "적격";
  if (match.eligibility === "conditional") return "확인 필요";
  return "부적격";
}

function matchEligibilityTone(match: MatchCard): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (isLowEvidenceEligible(match)) return "warning";
  return eligibilityTone(match.eligibility);
}

// unknown 은 배지 없음 — 매칭 화면(MatchesExperience)과 같은 규칙.
function writeSupportBadgeTone(level: WriteSupportLevel): "brand" | "neutral" | null {
  if (level === "template_fill" || level === "ai_draft") return "brand";
  if (level === "web_form_guide") return "neutral";
  return null;
}

function matchEvidenceSummary(match: MatchCard): string {
  const traceSummary = match.ruleTrace.slice(0, 2).map((trace) => trace.label).join(" / ");
  if (traceSummary) return traceSummary;
  if (isLowEvidenceEligible(match)) return "자동 확인 근거가 부족해 원문 확인이 필요합니다.";
  return "조건 확인 필요";
}

function isLowEvidenceEligible(match: MatchCard): boolean {
  return match.eligibility === "eligible" && (match.matchConfidence < 0.45 || match.ruleTrace.length === 0);
}

function formatSupportAmount(amount: MatchCard["supportAmount"]): string {
  if (amount.label) return amount.label;
  if (!amount.max) return "금액 미확인";
  return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
}

function formatEtaDate(value: string): string {
  return value.replaceAll("-", ".");
}
