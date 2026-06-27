"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ActionResult, CompanyProfile, MatchCard, StatsResult, TeaserRequest, TeaserResult } from "@cunote/contracts";
import { MetricCard } from "@/components/app/metric-card";
import { PageNav } from "@/components/app/page-nav";
import { StatusBadge, eligibilityTone } from "@/components/app/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { KOREA_REGION_OPTIONS } from "@/lib/regions";

type EntryMode = "active" | "preliminary";

const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";
const REGION_SELECT_ITEMS = KOREA_REGION_OPTIONS.map((region) => ({
  label: region.label,
  value: region.code,
}));

interface HomeExperienceProps {
  initialStats: StatsResult;
}

export function HomeExperience({ initialStats }: HomeExperienceProps) {
  const [bizNo, setBizNo] = useState("");
  const [entryMode, setEntryMode] = useState<EntryMode>("active");
  const [regionCode, setRegionCode] = useState("41");
  const [founderAge, setFounderAge] = useState("");
  const [industry, setIndustry] = useState("");
  const [teaser, setTeaser] = useState<TeaserResult | null>(null);
  const [lastTeaserRequest, setLastTeaserRequest] = useState<TeaserRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const topMatches = useMemo(() => teaser?.matches.slice(0, 4) ?? [], [teaser]);

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
        <PageNav
          links={[
            { href: "/dashboard", label: "기회 맵" },
            { href: "/internal/live-match", label: "내부 검증 콘솔" },
          ]}
        />
      </header>

      <section className="hero-workspace">
        <div className="hero-copy">
          <p className="eyebrow">지원사업 매칭</p>
          <h1>내 사업자가 지금 열 수 있는 기회를 확인합니다.</h1>
          <p className="hero-subcopy">
            사업자번호 또는 예비창업 프로필로 K-Startup 공고를 훑고, 적격과 확인 필요를 분리합니다.
          </p>

          <div className="stats-strip" aria-label="현재 지원사업 집계">
            <Metric label="열린 공고" value={`${initialStats.openCount.toLocaleString("ko-KR")}건`} />
            <Metric label="마감 임박" value={`${initialStats.deadlineSoonCount.toLocaleString("ko-KR")}건`} />
            <Metric label="지원금 총액" value={formatMoney(initialStats.totalAmount)} />
          </div>

          <Card className="biz-form" size="sm">
            <CardContent className="p-0">
              <form className="biz-form-fields" onSubmit={submit}>
                <ToggleGroup
                  aria-label="기업 상태"
                  className="entry-mode-tabs"
                  value={[entryMode]}
                  onValueChange={(value) => {
                    const nextMode = value[0] as EntryMode | undefined;
                    if (!nextMode) return;
                    setEntryMode(nextMode);
                    setError(null);
                  }}
                  spacing={1}
                  variant="outline"
                >
                  <ToggleGroupItem value="active" aria-label="기창업">
                    기창업
                  </ToggleGroupItem>
                  <ToggleGroupItem value="preliminary" aria-label="예비창업">
                    예비창업
                  </ToggleGroupItem>
                </ToggleGroup>

                {entryMode === "active" ? (
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
                          onChange={(event) => setBizNo(formatBizNoInput(event.target.value))}
                        />
                        <Button type="submit" disabled={isLoading}>
                          {isLoading ? <Spinner data-icon="inline-start" /> : null}
                          {isLoading ? "확인 중" : "내 지원사업 확인"}
                        </Button>
                      </div>
                      <FieldDescription>결과 화면에는 사업자번호 원문을 표시하지 않습니다.</FieldDescription>
                    </Field>
                  </FieldGroup>
                ) : (
                  <FieldGroup>
                    <div className="preliminary-grid">
                      <Field>
                        <FieldLabel htmlFor="preRegion">지역</FieldLabel>
                        <Select
                          items={REGION_SELECT_ITEMS}
                          value={regionCode}
                          onValueChange={(value) => {
                            if (typeof value === "string") setRegionCode(value);
                          }}
                        >
                          <SelectTrigger id="preRegion" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {REGION_SELECT_ITEMS.map((region) => (
                                <SelectItem key={region.value} value={region.value}>
                                  {region.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="founderAge">대표자 나이</FieldLabel>
                        <Input
                          id="founderAge"
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="35"
                          value={founderAge}
                          maxLength={3}
                          onChange={(event) => setFounderAge(event.currentTarget.value.replace(/\D/g, "").slice(0, 3))}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="industry">예정 업종</FieldLabel>
                        <Input
                          id="industry"
                          autoComplete="off"
                          placeholder="ICT"
                          value={industry}
                          onChange={(event) => setIndustry(event.currentTarget.value)}
                        />
                      </Field>
                    </div>
                    <Button className="preliminary-submit" type="submit" disabled={isLoading}>
                      {isLoading ? <Spinner data-icon="inline-start" /> : null}
                      {isLoading ? "확인 중" : "예비창업 기회 확인"}
                    </Button>
                    <FieldDescription>예비창업 프로필은 자동 보강 없이 수기 입력 기준으로만 계산합니다.</FieldDescription>
                  </FieldGroup>
                )}
                {error ? (
                  <Alert variant="destructive" className="form-error">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </form>
            </CardContent>
          </Card>
        </div>

        <OpportunityPreview stats={initialStats} teaser={teaser} />
      </section>

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
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <MetricCard className="stats-metric" label={label} value={value} />;
}

function OpportunityPreview({ stats, teaser }: { stats: StatsResult; teaser: TeaserResult | null }) {
  const eligible = teaser?.counts.eligible ?? 0;
  const conditional = teaser?.counts.conditional ?? 0;
  const deadline = teaser?.counts.deadlineSoon ?? stats.deadlineSoonCount;

  return (
    <Card className="opportunity-board" aria-label="기회 맵 미리보기">
      <CardHeader className="board-header">
        <span>Opportunity Map</span>
        <strong>{teaser ? "개인화됨" : "집계 대기"}</strong>
      </CardHeader>
      <CardContent className="board-lanes">
        <div className="board-lane active">
          <span className="lane-dot" />
          <div>
            <strong>지금 받을 수 있어요</strong>
            <span>{eligible || stats.openCount}건 후보</span>
          </div>
        </div>
        <div className="board-lane conditional">
          <span className="lane-dot" />
          <div>
            <strong>확인이 필요해요</strong>
            <span>{conditional}건 조건부</span>
          </div>
        </div>
        <div className="board-lane urgent">
          <span className="lane-dot" />
          <div>
            <strong>곧 닫혀요</strong>
            <span>{deadline}건 마감 임박</span>
          </div>
        </div>
      </CardContent>
      <CardFooter className="board-axis" aria-hidden="true">
        <span>지금</span>
        <span>준비</span>
        <span>마감</span>
      </CardFooter>
    </Card>
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

function eligibilityLabel(value: MatchCard["eligibility"]): string {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "확인 필요";
  return "부적격";
}
