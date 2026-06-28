"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { BellIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ActionResult, MatchCard, StatsResult, TeaserRequest, TeaserResult } from "@cunote/contracts";
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
import type { HeaderUser } from "@/lib/server/auth/session";

type OpportunityHook = {
  amount: string;
  title: string;
  description: string;
  field: string;
  agency: string;
  deadline: string;
};

type NewsletterCategory = {
  value: string;
  label: string;
};

const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";
const OPPORTUNITY_HOOKS: OpportunityHook[] = [
  {
    amount: "최대 1억원",
    title: "R&D 바우처 후보가 열려요",
    description: "기술개발 과제를 준비 중인 법인이라면 연구개발비와 외부전문가 비용을 함께 확인할 수 있어요.",
    field: "R&D",
    agency: "중소벤처기업부",
    deadline: "D-12",
  },
  {
    amount: "최대 5천만원",
    title: "초기 사업화 자금을 받을 수 있어요",
    description: "제품 검증, 마케팅, 시제품 제작까지 한 번에 묶인 사업화 패키지를 먼저 보여드려요.",
    field: "사업화",
    agency: "창업진흥원",
    deadline: "D-18",
  },
  {
    amount: "월 180만원",
    title: "신규 채용 인건비 지원을 확인해요",
    description: "청년 채용 계획이 있다면 인건비 보전과 고용 유지 조건을 함께 비교할 수 있어요.",
    field: "인건비",
    agency: "고용노동부",
    deadline: "상시",
  },
  {
    amount: "최대 7천만원",
    title: "수출 바우처 모집이 다가와요",
    description: "해외 판로, 전시회, 번역, 인증이 필요한 기업에게 맞는 수출 지원사업을 골라줘요.",
    field: "수출",
    agency: "KOTRA",
    deadline: "D-9",
  },
  {
    amount: "최대 3천만원",
    title: "시제품 제작비를 먼저 챙겨요",
    description: "제조, 하드웨어, 의료기기 분야는 제작비와 시험분석비 지원을 우선 탐색해요.",
    field: "시제품",
    agency: "지역테크노파크",
    deadline: "D-21",
  },
  {
    amount: "80% 지원",
    title: "AI 전환 컨설팅을 신청할 수 있어요",
    description: "업무 자동화나 데이터 활용 계획이 있다면 컨설팅과 도입 비용 지원을 함께 확인해요.",
    field: "디지털전환",
    agency: "NIPA",
    deadline: "D-27",
  },
  {
    amount: "최대 1억원",
    title: "청년창업 패키지 후보가 있어요",
    description: "대표자 연령과 업력 조건이 맞으면 창업교육, 멘토링, 사업화 자금을 같이 볼 수 있어요.",
    field: "청년창업",
    agency: "창업진흥원",
    deadline: "D-35",
  },
  {
    amount: "최대 2천만원",
    title: "소상공인 디지털 전환을 놓치지 마세요",
    description: "예약, POS, 스마트스토어, 광고 운영을 바꾸려는 사업자에게 맞는 공고를 찾아줘요.",
    field: "소상공인",
    agency: "소상공인시장진흥공단",
    deadline: "D-6",
  },
  {
    amount: "최대 1천만원",
    title: "특허와 인증 비용도 지원돼요",
    description: "인증, 특허, 시험성적서가 필요한 기업은 제품 출시 전 비용 지원 여부를 볼 수 있어요.",
    field: "인증/특허",
    agency: "한국특허전략개발원",
    deadline: "D-16",
  },
  {
    amount: "최대 1,500만원",
    title: "해외 전시 참가비 후보를 보여드려요",
    description: "해외 박람회나 바이어 미팅을 준비 중이면 부스, 항공, 통역 지원을 먼저 추려요.",
    field: "해외전시",
    agency: "무역협회",
    deadline: "D-24",
  },
];

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
  initialStats: StatsResult;
  user?: HeaderUser | null;
}

export function HomeExperience({ initialStats, user = null }: HomeExperienceProps) {
  const [bizNo, setBizNo] = useState("");
  const [teaser, setTeaser] = useState<TeaserResult | null>(null);
  const [lastTeaserRequest, setLastTeaserRequest] = useState<TeaserRequest | null>(null);
  const [activeLookupBizNo, setActiveLookupBizNo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [activeHookIndex, setActiveHookIndex] = useState(0);
  const [isCarouselPaused, setIsCarouselPaused] = useState(false);
  const [newsletterCategories, setNewsletterCategories] = useState<string[]>(["rnd", "commercialization"]);
  const [newsletterEmail, setNewsletterEmail] = useState("");
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [newsletterMessage, setNewsletterMessage] = useState<string | null>(null);
  const topMatches = useMemo(() => teaser?.matches.slice(0, 4) ?? [], [teaser]);
  const normalizedBizNo = formatBizNoInput(bizNo);
  const lookupBizNo = activeLookupBizNo ?? normalizedBizNo;
  const hasConfirmedLookup = Boolean(teaser && lastTeaserRequest?.bizNo === normalizedBizNo);

  useEffect(() => {
    if (isCarouselPaused) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) return;

    const timer = window.setInterval(() => {
      setActiveHookIndex((current) => (current + 1) % OPPORTUNITY_HOOKS.length);
    }, 3800);

    return () => window.clearInterval(timer);
  }, [isCarouselPaused]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("resumeCompany") !== "1") return;

    const pending = readPendingTeaserRequest();
    clearResumeFlag(params);
    if (!pending) return;

    void createCompanyAndOpenDashboard(pending);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    if (normalizedBizNo.length !== 10) {
      setError("사업자번호 10자리를 입력해주세요.");
      setIsLoading(false);
      return;
    }
    const requestBody: TeaserRequest = { bizNo: normalizedBizNo };
    setActiveLookupBizNo(normalizedBizNo);

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
      setBizNo(normalizedBizNo);
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
    if (error) setError(null);
    if (lastTeaserRequest?.bizNo && lastTeaserRequest.bizNo !== nextBizNo) {
      setTeaser(null);
      setLastTeaserRequest(null);
      setActiveLookupBizNo(null);
    }
  }

  async function saveAndOpenDashboard() {
    if (!lastTeaserRequest) return;
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
      <ServiceHeader
        variant="landing"
        user={user}
        loginCallbackUrl="/"
        links={[
          { href: "/dashboard", label: "기회 맵" },
          { href: "/internal/live-match", label: "내부 검증 콘솔" },
        ]}
      />

      <section className="hero-workspace landing-hero">
        <div className="hero-copy">
          <p className="eyebrow">사업자번호 기반 지원사업 매칭</p>
          <h1>사업자번호만 입력하면 받을 수 있는 기회를 보여드려요.</h1>
          <p className="hero-subcopy">
            복잡한 질문 없이 내 사업자가 노출될 수 있는 정부지원사업, 지원금 규모, 마감 임박 공고를 먼저 확인합니다.
          </p>

          <div className="stats-strip" aria-label="현재 지원사업 집계">
            <Metric label="열린 공고" value={`${initialStats.openCount.toLocaleString("ko-KR")}건`} />
            <Metric label="마감 임박" value={`${initialStats.deadlineSoonCount.toLocaleString("ko-KR")}건`} />
            <Metric label="지원금 총액" value={formatMoney(initialStats.totalAmount)} />
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
                        onChange={(event) => updateBizNoInput(event.target.value)}
                      />
                      <Button type="submit" disabled={isLoading}>
                        {isLoading ? <Spinner data-icon="inline-start" /> : null}
                        {isLoading ? "조회 중" : "팝빌로 회사 확인"}
                      </Button>
                    </div>
                    <FieldDescription>입력은 매칭에만 사용하고 결과 화면에는 사업자번호 원문을 표시하지 않습니다.</FieldDescription>
                    {normalizedBizNo.length === 10 && !isLoading && !hasConfirmedLookup ? (
                      <p className="biz-ready-note">형식 확인됨. 누르면 팝빌에서 상호, 소재지, 업력, 영업상태를 확인합니다.</p>
                    ) : null}
                  </Field>
                </FieldGroup>
                {error ? (
                  <Alert variant="destructive" className="form-error">
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

        <OpportunityHookCarousel
          activeIndex={activeHookIndex}
          onSelect={setActiveHookIndex}
          onPauseChange={setIsCarouselPaused}
        />
      </section>

      <OpportunityPreview stats={initialStats} teaser={teaser} />

      {teaser ? (
        <Card className="teaser-section" aria-live="polite">
          <div className="teaser-header">
            <div>
              <p className="eyebrow">1차 매칭 티저</p>
              <h2>{profileHeadline(teaser)} 기준 결과</h2>
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
        <strong>팝빌에서 사업자 정보를 확인하고 있어요.</strong>
        <p>
          {maskedBizNo ? `${maskedBizNo} 기준으로 ` : ""}
          상호와 소재지, 업력, 영업상태를 받으면 바로 아래에 먼저 보여드립니다.
        </p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <MetricCard className="stats-metric" label={label} value={value} />;
}

function OpportunityHookCarousel({
  activeIndex,
  onSelect,
  onPauseChange,
}: {
  activeIndex: number;
  onSelect: (index: number) => void;
  onPauseChange: (paused: boolean) => void;
}) {
  const activeHook = OPPORTUNITY_HOOKS[activeIndex] ?? OPPORTUNITY_HOOKS[0]!;

  function move(delta: number) {
    onSelect((activeIndex + delta + OPPORTUNITY_HOOKS.length) % OPPORTUNITY_HOOKS.length);
  }

  return (
    <Card
      className="hook-carousel"
      aria-label="지원사업 기회 예시"
      onBlur={() => onPauseChange(false)}
      onFocus={() => onPauseChange(true)}
      onMouseEnter={() => onPauseChange(true)}
      onMouseLeave={() => onPauseChange(false)}
    >
      <CardHeader className="hook-carousel-header">
        <div>
          <p className="hook-eyebrow">가장 먼저 받을 수 있는 알림</p>
          <CardTitle>내 사업자에 맞는 기회가 이렇게 보여요</CardTitle>
          <CardDescription>아래 내용은 예시이며 실제 공고 데이터로 교체할 수 있습니다.</CardDescription>
        </div>
        <Badge className="hook-deadline-badge" variant="secondary">
          {activeHook.deadline}
        </Badge>
      </CardHeader>
      <CardContent className="hook-card-content" aria-live="polite">
        <div className="hook-meta-row">
          <span>{activeHook.field}</span>
          <span>{activeHook.agency}</span>
        </div>
        <div className="hook-amount-row">
          <strong>{activeHook.amount}</strong>
          <span className="hook-bell" aria-hidden="true">
            <BellIcon />
          </span>
        </div>
        <h2>{activeHook.title}</h2>
        <p>{activeHook.description}</p>
      </CardContent>
      <CardFooter className="hook-carousel-footer">
        <div className="hook-dots" aria-label="기회 예시 선택">
          {OPPORTUNITY_HOOKS.map((hook, index) => (
            <Button
              key={hook.title}
              aria-current={activeIndex === index ? "true" : undefined}
              aria-label={`${index + 1}번째 예시 보기: ${hook.field}`}
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
          <Button aria-label="이전 기회 예시" size="icon-sm" type="button" variant="secondary" onClick={() => move(-1)}>
            <ChevronLeftIcon data-icon="inline-start" />
          </Button>
          <Button aria-label="다음 기회 예시" size="icon-sm" type="button" variant="secondary" onClick={() => move(1)}>
            <ChevronRightIcon data-icon="inline-start" />
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

function OpportunityPreview({ stats, teaser }: { stats: StatsResult; teaser: TeaserResult | null }) {
  const eligible = teaser?.counts.eligible ?? 0;
  const conditional = teaser?.counts.conditional ?? 0;
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
            <p>{eligible || stats.openCount}건의 지원사업 후보를 먼저 확인합니다.</p>
          </CardContent>
        </Card>
        <Card className="result-preview-card">
          <CardContent>
            <span className="lane-dot conditional" />
            <strong>확인 필요</strong>
            <p>{conditional}건은 업력, 지역, 업종처럼 추가 조건을 확인하면 가능성이 보입니다.</p>
          </CardContent>
        </Card>
        <Card className="result-preview-card">
          <CardContent>
            <span className="lane-dot urgent" />
            <strong>곧 마감</strong>
            <p>{deadline}건은 놓치기 전에 우선순위를 올려서 보여드립니다.</p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function MatchPreview({ match }: { match: MatchCard }) {
  return (
    <Card className="match-preview-card" size="sm">
      <CardContent>
        <div>
          <StatusBadge className={`match-status ${match.eligibility}`} tone={eligibilityTone(match.eligibility)}>
            {eligibilityLabel(match.eligibility)}
          </StatusBadge>
          <h3>{match.title}</h3>
          <p>{match.ruleTrace.slice(0, 2).map((trace) => trace.label).join(" / ") || "조건 확인 필요"}</p>
        </div>
        <div className="match-score">
          <strong>{match.fitScore}</strong>
          <span>{match.dDay === null ? "일정 확인" : match.dDay < 0 ? "마감 확인" : `D-${match.dDay}`}</span>
        </div>
      </CardContent>
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

function eligibilityLabel(value: MatchCard["eligibility"]): string {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "확인 필요";
  return "부적격";
}
