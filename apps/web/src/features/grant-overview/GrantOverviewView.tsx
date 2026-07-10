import type { ApplySheet, BenefitBadge, SupportAmount } from "@cunote/contracts";
import { ExternalLink, MessageCircleQuestion } from "lucide-react";
import Link from "next/link";
import { MetricCard } from "@/components/app/metric-card";
import { StatusBadge } from "@/components/app/status-badge";
import { Accordion } from "@/components/ui/accordion";
import { buttonVariants } from "@/components/ui/button";
import type { GrantPreviewAvailability } from "@/lib/server/documents/documentPreview";
import type { GrantLessonGuideDto } from "@/lib/server/knowledge/lessonContext";
import { ConversionPollTrigger } from "@/features/apply-sheet/ConversionPollTrigger";
import { EligibilityMatchAccordion } from "./EligibilityMatchAccordion";
import { RequiredDocumentsAccordion } from "./RequiredDocumentsAccordion";
import { LessonGuideAccordion } from "./LessonGuideAccordion";

/**
 * `/grants/[grantId]` 미니멀 요약 뷰 (계획 docs/plans/2026-07-09-apply-experience-v2.md §4.2, §8 Phase 1).
 *
 * "읽는 페이지" — 30초 안에 "나에게 해당되나? 무엇을 받나? 언제까지인가?"에 답하고 끝낸다.
 * 작성에 관한 모든 것(초안·필드 매핑·프로필 복사 등)은 workspace(Phase 2)로 이관됐다.
 *
 * 구조는 §4.2 그대로 5개다: ① 헤더 ② 핵심 3지표 ③ 주 CTA 1개 ④ 접힌 아코디언(기본 닫힘) ⑤ 푸터.
 * 금지: 입력 필드·편집기·테이블, CTA 총 4개(주1+부3) 초과. 로더는 그대로 재사용(최적화 없음).
 */
export function GrantOverviewView({
  sheet,
  lessonGuide = null,
  previewAvailability = null,
}: {
  sheet: ApplySheet;
  lessonGuide?: GrantLessonGuideDto | null;
  previewAvailability?: GrantPreviewAvailability | null;
}) {
  const grantId = sheet.grant.id;
  const workspaceHref = `/grants/${encodeURIComponent(grantId)}/workspace`;
  // 변환 상태가 CTA 라벨을 결정한다(§4.2-3). 문서 프리뷰가 준비된 surface 가 있어야
  // "지원서 작성 시작", 그 전까지는 채팅으로 먼저 물어보라는 정직한 라벨(같은 링크).
  const hwpxReady = (previewAvailability?.readySurfaceCount ?? 0) > 0;
  const ctaLabel = hwpxReady ? "지원서 작성 시작" : "서류 준비 중 — 채팅으로 먼저 물어보기";
  const showConversionPoll = (previewAvailability?.pendingSurfaceCount ?? 0) > 0;
  const benefitsCaption = formatBenefitsCaption(sheet.grant.benefits);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
        {/* ① 헤더: 공고 제목 · 주관기관 · 상태 뱃지 */}
        <section className="grid gap-3 rounded-[var(--radius-xl)] border bg-card p-6 shadow-[var(--shadow-subtle)]">
          <StatusBadge tone={grantStatusTone(sheet.grant.status)} className="justify-self-start">
            {grantStatusLabel(sheet.grant.status)}
          </StatusBadge>
          <h1 className="text-2xl font-semibold tracking-normal sm:text-3xl">{sheet.grant.title}</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {sheet.grant.agency ?? "운영기관 확인 필요"}
          </p>
        </section>

        {/* ② 핵심 3지표: 마감 D-day · 지원 금액 · 지원 대상 요약 */}
        <section className="grid gap-3 sm:grid-cols-3">
          <MetricCard
            label="마감"
            value={formatDday(sheet.schedule.dDay)}
            detail={formatDateRange(sheet.schedule.applyStart, sheet.schedule.applyEnd)}
          />
          <MetricCard label="지원 금액" value={formatSupportAmount(sheet.grant.supportAmount)} />
          <MetricCard
            label="지원 대상"
            value={formatEligibilitySummary(sheet.satisfied.length, sheet.needsCheck.length)}
            {...(benefitsCaption !== undefined ? { detail: benefitsCaption } : {})}
          />
        </section>

        {/* ③ 주 CTA 1개 */}
        <section className="grid justify-items-start gap-2 rounded-[var(--radius-xl)] border bg-muted/20 p-5">
          <Link href={workspaceHref} className={buttonVariants({ size: "lg" })}>
            {ctaLabel}
          </Link>
          {sheet.applyMethod ? (
            <p className="text-xs text-muted-foreground">접수 방법: {sheet.applyMethod}</p>
          ) : null}
        </section>
        {showConversionPoll ? <ConversionPollTrigger grantId={grantId} /> : null}

        {/* ④ 접힌 아코디언 3개(기본 닫힘) */}
        <section className="rounded-[var(--radius-xl)] border bg-card px-5">
          <Accordion multiple>
            <EligibilityMatchAccordion satisfied={sheet.satisfied} needsCheck={sheet.needsCheck} />
            <RequiredDocumentsAccordion documents={sheet.documents} sourceAttachments={sheet.sourceAttachments} />
            <LessonGuideAccordion guide={lessonGuide} />
          </Accordion>
        </section>

        {/* ⑤ 푸터 행(작게): 공고 원문 링크 · 도움받기 */}
        <section className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          {sheet.deepLink ? (
            <a
              className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline"
              href={sheet.deepLink}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              공고 원문 보기
            </a>
          ) : (
            <span>공고 원문 확인 필요</span>
          )}
          <Link
            className="inline-flex items-center gap-1.5 underline-offset-4 hover:text-foreground hover:underline"
            href={`/support?category=product&topic=${encodeURIComponent(sheet.grant.title)}`}
          >
            <MessageCircleQuestion className="size-3.5" aria-hidden />
            도움받기
          </Link>
        </section>
    </div>
  );
}

// 내 회사 기준 자격 매칭 상태를 "지원 대상" 지표로 요약한다. 공고 원문의 "지원 대상" 문구 자체는
// ApplySheet DTO 에 없어(로더 계약 무변경 — 로더 최적화 금지) 매칭 결과(satisfied/needsCheck)를
// 정직한 대체 지표로 쓴다. 두 값 모두 0이면 아직 매칭이 산출되지 않은 것.
function formatEligibilitySummary(satisfiedCount: number, needsCheckCount: number): string {
  if (satisfiedCount === 0 && needsCheckCount === 0) return "매칭 확인 중";
  return `충족 ${satisfiedCount.toLocaleString("ko-KR")} · 확인 필요 ${needsCheckCount.toLocaleString("ko-KR")}`;
}

function formatBenefitsCaption(benefits: BenefitBadge[]): string | undefined {
  if (benefits.length === 0) return undefined;
  return benefits.slice(0, 3).map((benefit) => benefit.label).join(" · ");
}

function formatSupportAmount(amount: SupportAmount): string {
  if (amount.label) return amount.label;
  if (!amount.max) return "금액 미확인";
  return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
}

function formatDday(value: number | null): string {
  if (value === null) return "일정 확인";
  if (value < 0) return "마감 확인";
  if (value === 0) return "오늘 마감";
  return `D-${value}`;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "일정 확인";
  if (!start) return `${end} 마감`;
  if (!end) return `${start} 시작`;
  return `${start} - ${end}`;
}

function grantStatusLabel(status: ApplySheet["grant"]["status"]): string {
  if (status === "open") return "접수중";
  if (status === "upcoming") return "예정";
  if (status === "closed") return "마감";
  return "확인 필요";
}

function grantStatusTone(status: ApplySheet["grant"]["status"]): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "upcoming") return "warning";
  return "neutral";
}
