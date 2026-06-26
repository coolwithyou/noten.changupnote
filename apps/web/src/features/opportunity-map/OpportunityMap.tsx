"use client";

import { useState } from "react";
import type { ActionResult, MatchCard, OpportunityBucket } from "@cunote/contracts";
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
    <section className="dashboard-panel opportunity-panel" aria-labelledby="opportunity-map-title">
      <div className="panel-heading inline">
        <div>
          <span className="eyebrow">기회 맵</span>
          <h2 id="opportunity-map-title">지원사업 상태 보드</h2>
        </div>
        <div className="opportunity-controls" aria-label="지원사업 필터와 정렬">
          <div className="match-filter-group" aria-label="상태 필터">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={status === filter.value ? "active" : ""}
                disabled={requestState === "loading" || requestState === "loadingMore"}
                onClick={() => updateStatus(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="match-sort-control" htmlFor="match-sort">
            정렬
            <select
              id="match-sort"
              value={sort}
              disabled={requestState === "loading" || requestState === "loadingMore"}
              onChange={(event) => updateSort(event.currentTarget.value as MatchSortKey)}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="opportunity-result-meta">
        <span>{total.toLocaleString("ko-KR")}건 중 {visibleMatches.length.toLocaleString("ko-KR")}건 표시</span>
        {status !== "all" || sort !== "recommended" ? (
          <button
            type="button"
            className="match-reset-button"
            disabled={requestState === "loading" || requestState === "loadingMore"}
            onClick={resetMatches}
          >
            초기화
          </button>
        ) : null}
      </div>
      {error ? <p className="match-list-status error" aria-live="polite">{error}</p> : null}
      {requestState === "loading" ? <p className="match-list-status" aria-live="polite">매칭 결과를 갱신하는 중입니다.</p> : null}
      <div className="opportunity-lanes">
        {BUCKETS.map((bucket) => {
          const bucketMatches = visibleMatches.filter((match) => match.bucket === bucket.bucket);
          return (
            <section key={bucket.bucket} className={`opportunity-lane ${bucket.bucket}`}>
              <header>
                <div>
                  <h3>{bucket.title}</h3>
                  <p>{bucket.description}</p>
                </div>
                <strong>{bucketMatches.length}</strong>
              </header>
              <div className="lane-card-list">
                {bucketMatches.slice(0, 4).map((match) => (
                  <OpportunityCard key={match.grantId} match={match} />
                ))}
                {bucketMatches.length === 0 ? <p className="panel-empty">해당 공고가 없습니다.</p> : null}
              </div>
            </section>
          );
        })}
      </div>
      {ineligibleMatches.length > 0 ? <IneligibleDisclosure matches={ineligibleMatches} /> : null}
      {hasMore ? (
        <div className="match-load-more-row">
          <button
            type="button"
            className="match-load-more"
            disabled={requestState === "loadingMore" || requestState === "loading"}
            onClick={() => loadMatches({ nextCursor: cursor, mode: "append" })}
          >
            {requestState === "loadingMore" ? "불러오는 중" : "더 보기"}
          </button>
        </div>
      ) : null}
    </section>
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
  const content = (
    <>
      <div className="card-topline">
        <span className={`match-status ${match.eligibility}`}>{eligibilityLabel(match.eligibility)}</span>
        <span>{match.dDay === null ? "일정 확인" : match.dDay < 0 ? "마감 확인" : `D-${match.dDay}`}</span>
      </div>
      <h4>{match.title}</h4>
      <p>{match.ruleTrace.slice(0, 2).map((trace) => trace.label).join(" / ") || "조건 확인 필요"}</p>
      {unlock ? (
        <span className="card-unlock">
          {unlock.detail}{unlock.etaDate ? ` · ${formatEtaDate(unlock.etaDate)}` : ""}
        </span>
      ) : null}
      <div className="card-foot">
        <span>{match.agency ?? "기관 미확인"}</span>
        <strong>적합도 {match.fitScore}</strong>
      </div>
      <span className="card-amount">{formatSupportAmount(match.supportAmount)}</span>
    </>
  );

  return (
    <article className="opportunity-card">
      {match.detailUrl ? (
        <a className="opportunity-card-link" href={match.detailUrl} aria-label={`${match.title} 신청 준비 시트 보기`}>
          {content}
        </a>
      ) : (
        <div className="opportunity-card-link">{content}</div>
      )}
      <MatchFeedbackControls grantId={match.grantId} title={match.title} />
    </article>
  );
}

function IneligibleDisclosure({ matches }: { matches: MatchCard[] }) {
  return (
    <details className="ineligible-disclosure">
      <summary>
        <span>부적격 사유</span>
        <strong>{matches.length}건</strong>
      </summary>
      <div className="ineligible-list">
        {matches.slice(0, 6).map((match) => (
          <article className="ineligible-item" key={match.grantId}>
            <div>
              <span>{match.agency ?? "기관 미확인"}</span>
              <h4>{match.title}</h4>
            </div>
            <p>{ineligibleReason(match)}</p>
          </article>
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

function eligibilityLabel(value: MatchCard["eligibility"]): string {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "확인 필요";
  return "부적격";
}

function formatSupportAmount(amount: MatchCard["supportAmount"]): string {
  if (amount.label) return amount.label;
  if (!amount.max) return "금액 미확인";
  return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
}

function formatEtaDate(value: string): string {
  return value.replaceAll("-", ".");
}
