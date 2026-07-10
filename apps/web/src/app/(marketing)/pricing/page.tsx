import { PricingView } from "@/features/pricing/PricingView";
import { getOptionalWebSession } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

// /pricing — 플랜·가격 페이지(공개, 설계 10.1). 상단 헤더는 (marketing) layout의 PublicHeader.
// 공개 라우트이므로 requireWebSession 하지 않고 getOptionalWebSession 으로 로그인 여부만 읽는다.
// 플랜/구독/충전 상품 데이터는 클라이언트 패널이 /api/web/plans 로 로드한다(공개 API).
export default async function PricingPage() {
  const session = await getOptionalWebSession();
  const isLoggedIn = session !== null;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-2">
          <span className="text-sm font-medium text-muted-foreground">플랜</span>
          <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
            크레딧 플랜 선택
          </h1>
          <p className="text-base leading-7 text-muted-foreground">
            매달 크레딧을 자동으로 충전받고 더 높은 보너스율로 이용하세요. 1 크레딧 = 1원 가치입니다.
          </p>
        </section>

        <PricingView isLoggedIn={isLoggedIn} />
      </div>
    </main>
  );
}
