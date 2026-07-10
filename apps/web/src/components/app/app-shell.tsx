import type { ReactNode } from "react";
import { AccountMenu } from "@/components/app/account-menu";
import { AppBreadcrumb } from "@/components/app/app-breadcrumb";
import { AppSidebar } from "@/components/app/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { CreditBalanceWidget } from "@/features/credits/CreditBalanceWidget";
import type { HeaderUser } from "@/lib/server/auth/session";

/**
 * Work zone 앱 셸. (app) 그룹 layout과, 라우트 그룹 밖에서 셸이 필요한 콘솔 페이지
 * (팀·지원사업 요약)이 공유한다. Sidebar(기회 맵/아카이브/신청 관리/로드맵 · 팀/플랜/크레딧/설정)
 * + 상단바(트리거 · 브레드크럼 · 잔액 위젯 · 계정 메뉴).
 * 인증 가드는 page 단위 유지 — 셸은 표현만 담당한다.
 */
export function AppShell({ user, children }: { user: HeaderUser | null; children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      <SidebarInset>
        <header className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 lg:px-6">
          <SidebarTrigger />
          <Separator orientation="vertical" className="hidden h-6 sm:block" />
          <AppBreadcrumb />
          <div className="ml-auto flex items-center gap-2">
            {user ? <CreditBalanceWidget /> : null}
            {user ? <AccountMenu user={user} /> : null}
          </div>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
