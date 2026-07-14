import { Badge } from "@/components/ui/badge";
import { BizLookupForm } from "./biz-lookup-form";
import { LandingDemo } from "./landing-demo";

/**
 * 랜딩 v3 히어로. 유일한 행동은 사업자번호 조회이며, 아래 데모가
 * 조회 → 매칭 → 지원서 작성의 제품 흐름을 짧은 데모로 보여준다.
 */
export function LandingHero({ openCount, comparisonCount }: { openCount: number; comparisonCount: number }) {
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
        {openCount > 0 ? (
          <Badge
            variant="outline"
            className="gap-2 rounded-full border-brand-tint bg-card px-4 py-[7px] text-[13.5px] font-semibold text-text-nav shadow-[var(--shadow-landing-pill)]"
          >
            <span className="size-[7px] rounded-full bg-brand-mint" aria-hidden />
            지금 신청 가능한 지원사업 {openCount.toLocaleString("ko-KR")}건
          </Badge>
        ) : null}

        <h1 className="mt-6 text-[38px] leading-[1.25] font-extrabold tracking-[-1px] text-balance text-ink-strong sm:mt-[26px] sm:text-[54px] sm:tracking-[-1.4px]">
          사업자번호만 넣으면,
          <br />
          받을 수 있는 <span className="bg-landing-text bg-clip-text text-transparent">지원사업이 보여요</span>
        </h1>

        <p className="mt-4 text-base text-text-secondary sm:text-[17px]">
          회원가입 없이, 결과까지 30초 — 지금 내 회사로 바로 확인해보세요
        </p>

        <div className="mt-8 w-full sm:mt-9">
          <BizLookupForm inputId="hero-biz" attachRef />
        </div>
        <p className="mt-3.5 text-[13px] text-text-tertiary">입력 정보는 암호화돼요 · 광고 전화 없어요</p>

        <div className="mt-12 w-full sm:mt-14">
          <LandingDemo comparisonCount={comparisonCount} />
        </div>
      </div>
    </section>
  );
}
