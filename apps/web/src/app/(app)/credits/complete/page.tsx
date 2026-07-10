import { CreditsCompletePanel } from "@/features/credits/CreditsCompletePanel";
import { requireWebSession } from "@/lib/server/auth/session";
import { redirectOnAuthRequired } from "@/lib/server/auth/pageRedirect";

export const dynamic = "force-dynamic";

interface CompletePageProps {
  searchParams: Promise<{ paymentId?: string | string[]; code?: string }>;
}

// /credits/complete — 결제 완료 처리(세션, 설계 10.2). checkout/complete 호출 → 성공/실패/대기(폴링 3회).
export default async function CreditsCompletePage({ searchParams }: CompletePageProps) {
  try {
    await requireWebSession();
  } catch (error) {
    redirectOnAuthRequired(error, "/credits");
  }
  const params = await searchParams;
  const raw = params.paymentId;
  const paymentId = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6 px-4 py-12 sm:px-6">
        <CreditsCompletePanel paymentId={paymentId} />
      </div>
    </main>
  );
}
