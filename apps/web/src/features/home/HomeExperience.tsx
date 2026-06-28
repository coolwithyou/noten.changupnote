"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  ActionResult,
  CompanyProfile,
  LandingGrantBanner,
  LandingGrantData,
  LandingGrantStats,
  MatchCard,
  TeaserRequest,
  TeaserResult,
} from "@cunote/contracts";
import { KOREA_REGION_OPTIONS } from "@/lib/regions";

type EntryMode = "active" | "preliminary";

const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";

interface HomeExperienceProps {
  landingData: LandingGrantData;
}

export function HomeExperience({ landingData }: HomeExperienceProps) {
  const [bizNo, setBizNo] = useState("");
  const [entryMode, setEntryMode] = useState<EntryMode>("active");
  const [regionCode, setRegionCode] = useState("41");
  const [founderAge, setFounderAge] = useState("");
  const [industry, setIndustry] = useState("");
  const [bannerIndex, setBannerIndex] = useState(0);
  const [teaser, setTeaser] = useState<TeaserResult | null>(null);
  const [lastTeaserRequest, setLastTeaserRequest] = useState<TeaserRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const topMatches = useMemo(() => teaser?.matches.slice(0, 4) ?? [], [teaser]);
  const banners = landingData.banners;
  const activeBanner = banners[bannerIndex] ?? banners[0] ?? null;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("resumeCompany") !== "1") return;

    const pending = readPendingTeaserRequest();
    clearResumeFlag(params);
    if (!pending) return;

    void createCompanyAndOpenDashboard(pending);
  }, []);

  useEffect(() => {
    if (bannerIndex >= banners.length) setBannerIndex(0);
  }, [bannerIndex, banners.length]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    const requestBody = buildTeaserRequest({
      mode: entryMode,
      bizNo,
      regionCode,
      founderAge,
      industry,
    });
    try {
      const response = await fetch("/api/web/teaser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json() as ActionResult<TeaserResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "지원사업 티저를 만들지 못했습니다.");
      }
      setTeaser(payload.data);
      setLastTeaserRequest(requestBody);
      if (entryMode === "active") setBizNo("");
    } catch (caught) {
      setTeaser(null);
      setLastTeaserRequest(null);
      setError(caught instanceof Error ? caught.message : "지원사업 티저를 만들지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }

  async function saveAndOpenDashboard() {
    if (!lastTeaserRequest) return;
    await createCompanyAndOpenDashboard(lastTeaserRequest);
  }

  async function createCompanyAndOpenDashboard(requestBody: TeaserRequest) {
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/web/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json() as ActionResult<{ currentCompanyId: string }>;
      if (response.status === 401 && payload.error?.code === "auth_required") {
        persistPendingTeaserRequest(requestBody);
        redirectToLoginForDashboard();
        return;
      }
      if (!response.ok || !payload.ok || !payload.data?.currentCompanyId) {
        throw new Error(payload.error?.message ?? "기회 맵으로 이어갈 회사 프로필을 저장하지 못했습니다.");
      }
      window.location.assign("/dashboard");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "기회 맵으로 이동하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="service-shell">
      <header className="service-nav">
        <a className="brand-mark" href="/" aria-label="창업노트 홈">
          <span className="brand-symbol" aria-hidden="true">C</span>
          <span>창업노트</span>
        </a>
        <nav className="service-links">
          <a href="/dashboard">기회 맵</a>
          <a href="/internal/live-match">내부 검증 콘솔</a>
        </nav>
      </header>

      <section className="hero-workspace">
        <div className="hero-copy">
          <p className="eyebrow">지원사업 매칭</p>
          <h1>내 사업자가 지금 열 수 있는 기회를 확인합니다.</h1>
          <p className="hero-subcopy">
            사업자번호 또는 예비창업 프로필로 K-Startup과 기업마당 공고를 훑고, 적격과 확인 필요를 분리합니다.
          </p>

          <div className="stats-strip" aria-label="현재 지원사업 집계">
            <Metric label="전체 지원사업" value={`${landingData.stats.totalCount.toLocaleString("ko-KR")}건`} />
            <Metric label="현재 지원 가능" value={`${landingData.stats.activeCount.toLocaleString("ko-KR")}건`} />
            <Metric label="마감 임박" value={`${landingData.stats.deadlineSoonCount.toLocaleString("ko-KR")}건`} />
            <Metric label="첨부 아카이브" value={`${landingData.stats.archivedAttachmentCount.toLocaleString("ko-KR")}건`} />
          </div>

          <form className="biz-form" onSubmit={submit}>
            <div className="entry-mode-tabs" role="tablist" aria-label="기업 상태">
              <button
                type="button"
                className={entryMode === "active" ? "active" : ""}
                aria-selected={entryMode === "active"}
                onClick={() => {
                  setEntryMode("active");
                  setError(null);
                }}
              >
                기창업
              </button>
              <button
                type="button"
                className={entryMode === "preliminary" ? "active" : ""}
                aria-selected={entryMode === "preliminary"}
                onClick={() => {
                  setEntryMode("preliminary");
                  setError(null);
                }}
              >
                예비창업
              </button>
            </div>

            {entryMode === "active" ? (
              <>
                <label htmlFor="bizNo">사업자번호 10자리</label>
                <div className="biz-input-row">
                  <input
                    id="bizNo"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="0000000000"
                    value={bizNo}
                    maxLength={12}
                    onChange={(event) => setBizNo(formatBizNoInput(event.target.value))}
                  />
                  <button type="submit" disabled={isLoading}>
                    {isLoading ? "확인 중" : "내 지원사업 확인"}
                  </button>
                </div>
                <p className="form-note">결과 화면에는 사업자번호 원문을 표시하지 않습니다.</p>
              </>
            ) : (
              <>
                <div className="preliminary-grid">
                  <label htmlFor="preRegion">
                    지역
                    <select
                      id="preRegion"
                      value={regionCode}
                      onChange={(event) => setRegionCode(event.currentTarget.value)}
                    >
                      {KOREA_REGION_OPTIONS.map((region) => (
                        <option key={region.code} value={region.code}>{region.label}</option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor="founderAge">
                    대표자 나이
                    <input
                      id="founderAge"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="35"
                      value={founderAge}
                      maxLength={3}
                      onChange={(event) => setFounderAge(event.currentTarget.value.replace(/\D/g, "").slice(0, 3))}
                    />
                  </label>
                  <label htmlFor="industry">
                    예정 업종
                    <input
                      id="industry"
                      autoComplete="off"
                      placeholder="ICT"
                      value={industry}
                      onChange={(event) => setIndustry(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <button className="preliminary-submit" type="submit" disabled={isLoading}>
                  {isLoading ? "확인 중" : "예비창업 기회 확인"}
                </button>
                <p className="form-note">예비창업 프로필은 자동 보강 없이 수기 입력 기준으로만 계산합니다.</p>
              </>
            )}
            {error ? <p className="form-error">{error}</p> : null}
          </form>
        </div>

        <OpportunityPreview stats={landingData.stats} teaser={teaser} />
      </section>

      <GrantCarousel
        banners={banners}
        activeBanner={activeBanner}
        activeIndex={bannerIndex}
        onPrevious={() => setBannerIndex((current) => current <= 0 ? Math.max(banners.length - 1, 0) : current - 1)}
        onNext={() => setBannerIndex((current) => banners.length === 0 ? 0 : (current + 1) % banners.length)}
        onSelect={setBannerIndex}
      />

      {teaser ? (
        <section className="teaser-section" aria-live="polite">
          <div className="teaser-header">
            <div>
              <p className="eyebrow">1차 매칭 티저</p>
              <h2>{profileHeadline(teaser)} 기준 결과</h2>
            </div>
            <div className="teaser-actions">
              <span className="privacy-pill">PII 비표시</span>
              <button className="dashboard-link" type="button" onClick={saveAndOpenDashboard} disabled={isSaving}>
                {isSaving ? "저장 중" : "기회 맵 보기"}
              </button>
            </div>
          </div>

          <div className="teaser-summary">
            <div className="result-number primary">
              <span>지금 적격</span>
              <strong>{teaser.counts.eligible.toLocaleString("ko-KR")}건</strong>
              <small>확정 합계 {formatMoney(teaser.estimatedMaxAmount)}</small>
            </div>
            <div className="result-number">
              <span>확인 필요</span>
              <strong>{teaser.counts.conditional.toLocaleString("ko-KR")}건</strong>
              <small>확인 시 추가 {formatMoney(teaser.conditionalUpside)}</small>
            </div>
            <div className="result-number">
              <span>마감 임박</span>
              <strong>{teaser.counts.deadlineSoon.toLocaleString("ko-KR")}건</strong>
              <small>오늘 기준 D-7 이내</small>
            </div>
          </div>

          <div className="match-preview-list">
            {topMatches.map((match) => (
              <MatchPreview key={match.grantId} match={match} />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function GrantCarousel({
  banners,
  activeBanner,
  activeIndex,
  onPrevious,
  onNext,
  onSelect,
}: {
  banners: LandingGrantBanner[];
  activeBanner: LandingGrantBanner | null;
  activeIndex: number;
  onPrevious: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
}) {
  if (!activeBanner) return null;
  const href = activeBanner.url ?? `/grants/${encodeURIComponent(activeBanner.grantId)}`;
  const isExternal = Boolean(activeBanner.url);

  return (
    <section className="grant-carousel-section" aria-label="현재 지원 가능한 사업">
      <div className="grant-carousel-header">
        <div>
          <p className="eyebrow">현재 지원 가능</p>
          <h2>지금 열려 있는 지원사업</h2>
        </div>
        <div className="carousel-controls">
          <button type="button" onClick={onPrevious} aria-label="이전 지원사업">
            ‹
          </button>
          <span>{activeIndex + 1} / {banners.length}</span>
          <button type="button" onClick={onNext} aria-label="다음 지원사업">
            ›
          </button>
        </div>
      </div>

      <article className="grant-carousel-banner">
        <div className="banner-main">
          <div className="banner-kicker">
            <span>{sourceLabel(activeBanner.source)}</span>
            <span>{statusLabel(activeBanner.status)}</span>
            <span>{formatDday(activeBanner.dDay)}</span>
          </div>
          <h3>{activeBanner.title}</h3>
          <p>
            {[activeBanner.agency, activeBanner.category, formatRegions(activeBanner.regions)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="banner-side">
          <div>
            <span>지원금</span>
            <strong>{formatMoney(activeBanner.supportAmountMax)}</strong>
          </div>
          <div>
            <span>접수 마감</span>
            <strong>{formatDate(activeBanner.applyEnd)}</strong>
          </div>
          <a
            href={href}
            {...(isExternal ? { target: "_blank", rel: "noreferrer" } : {})}
          >
            공고 보기
          </a>
        </div>
      </article>

      <div className="grant-carousel-rail" role="tablist" aria-label="지원사업 배너 목록">
        {banners.map((banner, index) => (
          <button
            key={`${banner.source}:${banner.sourceId}`}
            type="button"
            className={index === activeIndex ? "active" : ""}
            onClick={() => onSelect(index)}
            aria-selected={index === activeIndex}
          >
            <span>{formatDday(banner.dDay)}</span>
            <strong>{banner.title}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

function OpportunityPreview({ stats, teaser }: { stats: LandingGrantStats; teaser: TeaserResult | null }) {
  const eligible = teaser?.counts.eligible ?? 0;
  const conditional = teaser?.counts.conditional ?? stats.unknownCount;
  const deadline = teaser?.counts.deadlineSoon ?? stats.deadlineSoonCount;

  return (
    <div className="opportunity-board" aria-label="기회 맵 미리보기">
      <div className="board-header">
        <span>Opportunity Map</span>
        <strong>{teaser ? "개인화됨" : `${stats.sourceCount}개 소스`}</strong>
      </div>
      <div className="board-lane active">
        <span className="lane-dot" />
        <div>
          <strong>지금 받을 수 있어요</strong>
          <span>{(eligible || stats.activeCount).toLocaleString("ko-KR")}건 후보</span>
        </div>
      </div>
      <div className="board-lane conditional">
        <span className="lane-dot" />
        <div>
          <strong>확인이 필요해요</strong>
          <span>{conditional.toLocaleString("ko-KR")}건 조건부</span>
        </div>
      </div>
      <div className="board-lane urgent">
        <span className="lane-dot" />
        <div>
          <strong>곧 닫혀요</strong>
          <span>{deadline.toLocaleString("ko-KR")}건 마감 임박</span>
        </div>
      </div>
      <div className="board-axis" aria-hidden="true">
        <span>지금</span>
        <span>준비</span>
        <span>마감</span>
      </div>
    </div>
  );
}

function MatchPreview({ match }: { match: MatchCard }) {
  return (
    <article className="match-preview-card">
      <div>
        <span className={`match-status ${match.eligibility}`}>{eligibilityLabel(match.eligibility)}</span>
        <h3>{match.title}</h3>
        <p>{match.ruleTrace.slice(0, 2).map((trace) => trace.label).join(" / ") || "조건 확인 필요"}</p>
      </div>
      <div className="match-score">
        <strong>{match.fitScore}</strong>
        <span>{match.dDay === null ? "일정 확인" : match.dDay < 0 ? "마감 확인" : `D-${match.dDay}`}</span>
      </div>
    </article>
  );
}

function formatBizNoInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 10);
}

function buildTeaserRequest(input: {
  mode: EntryMode;
  bizNo: string;
  regionCode: string;
  founderAge: string;
  industry: string;
}): TeaserRequest {
  if (input.mode === "active") return { bizNo: input.bizNo };
  return { profile: buildPreliminaryProfile(input) };
}

function buildPreliminaryProfile(input: {
  regionCode: string;
  founderAge: string;
  industry: string;
}): CompanyProfile {
  const region = KOREA_REGION_OPTIONS.find((candidate) => candidate.code === input.regionCode) ?? KOREA_REGION_OPTIONS[0];
  const age = Number(input.founderAge);
  const industry = input.industry.trim();
  const confidence: NonNullable<CompanyProfile["confidence"]> = {
    region: 0.55,
    biz_age: 0.45,
  };
  if (Number.isFinite(age) && age > 0) confidence.founder_age = 0.55;
  if (industry) confidence.industry = 0.35;

  const profile: CompanyProfile = {
    is_preliminary: true,
    region: { code: region.code, label: region.label },
    confidence,
  };
  if (Number.isFinite(age) && age > 0) profile.founder_age = Math.floor(age);
  if (industry) profile.industries = [industry];
  return profile;
}

function persistPendingTeaserRequest(request: TeaserRequest) {
  try {
    window.sessionStorage.setItem(PENDING_TEASER_STORAGE_KEY, JSON.stringify(request));
  } catch {
    // Storage can be unavailable in private contexts; login still proceeds.
  }
}

function readPendingTeaserRequest(): TeaserRequest | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_TEASER_STORAGE_KEY);
    window.sessionStorage.removeItem(PENDING_TEASER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as TeaserRequest : null;
  } catch {
    return null;
  }
}

function redirectToLoginForDashboard() {
  const params = new URLSearchParams({ callbackUrl: "/?resumeCompany=1" });
  window.location.assign(`/login?${params.toString()}`);
}

function clearResumeFlag(params: URLSearchParams) {
  params.delete("resumeCompany");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
}

function profileHeadline(teaser: TeaserResult): string {
  const industry = teaser.attributes.industry.slice(0, 2).join(", ");
  const parts = [
    teaser.attributes.region,
    teaser.attributes.size,
    teaser.attributes.bizAgeMonths === null ? null : `업력 ${Math.floor(teaser.attributes.bizAgeMonths / 12)}년`,
    industry || null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "입력한 프로필";
}

function formatMoney(value: number): string {
  if (value <= 0) return "금액 미확인";
  if (value >= 100_000_000) return `${Math.round(value / 100_000_000).toLocaleString("ko-KR")}억원`;
  if (value >= 10_000) return `${Math.round(value / 10_000).toLocaleString("ko-KR")}만원`;
  return `${value.toLocaleString("ko-KR")}원`;
}

function sourceLabel(source: LandingGrantBanner["source"]): string {
  if (source === "kstartup") return "K-Startup";
  if (source === "bizinfo") return "기업마당";
  return "행사";
}

function statusLabel(status: LandingGrantBanner["status"]): string {
  if (status === "open") return "접수중";
  if (status === "upcoming") return "접수예정";
  if (status === "unknown") return "일정확인";
  return "마감";
}

function formatDday(value: number | null): string {
  if (value === null) return "상시";
  if (value < 0) return "마감 확인";
  if (value === 0) return "D-Day";
  return `D-${value}`;
}

function formatDate(value: string | null): string {
  if (!value) return "상시/확인 필요";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatRegions(regions: string[]): string | null {
  if (regions.length === 0) return null;
  if (regions.includes("nationwide")) return "전국";
  return regions
    .slice(0, 2)
    .map((code) => KOREA_REGION_OPTIONS.find((region) => region.code === code)?.label ?? code)
    .join(", ");
}

function eligibilityLabel(value: MatchCard["eligibility"]): string {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "확인 필요";
  return "부적격";
}
