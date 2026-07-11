import { Lock } from "lucide-react";
import { BizLookupForm } from "./biz-lookup-form";

/**
 * 하단 CTA = Brand zone(brand-band 밴드). 흰 입력 카드가 어두운 밴드 위에서 또렷하게 뜬다.
 * 히어로와 동일한 조회 컨트롤러를 컨텍스트로 공유한다.
 */
export function FinalCta() {
  return (
    <section className="texture-grain bg-brand-band relative overflow-hidden text-primary-foreground" data-zone="brand">
      <div className="mx-auto max-w-2xl px-4 py-20 text-center sm:px-6">
        <h2 className="text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
          사업자번호 하나로
          <br />
          지금 바로 시작하세요
        </h2>
        <p className="mt-4 text-lg text-primary-foreground/80">
          회원가입 없이 30초면 받을 수 있는 지원사업을 확인할 수 있어요.
        </p>
        <div className="mt-9">
          <BizLookupForm inputId="cta-biz" />
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-primary-foreground/70">
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-4" /> 안전하게 암호화
          </span>
          <span>회원가입 불필요</span>
        </div>
      </div>
    </section>
  );
}
