import { BizLookupForm } from "./biz-lookup-form";
import { LandingDraftMock } from "./landing-draft-mock";

/** 디자인 2라운드(05 랜딩 히어로) 카피. 렌더 테스트가 같은 원천을 단언한다. */
export const LANDING_HERO_COPY = {
  eyebrow: "원본 HWP·HWPX 양식 그대로 · 회사 자료 기반 문항 작성",
  headline: ["회사 자료로 지원서를 씁니다.", "조건 확인은 보여주되,", "작성은 막지 않습니다."],
  sub: "관련 공고를 고르고 회사 자료와 이번 사업 설명을 연결하면, 문항마다 근거가 붙은 검토용 초안을 드려요. 확인된 사실과 계획, 아직 정하지 않은 것을 구분하고, 최종 문장은 대표님이 고릅니다.",
  cta: "내 회사로 시작",
  trust: "자격 조건은 확인된 것과 남은 것을 그대로 보여드려요. 판정도 문장도 대표님이 결정합니다.",
} as const;

/**
 * 랜딩 히어로(디자인 2라운드 05, 작성 중심). 좌측은 카피와 사업자번호 조회, 우측은
 * 문항별 검토용 초안 카드 목업이다. 유일한 행동은 사업자번호 조회다.
 */
export function LandingHero() {
  return (
    <section className="relative overflow-hidden bg-landing-hero">
      <span
        aria-hidden
        className="pointer-events-none absolute -top-56 -left-36 size-[640px] rounded-full bg-landing-orb-blue"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -top-28 -right-28 size-[560px] rounded-full bg-landing-orb-mint"
      />
      <div className="relative mx-auto grid max-w-[1200px] gap-9 px-5 pt-12 pb-14 sm:px-10 sm:pt-[72px] sm:pb-20 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] lg:items-center lg:gap-12">
        <div className="text-left">
          <p className="text-[13px] font-extrabold tracking-[0.02em] break-keep text-brand">{LANDING_HERO_COPY.eyebrow}</p>

          <h1 className="mt-[18px] text-[32px] leading-[1.24] font-extrabold tracking-[-0.8px] break-keep text-ink-strong sm:text-[44px] sm:tracking-[-1.2px]">
            {LANDING_HERO_COPY.headline.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </h1>

          <p className="mt-6 max-w-[580px] text-base leading-[1.6] break-keep text-text-nav sm:text-[19px]">
            {LANDING_HERO_COPY.sub}
          </p>

          <div className="mt-8 w-full">
            <BizLookupForm inputId="hero-biz" attachRef ctaLabel={LANDING_HERO_COPY.cta} className="mx-0 max-w-[560px]" />
          </div>
          <p className="mt-3.5 max-w-[560px] text-sm break-keep text-text-secondary">{LANDING_HERO_COPY.trust}</p>
        </div>

        <LandingDraftMock className="lg:-rotate-[1.2deg]" />
      </div>
    </section>
  );
}
