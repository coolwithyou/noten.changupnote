import type { ApplySheet } from "@cunote/contracts";
import Link from "next/link";
import { VerdictBadge } from "@/components/app/verdict-badge";
import { Accordion } from "@/components/ui/accordion";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { GrantPreviewAvailability } from "@/lib/server/documents/documentPreview";
import type { GrantLessonGuideDto } from "@/lib/server/knowledge/lessonContext";
import { ConversionPollTrigger } from "@/features/apply-sheet/ConversionPollTrigger";
import { EligibilityMatchAccordion } from "./EligibilityMatchAccordion";
import { RequiredDocumentsAccordion } from "./RequiredDocumentsAccordion";
import { LessonGuideAccordion } from "./LessonGuideAccordion";
import {
  formatDday,
  formatEligibilitySummary,
  formatSupportAmount,
  grantOverviewCta,
  grantOverviewVerdict,
} from "./logic";

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
  const verdict = grantOverviewVerdict(sheet);
  const cta = grantOverviewCta(sheet, previewAvailability);
  const showConversionPoll = (previewAvailability?.pendingSurfaceCount ?? 0) > 0;

  return (
    <div className="mx-auto w-full max-w-[680px] px-5 py-8 sm:px-0 sm:py-14 sm:pb-18">
      {/* ① 상태 뱃지 · 제목 · 기관 */}
      <header className="flex flex-col items-start">
        <VerdictBadge status={verdict} />
        <h1 className="mt-3.5 text-[26px] leading-[1.35] font-extrabold tracking-[-0.6px] text-ink sm:text-[30px]">
          {sheet.grant.title}
        </h1>
        <p className="mt-2 text-[15px] text-text-secondary">
          {sheet.grant.agency ?? "운영기관 확인 필요"}
        </p>
      </header>

      {/* ② 핵심 3지표 */}
      <section className="mt-7" aria-label="공고 핵심 정보">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] overflow-hidden rounded-2xl border border-border-subtle">
          <GrantMetric label="마감" value={formatDday(sheet.schedule.dDay)} />
          <Separator orientation="vertical" />
          <GrantMetric label="지원 금액" value={formatSupportAmount(sheet.grant.supportAmount)} />
          <Separator orientation="vertical" />
          <GrantMetric
            label="지원 대상"
            value={formatEligibilitySummary(sheet.satisfied.length, sheet.needsCheck.length)}
          />
        </dl>
      </section>

      {/* ③ 작성 지원 모드별 주 CTA 1개 */}
      <section className="mt-6">
        <Link
          href={workspaceHref}
          className={buttonVariants({
            variant: cta.variant,
            size: "lg",
            className: "w-full text-balance whitespace-normal",
          })}
        >
          {cta.label}
        </Link>
        <p className="mt-2.5 text-center text-[13px] leading-5 text-text-tertiary">{cta.caption}</p>
      </section>
      {showConversionPoll ? <ConversionPollTrigger grantId={grantId} /> : null}

      {/* ④ 접힌 아코디언 3개(기본 닫힘) */}
      <section className="mt-9 border-t border-border-subtle">
        <Accordion multiple>
          <EligibilityMatchAccordion
            satisfied={sheet.satisfied}
            needsCheck={sheet.needsCheck}
            sourceUrl={sheet.deepLink}
          />
          <RequiredDocumentsAccordion documents={sheet.documents} sourceAttachments={sheet.sourceAttachments} />
          <LessonGuideAccordion guide={lessonGuide} />
        </Accordion>
      </section>

      {/* ⑤ 푸터 링크 2개 */}
      <footer className="mt-8 flex flex-wrap items-center justify-center gap-5 text-sm font-semibold text-text-secondary">
        {sheet.deepLink ? (
          <a
            className="underline-offset-4 transition-colors hover:text-ink hover:underline"
            href={sheet.deepLink}
            target="_blank"
            rel="noreferrer"
          >
            공고 원문 보기
          </a>
        ) : (
          <span className="text-text-quaternary" aria-disabled="true">공고 원문 확인 필요</span>
        )}
        <Link
          className="underline-offset-4 transition-colors hover:text-ink hover:underline"
          href={`/support?category=product&topic=${encodeURIComponent(sheet.grant.title)}`}
        >
          도움받기
        </Link>
      </footer>
    </div>
  );
}

function GrantMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-2 py-5 text-center sm:px-5">
      <dt className="text-[12.5px] font-semibold text-text-tertiary">{label}</dt>
      <dd className="mt-1.5 text-[15px] leading-snug font-extrabold break-keep text-ink tabular-nums sm:text-[19px]">
        {value}
      </dd>
    </div>
  );
}
