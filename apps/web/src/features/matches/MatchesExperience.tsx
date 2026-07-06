"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, HelpCircle, Minus, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import type {
  ActionResult,
  CompanyEvidenceField,
  CriterionKind,
  Eligibility,
  MatchCard,
  RuleTraceChip,
  RuleTraceChipResult,
  SupportAmount,
  TeaserRequest,
  TeaserResult,
} from "@cunote/contracts";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  readLocalBusinessLookupSuggestions,
  recordBusinessLookupSuggestion,
  upsertBusinessLookupSuggestion,
  writeLocalBusinessLookupSuggestions,
} from "@/lib/client/businessLookupSuggestions";

const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";
const TEASER_FALLBACK_MESSAGE = "매칭 결과를 불러오지 못했습니다.";

type Status = "idle" | "loading" | "ready" | "error" | "empty";

class TeaserError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "TeaserError";
    this.code = code;
  }
}

export function MatchesExperience() {
  const [status, setStatus] = useState<Status>("loading");
  const [teaser, setTeaser] = useState<TeaserResult | null>(null);
  const [bizNo, setBizNo] = useState<string | null>(null);
  const [error, setError] = useState<TeaserError | null>(null);

  const loadTeaser = useCallback(async (digits: string) => {
    setStatus("loading");
    setError(null);
    try {
      const response = await fetch("/api/web/teaser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bizNo: digits } satisfies TeaserRequest),
      });
      const payload = (await response.json()) as ActionResult<TeaserResult>;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new TeaserError(payload.error?.message ?? TEASER_FALLBACK_MESSAGE, payload.error?.code ?? null);
      }
      setTeaser(payload.data);
      setStatus("ready");
      void rememberBusinessLookup(digits);
    } catch (caught) {
      const next =
        caught instanceof TeaserError
          ? caught
          : new TeaserError(caught instanceof Error ? caught.message : TEASER_FALLBACK_MESSAGE, null);
      setError(next);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const digits = (params.get("biz") ?? "").replace(/\D/g, "").slice(0, 10);
    if (digits.length !== 10) {
      setStatus("empty");
      return;
    }
    setBizNo(digits);
    void loadTeaser(digits);
  }, [loadTeaser]);

  const maskedBiz = teaser?.companyEvidence?.maskedBizNo ?? (bizNo ? maskBiz(bizNo) : null);
  const badge = headerBadge(status, maskedBiz);

  function saveAndContinue() {
    if (bizNo) {
      try {
        window.sessionStorage.setItem(PENDING_TEASER_STORAGE_KEY, JSON.stringify({ bizNo } satisfies TeaserRequest));
      } catch {
        // storage 불가 시에도 로그인은 진행
      }
    }
    const params = new URLSearchParams({ callbackUrl: "/?resumeCompany=1" });
    window.location.assign(`/login?${params.toString()}`);
  }

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-background text-foreground">
      <MatchesNav onSave={saveAndContinue} />

      <header className="border-b bg-muted/30">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10 sm:px-6 lg:px-8">
          <Badge variant={status === "error" ? "destructive" : status === "ready" ? "default" : "outline"} className="w-fit">
            {badge.text}
          </Badge>
          <h1 className="max-w-4xl text-3xl font-semibold tracking-normal sm:text-4xl">
            {status === "ready" && teaser ? (
              <>
                지원 가능한 사업{" "}
                <span className="text-primary">
                  {teaser.counts.eligible.toLocaleString("ko-KR")}건
                </span>
                을 찾았어요
              </>
            ) : status === "error" ? (
              "매칭 결과를 불러오지 못했어요"
            ) : status === "empty" ? (
              "조회할 사업자번호가 없어요"
            ) : (
              "지원 가능한 사업을 찾고 있어요"
            )}
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
            {status === "error"
              ? "잠시 문제가 생겨 결과를 보여드리지 못했어요. 아래 안내대로 다시 시도하면 대부분 해결돼요."
              : status === "empty"
                ? "사업자번호만 있으면 받을 수 있는 지원사업을 바로 찾아드려요."
                : "내 사업자 정보를 표준 조건과 대조한 결과예요. 조건마다 충족 여부를 함께 보여드려요."}
          </p>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        {status === "loading" ? <LoadingState /> : null}
        {status === "empty" ? <EmptyState /> : null}
        {status === "error" ? (
          <ErrorState error={error} onRetry={bizNo ? () => void loadTeaser(bizNo) : undefined} />
        ) : null}
        {status === "ready" && teaser ? (
          <>
            <ProfileSection teaser={teaser} onCollect={saveAndContinue} />
            <ProgramsSection matches={teaser.matches} onPrepare={saveAndContinue} />
          </>
        ) : null}
      </main>
    </div>
  );
}

async function rememberBusinessLookup(digits: string) {
  const result = await recordBusinessLookupSuggestion(digits);
  if (!result?.suggestion || result.authenticated) return;
  const localSuggestion = {
    ...result.suggestion,
    source: "local" as const,
    cacheSource: "client_storage" as const,
  };
  const next = upsertBusinessLookupSuggestion(readLocalBusinessLookupSuggestions(), localSuggestion);
  writeLocalBusinessLookupSuggestions(next);
}

/* ───────────────────────── Nav ───────────────────────── */

function MatchesNav({ onSave }: { onSave: () => void }) {
  return (
    <nav className="sticky top-0 z-50 flex items-center justify-between gap-4 border-b bg-background/95 px-4 py-3.5 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-6 lg:px-8">
      <Link href="/" className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
        <span className="flex size-8 items-center justify-center rounded-[var(--radius-lg)] bg-primary text-primary-foreground">C</span>
        <span>창업노트</span>
      </Link>
      <Button type="button" size="sm" onClick={onSave}>
        결과 저장하기
      </Button>
    </nav>
  );
}

/* ───────────────────────── 내 사업자 분석 ───────────────────────── */

function ProfileSection({ teaser, onCollect }: { teaser: TeaserResult; onCollect: () => void }) {
  const fields = buildProfileFields(teaser);
  const known = fields.filter((field) => field.available).length;
  const total = fields.length || 1;
  const pct = Math.round((known / total) * 100);
  const checkedNote = evidenceCheckedNote(teaser.companyEvidence ?? null);
  const registryNotice = sparseRegistryNotice(teaser.companyEvidence ?? null);

  return (
    <section className="grid gap-4">
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-normal">
            내 사업자 분석
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            사업자번호로 불러온 정보를 시스템 표준 조건으로 정규화했어요.
          </p>
          {checkedNote ? (
            <p className="mt-1 text-xs text-muted-foreground/80">{checkedNote}</p>
          ) : null}
        </div>
        <div className="min-w-[240px] max-w-[340px] flex-1">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-muted-foreground">정보 충족도</span>
            <span className="font-extrabold text-primary">
              {known} / {total} 확정
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      {registryNotice ? (
        <div className="flex gap-3 rounded-[var(--radius-lg)] border border-primary/20 bg-primary/5 p-4 text-sm">
          <TriangleAlert className="mt-0.5 size-4 flex-none text-primary" aria-hidden />
          <div className="grid gap-1">
            <div className="font-semibold text-foreground">{registryNotice.title}</div>
            <p className="leading-6 text-muted-foreground">{registryNotice.body}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) =>
          field.available ? (
            <Card key={field.key} size="sm">
              <CardContent className="grid gap-2">
                <div className="text-xs font-medium text-muted-foreground">{field.label}</div>
                <div className="text-base font-semibold leading-snug">{field.value}</div>
              </CardContent>
            </Card>
          ) : (
            <Card key={field.key} size="sm" className="border-dashed bg-muted/30">
              <button type="button" onClick={onCollect} className="w-full cursor-pointer text-left">
                <CardContent className="grid gap-2">
                  <div className="text-xs font-medium text-muted-foreground">{field.label}</div>
                  <div className="text-base font-semibold text-muted-foreground">미입력</div>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                    <Plus className="size-3" strokeWidth={3} />
                    입력하기
                  </span>
                </CardContent>
              </button>
            </Card>
          ),
        )}
      </div>
    </section>
  );
}

/* ───────────────────────── 지원 가능한 사업 ───────────────────────── */

function ProgramsSection({ matches, onPrepare }: { matches: MatchCard[]; onPrepare: () => void }) {
  if (matches.length === 0) {
    return (
      <section>
        <h2 className="mb-4 text-xl font-semibold tracking-normal">
          지원 가능한 사업
        </h2>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
          아직 적격으로 확인된 사업이 없어요. 정보를 더 입력하면 매칭 범위가 넓어져요.
          </CardContent>
        </Card>
      </section>
    );
  }
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-normal">
          지원 가능한 사업
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="default">충족</Badge>
          <Badge variant="secondary">확인 필요</Badge>
          <Badge variant="outline">미해당</Badge>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {matches.map((match, index) => (
          <ProgramCard key={match.grantId} match={match} defaultOpen={index === 0} onPrepare={onPrepare} />
        ))}
      </div>
    </section>
  );
}

function ProgramCard({
  match,
  defaultOpen,
  onPrepare,
}: {
  match: MatchCard;
  defaultOpen: boolean;
  onPrepare: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const elig = eligibilityChip(match.eligibility);
  const criteria = match.ruleTrace.filter((chip) => chip.result !== "text_only");
  const passCount = criteria.filter((chip) => chip.result === "pass").length;
  const unscored = match.criteriaExtracted === false;

  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="w-full cursor-pointer px-5 py-5 text-left"
      >
        <div className="flex flex-wrap justify-between gap-4">
          <div className="min-w-[220px] flex-1">
            <div className="mb-2 flex items-center gap-1.5">
              <Badge variant={match.eligibility === "eligible" ? "default" : match.eligibility === "conditional" ? "secondary" : "outline"}>
                {elig.label}
              </Badge>
              <Badge variant={match.dDay !== null && match.dDay <= 7 ? "secondary" : "outline"}>{formatDday(match.dDay)}</Badge>
            </div>
            <div className="text-base font-semibold leading-snug">
              {match.title}
            </div>
            <div className="mt-1.5 text-sm text-muted-foreground">
              {match.agency ?? "운영기관 확인"} · {formatAmount(match.supportAmount)}
            </div>
          </div>
          <div className="min-w-[150px] flex-none text-right">
            <div className="mb-0.5 text-xs text-muted-foreground">적합도</div>
            {unscored ? (
              <div
                className="text-2xl font-semibold leading-none text-muted-foreground tabular-nums"
                title="공고 조건이 아직 구조화되지 않아 적합도를 산정하지 못했어요."
              >
                —
              </div>
            ) : (
              <>
                <div className="text-2xl font-semibold leading-none text-primary tabular-nums">
                  {match.fitScore}%
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${clampPct(match.fitScore)}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between border-t pt-3.5">
          <span className="text-xs text-muted-foreground">
            조건 {criteria.length} · 충족 {passCount}
          </span>
          <span className="flex items-center gap-1 text-xs font-medium text-primary">
            {open ? "접기" : "조건 자세히 보기"}
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </span>
        </div>
      </button>

      {open ? (
        <div className="border-t bg-muted/30 px-5 pb-5 pt-4">
          <div className="mb-3 text-xs font-semibold text-muted-foreground">적합 조건</div>
          {criteria.length > 0 ? (
            <div className="mb-5 flex flex-col gap-2">
              {criteria.map((chip, index) => (
                <CriterionRow key={`${chip.dimension}-${index}`} chip={chip} />
              ))}
            </div>
          ) : (
            <p className="mb-5 text-sm text-muted-foreground">표시할 세부 조건이 없어요.</p>
          )}
          <p className="mb-4 text-xs text-muted-foreground">
            필요 서류와 사업계획서 초안은 결과 저장 후 신청 준비 단계에서 회사 정보로 채워 안내해 드려요.
          </p>
          <button
            type="button"
            onClick={onPrepare}
            className={cn(buttonVariants({ size: "default" }))}
          >
            이 사업 신청 준비하기
            <ArrowRight data-icon="inline-end" />
          </button>
        </div>
      ) : null}
    </Card>
  );
}

function CriterionRow({ chip }: { chip: RuleTraceChip }) {
  const result = resultVisual(chip.result);
  const kind = kindVisual(chip.kind);
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border bg-card px-4 py-3">
      <span className={cn("mt-0.5 flex size-6 flex-none items-center justify-center rounded-full text-xs", chip.result === "pass" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{result.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={chip.kind === "preferred" ? "secondary" : chip.kind === "exclusion" ? "destructive" : "outline"}>{kind.label}</Badge>
          <span className="text-sm font-medium">{chip.label}</span>
        </div>
        {chip.companyValue ? (
          <div className="mt-1 text-xs text-muted-foreground">{chip.companyValue}</div>
        ) : null}
      </div>
      <span className="flex-none self-center text-xs font-medium text-muted-foreground">
        {result.text}
      </span>
    </div>
  );
}

/* ───────────────────────── states ───────────────────────── */

function LoadingState() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-[var(--radius-xl)]" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-36 rounded-[var(--radius-xl)]" />
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="mx-auto w-full max-w-[460px]">
      <CardContent className="py-9 text-center">
      <h2 className="mb-2 text-lg font-semibold">조회할 사업자번호가 없어요</h2>
      <p className="mb-6 text-sm leading-6 text-muted-foreground">
        첫 화면에서 사업자번호를 입력하면 받을 수 있는 지원사업을 찾아드려요.
      </p>
      <Link href="/" className={cn(buttonVariants({ size: "lg" }))}>
        사업자번호 입력하러 가기
      </Link>
      </CardContent>
    </Card>
  );
}

function ErrorState({ error, onRetry }: { error: TeaserError | null; onRetry?: (() => void) | undefined }) {
  const isBizIssue = error?.code === "invalid_biz_no";
  const reason = error?.message ?? TEASER_FALLBACK_MESSAGE;
  const title = isBizIssue ? "사업자번호를 다시 확인해 주세요" : "잠시 후 다시 시도해 주세요";
  const steps = isBizIssue
    ? [
        "사업자번호 10자리를 정확히 입력했는지 확인해 주세요.",
        "휴업·폐업 상태이거나 아직 등록되지 않은 번호일 수 있어요.",
        "번호가 정확하다면 잠시 후 다시 시도해 주세요.",
      ]
    : [
        "인터넷 연결 상태를 확인하고 다시 시도해 주세요.",
        "국세청·팝빌 조회가 일시적으로 지연될 수 있어요. 잠시 후 다시 시도하면 대부분 정상 처리돼요.",
        "입력한 사업자번호가 정확한지도 한 번 확인해 주세요.",
      ];

  return (
    <div className="mx-auto max-w-[520px]">
      <Card>
        <CardContent className="py-8">
        <div className="mb-5 flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <TriangleAlert className="size-7" strokeWidth={2.25} />
        </div>

        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{reason}</p>

        <div className="mt-6 rounded-[var(--radius-xl)] border bg-muted/30 p-4">
          <div className="mb-3 text-xs font-semibold text-muted-foreground">
            이렇게 해보세요
          </div>
          <ul className="flex flex-col gap-2.5">
            {steps.map((step, index) => (
              <li key={index} className="flex items-start gap-2.5 text-sm leading-6 text-muted-foreground">
                <span className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
          {!isBizIssue && onRetry ? (
            <Button
              type="button"
              size="lg"
              onClick={onRetry}
              className="flex-1"
            >
              <RotateCcw data-icon="inline-start" />
              다시 시도하기
            </Button>
          ) : null}
          <Link
            href="/"
            className={cn(
              buttonVariants({ size: "lg", variant: !isBizIssue && onRetry ? "outline" : "default" }),
              "flex-1",
            )}
          >
            사업자번호 다시 입력
          </Link>
        </div>

        <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
          문제가 계속되면 잠시 후 다시 시도하거나 고객센터로 알려주세요.
        </p>
        </CardContent>
      </Card>
    </div>
  );
}

function headerBadge(
  status: Status,
  maskedBiz: string | null,
): { text: string } {
  const label = maskedBiz ?? "사업자";

  if (status === "ready") return { text: `${label} 조회 완료` };
  if (status === "loading") return { text: `${label} 조회 중` };
  if (status === "error") return { text: `${label} 조회 중단` };
  return { text: "사업자 조회" };
}

/* ───────────────────────── helpers ───────────────────────── */

function buildProfileFields(
  teaser: TeaserResult,
): Array<{ key: string; label: string; value: string; available: boolean }> {
  const evidenceFields = teaser.companyEvidence?.fields;
  if (evidenceFields && evidenceFields.length > 0) {
    return evidenceFields.map((field: CompanyEvidenceField) => ({
      key: field.key,
      label: field.label,
      value: field.value ?? "",
      available: field.available && Boolean(field.value),
    }));
  }

  const attr = teaser.attributes;
  const ageLabel =
    attr.bizAgeMonths === null
      ? ""
      : `${Math.floor(attr.bizAgeMonths / 12)}년 ${attr.bizAgeMonths % 12}개월`;
  return [
    { key: "region", label: "소재 지역", value: attr.region ?? "", available: Boolean(attr.region) },
    { key: "size", label: "기업 규모", value: attr.size ?? "", available: Boolean(attr.size) },
    { key: "industry", label: "업종", value: attr.industry.join(", "), available: attr.industry.length > 0 },
    { key: "bizAge", label: "업력", value: ageLabel, available: attr.bizAgeMonths !== null },
  ];
}

function evidenceCheckedNote(evidence: TeaserResult["companyEvidence"]): string | null {
  if (!evidence || evidence.provider !== "popbill" || !evidence.checkedAt) return null;
  const checked = new Date(evidence.checkedAt);
  if (Number.isNaN(checked.getTime())) return null;
  const formatted = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(checked);
  const days = Math.floor((Date.now() - checked.getTime()) / 86_400_000);
  const staleSuffix = days >= 30 ? ` (${days}일 전)` : "";
  return `국세청·팝빌 정보 확인일 ${formatted}${staleSuffix}`;
}

function sparseRegistryNotice(evidence: TeaserResult["companyEvidence"]): { title: string; body: string } | null {
  if (!evidence || evidence.provider !== "popbill") return null;
  const fields = new Map(evidence.fields.map((field) => [field.key, field]));
  const checkedKeys = ["corp_name", "region", "biz_age", "industry"];
  const missingCheckedKeys = checkedKeys.filter((key) => !fields.get(key)?.available);
  const hasBusinessStatus = Boolean(fields.get("business_status")?.available);
  const providerSucceeded = evidence.resultMessage === "성공";
  if (!providerSucceeded || !hasBusinessStatus || missingCheckedKeys.length < 3) return null;

  return {
    title: "기관 데이터에 법인 기본정보가 아직 반영되지 않았을 수 있어요",
    body: "팝빌 조회는 성공했지만 상호, 소재지, 개업일, 업종 같은 기본 항목이 비어 있습니다. 설립 직후 법인은 국세청·연계기관 데이터 반영까지 시간이 걸릴 수 있어요. 사업자등록증이나 법인등기부 기준으로 빈 항목을 입력하면 매칭 정확도가 올라갑니다.",
  };
}

function eligibilityChip(value: Eligibility): { label: string } {
  if (value === "eligible") return { label: "적격" };
  if (value === "conditional") return { label: "조건부" };
  return { label: "미해당" };
}

function resultVisual(result: RuleTraceChipResult): { icon: React.ReactNode; text: string } {
  if (result === "pass")
    return { icon: <Check className="size-3" strokeWidth={3} />, text: "충족" };
  if (result === "unknown")
    return { icon: <HelpCircle className="size-3.5" />, text: "확인 필요" };
  return { icon: <Minus className="size-3" strokeWidth={3} />, text: "미해당" };
}

function kindVisual(kind: CriterionKind): { label: string } {
  if (kind === "preferred") return { label: "우대" };
  if (kind === "exclusion") return { label: "배제" };
  return { label: "필수" };
}

function formatAmount(amount: SupportAmount): string {
  if (amount.label) return amount.label;
  const max = amount.max ?? 0;
  if (max <= 0) return "금액 확인";
  if (max >= 100_000_000) return `최대 ${Math.round(max / 100_000_000).toLocaleString("ko-KR")}억원`;
  if (max >= 10_000) return `최대 ${Math.round(max / 10_000).toLocaleString("ko-KR")}만원`;
  return `최대 ${max.toLocaleString("ko-KR")}원`;
}

function formatDday(value: number | null): string {
  if (value === null) return "상시";
  if (value < 0) return "마감 확인";
  if (value === 0) return "D-Day";
  return `D-${value}`;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function maskBiz(digits: string): string {
  if (digits.length !== 10) return "사업자";
  return `${digits.slice(0, 3)}-**-${digits.slice(5, 7)}***`;
}
