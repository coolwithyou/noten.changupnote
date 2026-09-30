import { BizLookupForm } from "./biz-lookup-form";
import { LandingDemo } from "./landing-demo";

/** 디자인 2라운드(05 랜딩 히어로) 카피. 렌더 테스트가 같은 원천을 단언한다. */
export const LANDING_HERO_COPY = {
  eyebrow: "원본 HWP·HWPX 양식 그대로 · 회사 자료 기반 문항 작성",
  headline: ["회사 자료로 지원서를 씁니다.", "조건 확인은 보여주되,", "작성은 막지 않습니다."],
  sub: "관련 공고를 고르고 회사 자료와 이번 사업 설명을 연결하면, 문항마다 근거가 붙은 검토용 초안을 드려요. 확인된 사실과 계획, 아직 정하지 않은 것을 구분하고, 최종 문장은 대표님이 고릅니다.",
  cta: "내 회사로 시작",
  trust: "자격 조건은 확인된 것과 남은 것을 그대로 보여드려요. 판정도 문장도 대표님이 결정합니다.",
} as const;

/**
 * 랜딩 히어로(작성 중심 교체안). 유일한 행동은 사업자번호 조회이며, 아래 데모가
 * 조회 → 매칭 → 지원서 작성의 제품 흐름을 짧은 데모로 보여준다.
 * openCount는 페이지 계약을 유지하려고 받지만, 디자인 2라운드 히어로에는 공고 수 필이 없어 표시하지 않는다.
 */
export function LandingHero({ comparisonCount }: { openCount: number; comparisonCount: number }) {
  const [line1, line2, line3] = LANDING_HERO_COPY.headline;
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
      <div className="relative mx-auto flex max-w-[1440px] flex-col items-center px-4 pt-16 text-center sm:px-10 sm:pt-[88px]">
        <p className="text-[13px] font-extrabold tracking-[0.02em] break-keep text-brand">{LANDING_HERO_COPY.eyebrow}</p>

        <h1 className="mt-5 text-[38px] leading-[1.25] font-extrabold tracking-[-1px] break-keep text-balance text-ink-strong sm:mt-[18px] sm:text-[54px] sm:tracking-[-1.4px]">
          <span className="bg-landing-text bg-clip-text text-transparent">{line1}</span>
          <br className="hidden sm:inline" />
          {" "}
          {line2}
          <br className="hidden sm:inline" />
          {" "}
          {line3}
        </h1>

        <p className="mx-auto mt-4 max-w-[680px] text-base break-keep text-text-secondary sm:text-[17px]">
          {LANDING_HERO_COPY.sub}
        </p>

        <div className="mt-8 w-full sm:mt-9">
          <BizLookupForm inputId="hero-biz" attachRef ctaLabel={LANDING_HERO_COPY.cta} />
        </div>
        <p className="mt-3.5 max-w-[680px] text-[13px] break-keep text-text-tertiary">{LANDING_HERO_COPY.trust}</p>

        <div className="mt-12 w-full sm:mt-14">
          <LandingDemo comparisonCount={comparisonCount} />
        </div>
      </div>
    </section>
  );
}
