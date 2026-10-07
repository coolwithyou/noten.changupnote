import { BizLookupForm } from "./biz-lookup-form";

/**
 * 히어로와 같은 조회 컨트롤러를 쓰는 마지막 단일 CTA.
 */
export function FinalCta() {
  return (
    <section className="px-4 pb-20 sm:px-10 sm:pb-[88px]">
      <div className="mx-auto max-w-[1000px] rounded-[28px] bg-landing-final px-4 py-14 text-center sm:px-10 sm:py-[72px]">
        <h2 className="text-[28px] font-extrabold tracking-[-0.7px] text-balance text-ink-strong sm:text-[34px]">
          사업자번호 하나로 지금 바로 시작하세요
        </h2>
        <div className="mt-[30px]">
          <BizLookupForm inputId="cta-biz" className="max-w-[560px]" variant="compact" />
        </div>
      </div>
    </section>
  );
}
