import { UsagePageView } from "@/features/credits/UsagePageView";
import { requireWebSession } from "@/lib/server/auth/session";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";

export const dynamic = "force-dynamic";

// /account/usage — 사용량·크레딧 상세(세션, 설계 10.3, 요구 5·7).
// 상단 요약 + 3탭(사용 내역 / 크레딧 원장 / 결제 내역) + 일 단위 소모 막대 + CSV.
export default async function AccountUsagePage() {
  try {
    await requireWebSession();
  } catch (error) {
    redirectOnAuthRequired(error, "/account/usage");
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-2">
          <span className="text-sm font-medium text-muted-foreground">내 계정 · 사용량</span>
          <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">크레딧 사용량</h1>
          <p className="text-base leading-7 text-muted-foreground">
            AI 작업에 사용한 크레딧과 충전·결제 내역을 확인합니다. 1 크레딧 = 1원 가치입니다.
          </p>
        </section>

        <UsagePageView />
      </div>
    </main>
  );
}
