import type { ReactNode } from "react";
import { AppHeader } from "@/components/app/app-header";
import type { HeaderUser } from "@/lib/server/auth/session";

/**
 * Work zone 앱 셸. 사이드바를 폐지하고 단일 AppHeader + 단일 칼럼 본문 구조로 전환한다.
 * (app) 그룹 layout과, 라우트 그룹 밖에서 셸이 필요한 콘솔 페이지(팀·지원사업 요약)가 공유한다.
 * 본문 max-width는 각 페이지가 결정한다. 인증 가드는 page 단위 유지 — 셸은 표현만 담당.
 * 크레딧 잔액 위젯(CreditBalanceWidget)은 이번 라운드 비노출(과금 표면은 별도 라운드에서 복원).
 */
export function AppShell({ user, children }: { user: HeaderUser | null; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
