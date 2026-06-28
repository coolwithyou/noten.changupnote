"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, HelpCircle, Loader2, Minus, Plus } from "lucide-react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";

type Status = "idle" | "loading" | "ready" | "error" | "empty";

export function MatchesExperience() {
  const [status, setStatus] = useState<Status>("loading");
  const [teaser, setTeaser] = useState<TeaserResult | null>(null);
  const [bizNo, setBizNo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const digits = (params.get("biz") ?? "").replace(/\D/g, "").slice(0, 10);
    if (digits.length !== 10) {
      setStatus("empty");
      return;
    }
    setBizNo(digits);
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/web/teaser", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bizNo: digits } satisfies TeaserRequest),
        });
        const payload = (await response.json()) as ActionResult<TeaserResult>;
        if (!response.ok || !payload.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "매칭 결과를 불러오지 못했습니다.");
        }
        if (!active) return;
        setTeaser(payload.data);
        setStatus("ready");
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "매칭 결과를 불러오지 못했습니다.");
        setStatus("error");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

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
    <div className="cunote-matches min-h-screen w-full overflow-x-hidden bg-background">
      <MatchesNav onSave={saveAndContinue} />

      <header
        className="relative overflow-hidden px-[var(--m-px)] pb-[var(--m-hpb)] pt-[var(--m-hpt)]"
        style={{ backgroundImage: "var(--grad-mesh)" }}
      >
        <div className="cunote-grain" aria-hidden />
        <div className="relative z-[2] mx-auto max-w-[1080px]">
          <div
            className="mb-4 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold"
            style={{
              color: "var(--tds-fill-success)",
              background: "var(--brand-mint-soft)",
              borderColor: "color-mix(in srgb, var(--tds-fill-success) 24%, transparent)",
            }}
          >
            {status === "ready" && teaser?.companyEvidence?.maskedBizNo
              ? `${teaser.companyEvidence.maskedBizNo} 조회 완료`
              : bizNo
                ? `${maskBiz(bizNo)} 조회 완료`
                : "사업자 조회"}
          </div>
          <h1 className="text-[length:var(--m-h1)] font-extrabold leading-[1.22] tracking-[-0.035em] text-[var(--tds-grey-900)]">
            {status === "ready" && teaser ? (
              <>
                지원 가능한 사업{" "}
                <span className="bg-[image:var(--lp-grad-text)] bg-clip-text text-transparent">
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
          <p className="mt-2.5 text-[length:var(--m-sub)] text-[var(--tds-grey-500)]">
            내 사업자 정보를 표준 조건과 대조한 결과예요. 조건마다 충족 여부를 함께 보여드려요.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] px-[var(--m-px)] pb-20 pt-[var(--m-mpt)]">
        {status === "loading" ? <LoadingState /> : null}
        {status === "empty" ? <EmptyState /> : null}
        {status === "error" ? <ErrorState message={error} /> : null}
        {status === "ready" && teaser ? (
          <>
            <ProfileSection teaser={teaser} />
            <ProgramsSection matches={teaser.matches} onPrepare={saveAndContinue} />
          </>
        ) : null}
      </main>
    </div>
  );
}

/* ───────────────────────── Nav ───────────────────────── */

function MatchesNav({ onSave }: { onSave: () => void }) {
  return (
    <nav
      className="sticky top-0 z-[60] flex items-center justify-between gap-4 border-b border-border px-[var(--m-px)] py-3.5 backdrop-blur-[14px]"
      style={{ background: "color-mix(in srgb, var(--background) 82%, transparent)" }}
    >
      <Link href="/" className="flex items-center gap-2.5 text-[17px] font-extrabold tracking-[-0.03em] text-[var(--tds-grey-900)]">
        <BrandMark className="size-[26px]" />
        <span>창업노트</span>
      </Link>
      <Button type="button" size="sm" className="rounded-full px-4" onClick={onSave}>
        결과 저장하기
      </Button>
    </nav>
  );
}

/* ───────────────────────── 내 사업자 분석 ───────────────────────── */

function ProfileSection({ teaser }: { teaser: TeaserResult }) {
  const fields = buildProfileFields(teaser);
  const known = fields.filter((field) => field.available).length;
  const total = fields.length || 1;
  const pct = Math.round((known / total) * 100);

  return (
    <section className="mb-[var(--m-sec-mb)]">
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[length:var(--m-h2)] font-extrabold tracking-[-0.03em] text-[var(--tds-grey-900)]">
            내 사업자 분석
          </h2>
          <p className="mt-1.5 text-[13.5px] text-[var(--tds-grey-500)]">
            사업자번호로 불러온 정보를 시스템 표준 조건으로 정규화했어요.
          </p>
        </div>
        <div className="min-w-[240px] max-w-[340px] flex-1">
          <div className="mb-2 flex items-center justify-between text-[12.5px]">
            <span className="font-semibold text-[var(--tds-grey-700)]">정보 충족도</span>
            <span className="font-extrabold text-primary">
              {known} / {total} 확정
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-[image:var(--lp-grad-bar)]"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[var(--m-grid)] gap-3">
        {fields.map((field) =>
          field.available ? (
            <div
              key={field.key}
              className="rounded-[var(--tds-radius-xs)] border border-border bg-card px-4 pb-3.5 pt-4 shadow-[var(--shadow-subtle)]"
            >
              <div className="mb-2 text-[12px] font-semibold text-[var(--tds-grey-500)]">{field.label}</div>
              <div className="mb-2.5 text-[16px] font-bold leading-[1.3] tracking-[-0.02em] text-[var(--tds-grey-900)]">
                {field.value}
              </div>
              <div
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                style={{ background: "var(--brand-mint-soft)", color: "var(--tds-fill-success)" }}
              >
                <span className="size-1.5 rounded-full" style={{ background: "var(--tds-fill-success)" }} />
                {field.source}
              </div>
            </div>
          ) : (
            <div
              key={field.key}
              className="rounded-[var(--tds-radius-xs)] border-[1.5px] border-dashed px-4 pb-3.5 pt-4"
              style={{ background: "var(--tds-blue-50)", borderColor: "var(--tds-blue-100)" }}
            >
              <div className="mb-2 text-[12px] font-semibold text-[var(--tds-grey-500)]">{field.label}</div>
              <div className="mb-2.5 text-[16px] font-bold leading-[1.3] tracking-[-0.02em] text-[var(--tds-grey-400)]">
                미입력
              </div>
              <span className="inline-flex items-center gap-1 text-[11.5px] font-bold text-primary">
                <Plus className="size-3" strokeWidth={3} />
                입력하기
              </span>
            </div>
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
        <h2 className="mb-4 text-[length:var(--m-h2)] font-extrabold tracking-[-0.03em] text-[var(--tds-grey-900)]">
          지원 가능한 사업
        </h2>
        <div className="rounded-[var(--tds-radius-m)] border border-border bg-card p-8 text-center text-[14px] text-[var(--tds-grey-500)]">
          아직 적격으로 확인된 사업이 없어요. 정보를 더 입력하면 매칭 범위가 넓어져요.
        </div>
      </section>
    );
  }
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-[length:var(--m-h2)] font-extrabold tracking-[-0.03em] text-[var(--tds-grey-900)]">
          지원 가능한 사업
        </h2>
        <div className="flex flex-wrap items-center gap-3.5 text-[12px] text-[var(--tds-grey-500)]">
          <LegendDot icon={<Check className="size-2.5" strokeWidth={3} />} bg="var(--brand-mint-soft)" color="var(--tds-fill-success)">
            충족
          </LegendDot>
          <LegendDot icon="?" bg="var(--tds-fill-warning-weak)" color="var(--tds-icon-warning)">
            확인 필요
          </LegendDot>
          <LegendDot icon={<Minus className="size-2.5" strokeWidth={3} />} bg="var(--tds-grey-100)" color="var(--tds-grey-500)">
            미해당
          </LegendDot>
        </div>
      </div>

      <div className="flex flex-col gap-3.5">
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

  return (
    <div className="overflow-hidden rounded-[var(--tds-radius-m)] border border-border bg-card shadow-[var(--shadow-subtle)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="w-full cursor-pointer px-[22px] py-5 text-left"
      >
        <div className="flex flex-wrap justify-between gap-[18px]">
          <div className="min-w-[220px] flex-1">
            <div className="mb-2 flex items-center gap-1.5">
              <span
                className="rounded-lg px-2.5 py-1 text-[11.5px] font-bold"
                style={{ background: elig.bg, color: elig.color }}
              >
                {elig.label}
              </span>
              <span
                className="rounded-lg px-2.5 py-1 text-[11.5px] font-bold"
                style={
                  match.dDay !== null && match.dDay <= 7
                    ? { background: "var(--tds-fill-warning-weak)", color: "var(--tds-text-warning)" }
                    : { background: "var(--tds-grey-100)", color: "var(--tds-grey-500)" }
                }
              >
                {formatDday(match.dDay)}
              </span>
            </div>
            <div className="text-[17.5px] font-bold leading-[1.32] tracking-[-0.02em] text-[var(--tds-grey-900)]">
              {match.title}
            </div>
            <div className="mt-1.5 text-[13px] text-[var(--tds-grey-500)]">
              {match.agency ?? "운영기관 확인"} · {formatAmount(match.supportAmount)}
            </div>
          </div>
          <div className="min-w-[150px] flex-none text-right">
            <div className="mb-0.5 text-[12px] text-[var(--tds-grey-500)]">적합도</div>
            <div className="text-[26px] font-extrabold leading-none tracking-[-0.03em] text-primary [font-variant-numeric:tabular-nums]">
              {match.fitScore}%
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-[image:var(--lp-grad-bar)]"
                style={{ width: `${clampPct(match.fitScore)}%` }}
              />
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-[var(--tds-grey-100)] pt-3.5">
          <span className="text-[12.5px] text-[var(--tds-grey-500)]">
            조건 {criteria.length} · 충족 {passCount}
          </span>
          <span className="flex items-center gap-1 text-[12.5px] font-bold text-primary">
            {open ? "접기" : "조건 자세히 보기"}
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </span>
        </div>
      </button>

      {open ? (
        <div className="border-t border-border px-[22px] pb-[22px] pt-5" style={{ background: "var(--tds-bg-lower)" }}>
          <div className="mb-3 text-[12.5px] font-extrabold tracking-[0.02em] text-[var(--tds-grey-600)]">적합 조건</div>
          {criteria.length > 0 ? (
            <div className="mb-5 flex flex-col gap-2">
              {criteria.map((chip, index) => (
                <CriterionRow key={`${chip.dimension}-${index}`} chip={chip} />
              ))}
            </div>
          ) : (
            <p className="mb-5 text-[13px] text-[var(--tds-grey-500)]">표시할 세부 조건이 없어요.</p>
          )}
          <p className="mb-4 text-[12px] text-[var(--tds-grey-400)]">
            필요 서류와 사업계획서 초안은 결과 저장 후 신청 준비 단계에서 회사 정보로 채워 안내해 드려요.
          </p>
          <button
            type="button"
            onClick={onPrepare}
            className={cn(buttonVariants({ size: "default" }), "rounded-[var(--tds-radius-xxs)]")}
          >
            이 사업 신청 준비하기
            <ArrowRight data-icon="inline-end" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CriterionRow({ chip }: { chip: RuleTraceChip }) {
  const result = resultVisual(chip.result);
  const kind = kindVisual(chip.kind);
  return (
    <div className="flex items-start gap-3 rounded-[var(--tds-radius-xxs)] border border-border bg-card px-[15px] py-3">
      <span
        className="mt-0.5 flex size-[22px] flex-none items-center justify-center rounded-full text-[11px] font-extrabold"
        style={{ background: result.bg, color: result.color }}
      >
        {result.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-md px-1.5 py-0.5 text-[10.5px] font-bold" style={{ background: kind.bg, color: kind.color }}>
            {kind.label}
          </span>
          <span className="text-[14px] font-semibold text-[var(--tds-grey-900)]">{chip.label}</span>
        </div>
        {chip.companyValue ? (
          <div className="mt-1 text-[12.5px] text-[var(--tds-grey-500)]">{chip.companyValue}</div>
        ) : null}
      </div>
      <span className="flex-none self-center text-[12.5px] font-bold" style={{ color: result.color }}>
        {result.text}
      </span>
    </div>
  );
}

function LegendDot({
  icon,
  bg,
  color,
  children,
}: {
  icon: React.ReactNode;
  bg: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="flex size-4 items-center justify-center rounded-full text-[9px] font-extrabold"
        style={{ background: bg, color }}
      >
        {icon}
      </span>
      {children}
    </span>
  );
}

/* ───────────────────────── states ───────────────────────── */

function LoadingState() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-[var(--m-grid)] gap-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-[104px] rounded-[var(--tds-radius-xs)]" />
        ))}
      </div>
      <div className="flex flex-col gap-3.5">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-[132px] rounded-[var(--tds-radius-m)]" />
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-[460px] rounded-[var(--tds-radius-l)] border border-border bg-card p-9 text-center shadow-[var(--shadow-subtle)]">
      <h2 className="mb-2 text-[19px] font-extrabold text-[var(--tds-grey-900)]">조회할 사업자번호가 없어요</h2>
      <p className="mb-6 text-[14px] leading-[1.6] text-[var(--tds-grey-500)]">
        첫 화면에서 사업자번호를 입력하면 받을 수 있는 지원사업을 찾아드려요.
      </p>
      <Link href="/" className={cn(buttonVariants({ size: "lg" }), "rounded-[var(--tds-radius-xxs)]")}>
        사업자번호 입력하러 가기
      </Link>
    </div>
  );
}

function ErrorState({ message }: { message: string | null }) {
  return (
    <div className="mx-auto max-w-[460px]">
      <Alert variant="destructive" className="mb-5">
        <AlertDescription>{message ?? "매칭 결과를 불러오지 못했습니다."}</AlertDescription>
      </Alert>
      <div className="text-center">
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "rounded-[var(--tds-radius-xxs)]")}>
          처음 화면으로
        </Link>
      </div>
    </div>
  );
}

/* ───────────────────────── helpers ───────────────────────── */

function buildProfileFields(
  teaser: TeaserResult,
): Array<{ key: string; label: string; value: string; source: string; available: boolean }> {
  const evidenceFields = teaser.companyEvidence?.fields;
  if (evidenceFields && evidenceFields.length > 0) {
    const providerLabel = teaser.companyEvidence?.provider === "popbill" ? "팝빌 연동" : "조회 결과";
    return evidenceFields.map((field: CompanyEvidenceField) => ({
      key: field.key,
      label: field.label,
      value: field.value ?? "",
      source: providerLabel,
      available: field.available && Boolean(field.value),
    }));
  }

  const attr = teaser.attributes;
  const ageLabel =
    attr.bizAgeMonths === null
      ? ""
      : `${Math.floor(attr.bizAgeMonths / 12)}년 ${attr.bizAgeMonths % 12}개월`;
  return [
    { key: "region", label: "소재 지역", value: attr.region ?? "", source: "등록 정보", available: Boolean(attr.region) },
    { key: "size", label: "기업 규모", value: attr.size ?? "", source: "등록 정보", available: Boolean(attr.size) },
    { key: "industry", label: "업종", value: attr.industry.join(", "), source: "업종 코드", available: attr.industry.length > 0 },
    { key: "bizAge", label: "업력", value: ageLabel, source: "개업일 기준", available: attr.bizAgeMonths !== null },
  ];
}

function eligibilityChip(value: Eligibility): { label: string; bg: string; color: string } {
  if (value === "eligible") return { label: "적격", bg: "var(--brand-mint-soft)", color: "var(--tds-fill-success)" };
  if (value === "conditional") return { label: "조건부", bg: "var(--tds-fill-warning-weak)", color: "var(--tds-text-warning)" };
  return { label: "미해당", bg: "var(--tds-grey-100)", color: "var(--tds-grey-500)" };
}

function resultVisual(result: RuleTraceChipResult): { icon: React.ReactNode; text: string; bg: string; color: string } {
  if (result === "pass")
    return { icon: <Check className="size-3" strokeWidth={3} />, text: "충족", bg: "var(--brand-mint-soft)", color: "var(--tds-fill-success)" };
  if (result === "unknown")
    return { icon: <HelpCircle className="size-3.5" />, text: "확인 필요", bg: "var(--tds-fill-warning-weak)", color: "var(--tds-icon-warning)" };
  return { icon: <Minus className="size-3" strokeWidth={3} />, text: "미해당", bg: "var(--tds-grey-100)", color: "var(--tds-grey-500)" };
}

function kindVisual(kind: CriterionKind): { label: string; bg: string; color: string } {
  if (kind === "preferred") return { label: "우대", bg: "var(--brand-mint-soft)", color: "var(--tds-fill-success)" };
  if (kind === "exclusion") return { label: "배제", bg: "var(--tds-fill-danger-weak)", color: "var(--tds-fill-danger)" };
  return { label: "필수", bg: "var(--tds-blue-50)", color: "var(--tds-text-brand)" };
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

function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden role="presentation">
      <defs>
        <linearGradient id="cunote-matches-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--brand-mint)" />
        </linearGradient>
      </defs>
      <rect x="5" y="5" width="38" height="38" rx="11" fill="url(#cunote-matches-logo)" />
      <path d="M15.5 24.5 l5.5 5.5 l11.5 -13.5" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
