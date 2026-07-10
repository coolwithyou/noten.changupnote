import { appHeaderLinks } from "@/components/app/app-navigation";
import { ServiceHeader } from "@/components/app/service-header";
import { CreditsPurchasePanel } from "@/features/credits/CreditsPurchasePanel";
import { RecentOrdersList } from "@/features/credits/RecentOrdersList";
import { getOptionalHeaderUser, requireWebSession } from "@/lib/server/auth/session";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";

export const dynamic = "force-dynamic";

// /credits — 충전 페이지(세션, 설계 10.2). 잔액 + 만료 경고 + 상품 그리드 + 최근 내역.
export default async function CreditsPage() {
  try {
    await requireWebSession();
  } catch (error) {
    redirectOnAuthRequired(error, "/credits");
  }
  const user = await getOptionalHeaderUser();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <ServiceHeader user={user} links={appHeaderLinks({ currentHref: "/credits" })} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-2">
          <span className="text-sm font-medium text-muted-foreground">크레딧</span>
          <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">크레딧 충전</h1>
          <p className="text-base leading-7 text-muted-foreground">
            AI 작업(지원서 작성·첨삭·가이드)에 사용하는 크레딧을 충전합니다. 1 크레딧 = 1원 가치입니다.
          </p>
        </section>

        <CreditsPurchasePanel />
        <RecentOrdersList limit={5} />
      </div>
    </main>
  );
}
