"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type {
  ActionResult,
  LandingGrantBanner,
  LandingGrantData,
  LandingGrantStats,
  MatchCard,
  TeaserRequest,
  TeaserResult,
} from "@cunote/contracts";
import { MetricCard } from "@/components/app/metric-card";
import { ServiceHeader } from "@/components/app/service-header";
import { StatusBadge, eligibilityTone } from "@/components/app/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CompanyEvidenceSummary } from "@/features/company-evidence/CompanyEvidenceSummary";
import { recordLandingEvent } from "@/lib/client/landingEvents";
import { recordWebMatchEvent } from "@/lib/client/matchEvents";
import { KOREA_REGION_OPTIONS } from "@/lib/regions";
import type { HeaderUser } from "@/lib/server/auth/session";

type NewsletterCategory = {
  value: string;
  label: string;
};

const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";

const NEWSLETTER_CATEGORIES: NewsletterCategory[] = [
  { value: "rnd", label: "R&D" },
  { value: "commercialization", label: "사업화" },
  { value: "hr", label: "인건비" },
  { value: "export", label: "수출" },
  { value: "digital", label: "디지털전환" },
  { value: "small-business", label: "소상공인" },
  { value: "youth", label: "청년창업" },
];

interface HomeExperienceProps {
  landingData: LandingGrantData;
  user?: HeaderUser | null;
}

export function HomeExperience({ landingData, user = null }: HomeExperienceProps) {
  const [bizNo, setBizNo] = useState("");
  const [teaser, setTeaser] = useState<TeaserResult | null>(null);
  const [lastTeaserRequest, setLastTeaserRequest] = useState<TeaserRequest | null>(null);
  const [activeLookupBizNo, setActiveLookupBizNo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<"bizNo" | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [bannerIndex, setBannerIndex] = useState(0);
  const [newsletterCategories, setNewsletterCategories] = useState<string[]>(["rnd", "commercialization"]);
  const [newsletterEmail, setNewsletterEmail] = useState("");
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [newsletterMessage, setNewsletterMessage] = useState<string | null>(null);
  const teaserSectionRef = useRef<HTMLDivElement | null>(null);
  const teaserHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const inputStartedRef = useRef(false);
  const topMatches = useMemo(() => teaser?.matches.slice(0, 4) ?? [], [teaser]);
  const normalizedBizNo = formatBizNoInput(bizNo);
  const lookupBizNo = activeLookupBizNo ?? normalizedBizNo;
  const hasConfirmedLookup = Boolean(teaser && lastTeaserRequest?.bizNo === normalizedBizNo);
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

  useEffect(() => {
    if (!teaser) return;
    const section = teaserSectionRef.current;
    const heading = teaserHeadingRef.current;
    if (!section) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    window.setTimeout(() => heading?.focus({ preventScroll: true }), reduceMotion ? 0 : 300);
  }, [teaser]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    setIsLoading(true);
    setError(null);
    setErrorField(null);
    if (normalizedBizNo.length !== 10) {
      setError("사업자번호 10자리를 입력해주세요.");
      setErrorField("bizNo");
      setIsLoading(false);
      recordLandingEvent({
        event: "biz_no_validation_failed",
        requestId,
        inputLength: normalizedBizNo.length,
        reason: "length_not_10",
      });
      return;
    }
    const requestBody: TeaserRequest = { bizNo: normalizedBizNo };
    setActiveLookupBizNo(normalizedBizNo);
    recordLandingEvent({
      event: "teaser_submitted",
      requestId,
      inputLength: normalizedBizNo.length,
    });

    try {
      const response = await fetch("/api/web/teaser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json() as ActionResult<TeaserResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        recordLandingEvent({
          event: "teaser_failed",
          requestId,
          durationMs: performance.now() - startedAt,
          errorCode: payload.error?.code ?? `http_${response.status}`,
        });
        if (payload.error?.field === "bizNo") setErrorField("bizNo");
        throw new Error(payload.error?.message ?? "지원사업 티저를 만들지 못했습니다.");
      }
      setTeaser(payload.data);
      setLastTeaserRequest(requestBody);
      setBizNo(normalizedBizNo);
      recordLandingEvent({
        event: "teaser_succeeded",
        requestId,
        durationMs: performance.now() - startedAt,
        eligibleCount: payload.data.counts.eligible,
        conditionalCount: payload.data.counts.conditional,
        ineligibleCount: payload.data.counts.ineligible,
        deadlineSoonCount: payload.data.counts.deadlineSoon,
        hasAmount: payload.data.estimatedMaxAmount > 0 || payload.data.conditionalUpside > 0,
        avgConfidenceBucket: averageConfidenceBucket(payload.data.matches),
      });
    } catch (caught) {
      setTeaser(null);
      setLastTeaserRequest(null);
      setError(caught instanceof Error ? caught.message : "지원사업 티저를 만들지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  }

  function updateBizNoInput(value: string) {
    const nextBizNo = formatBizNoInput(value);
    setBizNo(nextBizNo);
    if (!inputStartedRef.current && nextBizNo.length > 0) {
      inputStartedRef.current = true;
      recordLandingEvent({
        event: "biz_no_input_started",
        inputLength: nextBizNo.length,
      });
    }
    if (error) {
      setError(null);
      setErrorField(null);
    }
    if (lastTeaserRequest?.bizNo && lastTeaserRequest.bizNo !== nextBizNo) {
      setTeaser(null);
      setLastTeaserRequest(null);
      setActiveLookupBizNo(null);
    }
  }

  async function saveAndOpenDashboard() {
    if (!lastTeaserRequest) return;
    recordLandingEvent(teaser ? {
      event: "dashboard_cta_clicked",
      eligibleCount: teaser.counts.eligible,
      conditionalCount: teaser.counts.conditional,
      hasAmount: teaser.estimatedMaxAmount > 0 || teaser.conditionalUpside > 0,
    } : { event: "dashboard_cta_clicked" });
    await createCompanyAndOpenDashboard(lastTeaserRequest);
  }

  function submitNewsletter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = newsletterEmail.trim();

    if (newsletterCategories.length === 0) {
      setNewsletterMessage("관심 분야를 1개 이상 선택해주세요.");
      return;
    }

    if (!email || !email.includes("@")) {
      setNewsletterMessage("알림을 받을 이메일을 입력해주세요.");
      return;
    }

    if (!newsletterConsent) {
      setNewsletterMessage("지원사업 알림 메일 수신에 동의해주세요.");
      return;
    }

    const categoryLabels = NEWSLETTER_CATEGORIES
      .filter((category) => newsletterCategories.includes(category.value))
      .map((category) => category.label)
      .join(", ");
    setNewsletterMessage(`${categoryLabels} 분야 새 공고를 ${email}로 알려드릴게요.`);
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
        recordLandingEvent({
          event: "auth_resume_started",
        });
        redirectToLoginForDashboard();
        return;
      }
      if (!response.ok || !payload.ok || !payload.data?.currentCompanyId) {
        throw new Error(payload.error?.message ?? "기회 맵으로 이어갈 회사 프로필을 저장하지 못했습니다.");
      }
      recordLandingEvent({
        event: "company_create_succeeded",
      });
      window.location.assign("/dashboard");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "기회 맵으로 이동하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="service-shell">
      <ServiceHeader
        variant="landing"
        user={user}
        loginCallbackUrl="/"
        links={[
          { href: "/dashboard", label: "기회 맵" },
        ]}
      />

      <section className="hero-workspace landing-hero">
        <div className="hero-copy">
          <p className="eyebrow">사업자번호 기반 지원사업 매칭</p>
          <h1>사업자번호만 입력하면 받을 수 있는 기회를 보여드려요.</h1>
          <p className="hero-subcopy">
            복잡한 질문 없이 K-Startup과 기업마당에서 현재 지원 가능한 공고, 마감 임박 사업, 아카이브된 첨부 자료를 먼저 확인합니다.
          </p>

          <div className="stats-strip" aria-label="현재 지원사업 집계">
            <Metric label="전체 지원사업" value={`${landingData.stats.totalCount.toLocaleString("ko-KR")}건`} />
            <Metric label="현재 지원 가능" value={`${landingData.stats.activeCount.toLocaleString("ko-KR")}건`} />
            <Metric label="마감 임박" value={`${landingData.stats.deadlineSoonCount.toLocaleString("ko-KR")}건`} />
            <Metric label="첨부 아카이브" value={`${landingData.stats.archivedAttachmentCount.toLocaleString("ko-KR")}건`} />
          </div>

          <Card className="biz-form landing-biz-form" size="sm">
            <CardContent className="p-0">
              <form className="biz-form-fields" onSubmit={submit}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="bizNo">사업자번호 10자리</FieldLabel>
                    <div className="biz-input-row">
                      <Input
                        id="bizNo"
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="0000000000"
                        value={bizNo}
                        maxLength={12}
                        aria-describedby={errorField === "bizNo" ? "bizNoDescription bizNoError" : "bizNoDescription"}
                        aria-invalid={errorField === "bizNo"}
                        onChange={(event) => updateBizNoInput(event.target.value)}
                      />
                      <Button type="submit" disabled={isLoading}>
                        {isLoading ? <Spinner data-icon="inline-start" /> : null}
                        {isLoading ? "확인 중" : "회사 정보 확인"}
                      </Button>
                    </div>
                    <FieldDescription id="bizNoDescription">저장된 조회 결과를 먼저 확인하고, 없을 때만 팝빌 조회를 진행합니다. 사업자번호 원문은 결과 화면에 표시하지 않습니다.</FieldDescription>
                    {normalizedBizNo.length === 10 && !isLoading && !hasConfirmedLookup ? (
                      <p className="biz-ready-note">형식 확인됨. 같은 번호의 저장 결과가 있으면 추가 조회 없이 재사용합니다.</p>
                    ) : null}
                  </Field>
                </FieldGroup>
                {error ? (
                  <Alert id={errorField === "bizNo" ? "bizNoError" : undefined} variant="destructive" className="form-error">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </form>
            </CardContent>
          </Card>

          {isLoading ? (
            <CompanyLookupProgress maskedBizNo={maskBizNoForDisplay(lookupBizNo)} />
          ) : null}

          {!isLoading && hasConfirmedLookup && teaser?.companyEvidence ? (
            <CompanyEvidenceSummary
              evidence={teaser.companyEvidence}
              privacyNote={teaser.privacyNote}
              prominent
            />
          ) : null}
        </div>

        <GrantCarousel
          banners={banners}
          activeBanner={activeBanner}
          activeIndex={bannerIndex}
          onPrevious={() => setBannerIndex((current) => current <= 0 ? Math.max(banners.length - 1, 0) : current - 1)}
          onNext={() => setBannerIndex((current) => banners.length === 0 ? 0 : (current + 1) % banners.length)}
          onSelect={setBannerIndex}
        />
      </section>

      <OpportunityPreview stats={landingData.stats} teaser={teaser} />

      {teaser ? (
        <Card ref={teaserSectionRef} className="teaser-section" aria-live="polite" role="region" aria-labelledby="teaser-result-title">
          <div className="teaser-header">
            <div>
              <p className="eyebrow">1차 매칭 티저</p>
              <h2 id="teaser-result-title" ref={teaserHeadingRef} tabIndex={-1}>{profileHeadline(teaser)} 기준 결과</h2>
            </div>
            <div className="teaser-actions">
              <StatusBadge className="privacy-pill" tone="neutral">PII 비표시</StatusBadge>
              <Button className="dashboard-link" type="button" onClick={saveAndOpenDashboard} disabled={isSaving}>
                {isSaving ? <Spinner data-icon="inline-start" /> : null}
                {isSaving ? "저장 중" : "기회 맵 보기"}
              </Button>
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
        </Card>
      ) : null}

      <NewsletterSignup
        categories={newsletterCategories}
        consent={newsletterConsent}
        email={newsletterEmail}
        message={newsletterMessage}
        onCategoriesChange={setNewsletterCategories}
        onConsentChange={setNewsletterConsent}
        onEmailChange={setNewsletterEmail}
        onSubmit={submitNewsletter}
      />
    </main>
  );
}

function CompanyLookupProgress({ maskedBizNo }: { maskedBizNo: string | null }) {
  return (
    <div className="company-lookup-progress" role="status" aria-live="polite">
      <div className="company-lookup-spinner">
        <Spinner />
      </div>
      <div>
        <strong>저장 결과를 먼저 확인하고 있어요.</strong>
        <p>
          {maskedBizNo ? `${maskedBizNo} 기준으로 ` : ""}
          저장 결과가 없으면 팝빌에서 상호와 소재지, 업력, 영업상태를 확인한 뒤 재사용할 수 있게 보관합니다.
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <MetricCard className="stats-metric" label={label} value={value} />;
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
  const primaryHook = formatGrantHook(activeBanner);

  return (
    <Card className="hook-carousel grant-hook-carousel" aria-label="현재 지원 가능한 사업">
      <CardHeader className="hook-carousel-header">
        <div>
          <p className="hook-eyebrow">현재 지원 가능</p>
          <CardTitle>지금 열려 있는 지원사업</CardTitle>
          <CardDescription>{sourceLabel(activeBanner.source)} · {statusLabel(activeBanner.status)}</CardDescription>
        </div>
        <Badge className="hook-deadline-badge" variant="secondary">
          {formatDday(activeBanner.dDay)}
        </Badge>
      </CardHeader>
      <CardContent className="hook-card-content" aria-live="polite">
        <div className="hook-meta-row">
          <span>{activeBanner.category ?? "분야 확인"}</span>
          <span>{formatRegions(activeBanner.regions) ?? "지역 확인"}</span>
        </div>
        <div className="hook-amount-row">
          <strong className="hook-value-stack">
            <small>{primaryHook.label}</small>
            <span className="hook-value-text">{primaryHook.value}</span>
          </strong>
          <span>{formatDate(activeBanner.applyEnd)}</span>
        </div>
        <h2>{activeBanner.title}</h2>
        <p>{activeBanner.agency ?? "운영기관 확인 필요"}</p>
      </CardContent>
      <CardFooter className="hook-carousel-footer">
        <div className="hook-dots" aria-label="지원사업 배너 선택">
          {banners.map((banner, index) => (
            <Button
              key={`${banner.source}:${banner.sourceId}`}
              aria-current={activeIndex === index ? "true" : undefined}
              aria-label={`${index + 1}번째 지원사업 보기: ${banner.title}`}
              className="hook-dot-button"
              size="icon-xs"
              type="button"
              variant="ghost"
              onClick={() => onSelect(index)}
            >
              <span />
            </Button>
          ))}
        </div>
        <div className="hook-nav-buttons">
          <Button aria-label="이전 지원사업" size="icon-sm" type="button" variant="secondary" onClick={onPrevious}>
            <ChevronLeftIcon data-icon="inline-start" />
          </Button>
          <Button aria-label="다음 지원사업" size="icon-sm" type="button" variant="secondary" onClick={onNext}>
            <ChevronRightIcon data-icon="inline-start" />
          </Button>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              if (isExternal) {
                window.open(href, "_blank", "noreferrer");
                return;
              }
              window.location.assign(href);
            }}
          >
            공고 보기
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function NewsletterSignup({
  categories,
  consent,
  email,
  message,
  onCategoriesChange,
  onConsentChange,
  onEmailChange,
  onSubmit,
}: {
  categories: string[];
  consent: boolean;
  email: string;
  message: string | null;
  onCategoriesChange: (value: string[]) => void;
  onConsentChange: (value: boolean) => void;
  onEmailChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="newsletter-section" aria-labelledby="newsletter-title">
      <div className="newsletter-copy">
        <p className="eyebrow">지원사업 알림 뉴스레터</p>
        <h2 id="newsletter-title">관심 분야만 골라두면 새 공고를 메일로 알려드려요.</h2>
        <p>
          R&D, 사업화, 인건비처럼 주요 분야를 등록해두면 관련 지원사업이 새로 열렸을 때 먼저 확인할 수 있습니다.
        </p>
      </div>

      <Card className="newsletter-card">
        <CardHeader>
          <CardTitle>새 공고 알림 받기</CardTitle>
          <CardDescription>분야는 여러 개 선택할 수 있고, 실제 발송 데이터는 이후 저장 API와 연결합니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="newsletter-form" onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel>관심 분야</FieldLabel>
                <ToggleGroup
                  aria-label="뉴스레터 관심 분야"
                  className="newsletter-category-grid"
                  value={categories}
                  spacing={1}
                  variant="outline"
                  onValueChange={onCategoriesChange}
                >
                  {NEWSLETTER_CATEGORIES.map((category) => (
                    <ToggleGroupItem key={category.value} value={category.value} aria-label={category.label}>
                      {category.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldDescription>사업자번호를 입력하지 않아도 관심 분야 알림만 받을 수 있습니다.</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="newsletterEmail">이메일</FieldLabel>
                <Input
                  id="newsletterEmail"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@company.com"
                  type="email"
                  value={email}
                  onChange={(event) => onEmailChange(event.currentTarget.value)}
                />
              </Field>

              <Field className="newsletter-consent-field" orientation="horizontal">
                <Checkbox
                  id="newsletterConsent"
                  checked={consent}
                  onCheckedChange={(checked) => onConsentChange(checked === true)}
                />
                <FieldContent>
                  <FieldLabel htmlFor="newsletterConsent">지원사업 알림 메일 수신에 동의합니다.</FieldLabel>
                  <FieldDescription>신청 후 언제든 수신을 중단할 수 있습니다.</FieldDescription>
                </FieldContent>
              </Field>
            </FieldGroup>

            {message ? (
              <Alert className="newsletter-message">
                <AlertDescription>{message}</AlertDescription>
              </Alert>
            ) : null}

            <Button className="newsletter-submit" type="submit">
              새 공고 알림 받기
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

function OpportunityPreview({ stats, teaser }: { stats: LandingGrantStats; teaser: TeaserResult | null }) {
  const eligible = teaser?.counts.eligible ?? 0;
  const conditional = teaser?.counts.conditional ?? stats.unknownCount;
  const deadline = teaser?.counts.deadlineSoon ?? stats.deadlineSoonCount;

  return (
    <section className="landing-result-preview" aria-label="사업자번호 입력 후 확인할 수 있는 결과">
      <div className="landing-section-heading">
        <p className="eyebrow">입력 후 바로 보는 결과</p>
        <h2>내 사업자가 어떤 기회에 노출되는지 세 갈래로 정리합니다.</h2>
      </div>
      <div className="result-preview-grid">
        <Card className="result-preview-card">
          <CardContent>
            <span className="lane-dot active" />
            <strong>지금 가능</strong>
            <p>{(eligible || stats.activeCount).toLocaleString("ko-KR")}건의 지원사업 후보를 먼저 확인합니다.</p>
          </CardContent>
        </Card>
        <Card className="result-preview-card">
          <CardContent>
            <span className="lane-dot conditional" />
            <strong>확인 필요</strong>
            <p>{conditional.toLocaleString("ko-KR")}건은 업력, 지역, 업종처럼 추가 조건을 확인하면 가능성이 보입니다.</p>
          </CardContent>
        </Card>
        <Card className="result-preview-card">
          <CardContent>
            <span className="lane-dot urgent" />
            <strong>곧 마감</strong>
            <p>{deadline.toLocaleString("ko-KR")}건은 놓치기 전에 우선순위를 올려서 보여드립니다.</p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function MatchPreview({ match }: { match: MatchCard }) {
  const content = (
    <CardContent>
      <div>
        <StatusBadge className={`match-status ${match.eligibility}`} tone={matchEligibilityTone(match)}>
          {matchEligibilityLabel(match)}
        </StatusBadge>
        <h3>{match.title}</h3>
        <p>{matchEvidenceSummary(match)}</p>
        {match.detailUrl ? <span className="match-preview-action">조건과 신청 준비 보기</span> : null}
      </div>
      <div className="match-score">
        <strong>{match.fitScore}</strong>
        <span>{match.dDay === null ? "일정 확인" : match.dDay < 0 ? "마감 확인" : `D-${match.dDay}`}</span>
      </div>
    </CardContent>
  );

  return (
    <Card className="match-preview-card" size="sm">
      {match.detailUrl ? (
        <a
          className="match-preview-link"
          href={match.detailUrl}
          aria-label={`${match.title} 조건과 신청 준비 보기`}
          onClick={() => {
            recordLandingEvent({
              event: "teaser_match_clicked",
              grantId: match.grantId,
              eligibility: match.eligibility,
            });
            recordWebMatchEvent({
              grantId: match.grantId,
              event: "clicked",
              rulesetVer: match.rulesetVer,
            });
          }}
        >
          {content}
        </a>
      ) : (
        content
      )}
    </Card>
  );
}

function formatBizNoInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 10);
}

function maskBizNoForDisplay(value: string): string | null {
  const digits = formatBizNoInput(value);
  if (digits.length !== 10) return null;
  return `${digits.slice(0, 3)}-**-${digits.slice(5, 7)}***`;
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

function averageConfidenceBucket(matches: MatchCard[]): "none" | "low" | "medium" | "high" {
  if (matches.length === 0) return "none";
  const average = matches.reduce((sum, match) => sum + match.matchConfidence, 0) / matches.length;
  if (average >= 0.75) return "high";
  if (average >= 0.45) return "medium";
  return "low";
}

function formatGrantHook(banner: LandingGrantBanner): { label: string; value: string } {
  if (banner.supportAmountMax > 0) {
    return {
      label: "금액 확인",
      value: formatMoney(banner.supportAmountMax),
    };
  }

  const benefit = pickPrimaryBenefit(banner.benefits);
  if (benefit) {
    return {
      label: "핵심 혜택",
      value: benefitHookLabel(benefit.family, benefit.label),
    };
  }

  return {
    label: "지원 내용",
    value: banner.category ?? "혜택 확인",
  };
}

function pickPrimaryBenefit(benefits: LandingGrantBanner["benefits"]): LandingGrantBanner["benefits"][number] | undefined {
  const priority: Array<LandingGrantBanner["benefits"][number]["family"]> = [
    "network",
    "market",
    "capability",
    "certification",
    "space",
    "loan",
    "funding",
  ];
  for (const family of priority) {
    const benefit = benefits.find((item) => item.family === family);
    if (benefit) return benefit;
  }
  return benefits[0];
}

function benefitHookLabel(family: LandingGrantBanner["benefits"][number]["family"], label: string): string {
  if (family === "capability") return "교육·멘토링";
  if (family === "market") return "판로·수출";
  if (family === "certification") return "인증·IP";
  if (family === "network") return "투자·연결";
  if (family === "space") return "입주·공간";
  if (family === "loan") return "융자·보증";
  if (family === "funding") return "사업화 지원";
  return label;
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

function matchEvidenceSummary(match: MatchCard): string {
  const traceSummary = match.ruleTrace.slice(0, 2).map((trace) => trace.label).join(" / ");
  if (traceSummary) return traceSummary;
  if (isLowEvidenceEligible(match)) return "자동 확인 근거가 부족해 원문 확인이 필요합니다.";
  return "조건 확인 필요";
}

function isLowEvidenceEligible(match: MatchCard): boolean {
  return match.eligibility === "eligible" && (match.matchConfidence < 0.45 || match.ruleTrace.length === 0);
}
