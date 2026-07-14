import type { ReactNode } from "react";
import { AppHeader } from "@/components/app/app-header";
import type { HeaderUser } from "@/lib/server/auth/session";
import { getRemainingAssistantUses } from "@/lib/server/credits/remainingUses";

/**
 * Work zone 앱 셸. 사이드바를 폐지하고 단일 AppHeader + 단일 칼럼 본문 구조로 전환한다.
 * (app) 그룹 layout과, 라우트 그룹 밖에서 셸이 필요한 콘솔 페이지(팀·지원사업 요약)가 공유한다.
 * 본문 max-width는 각 페이지가 결정한다. 인증 가드는 page 단위 유지 — 셸은 표현만 담당.
 *
 * 과금 접점: 로그인 사용자에 한해 남은 도우미 횟수를 조회해 헤더 pill(✍ 남은 N회)로 노출한다.
 * 환산 불가·조회 실패는 null 로 수렴해 pill 비노출(페이지는 절대 죽지 않는다).
 */
export async function AppShell({ user, children }: { user: HeaderUser | null; children: ReactNode }) {
  const remaining = user ? await getRemainingAssistantUses() : null;
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader user={user} remaining={remaining} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
