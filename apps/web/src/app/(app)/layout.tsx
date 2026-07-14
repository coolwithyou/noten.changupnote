import type { ReactNode } from "react";
import { AppShell } from "@/components/app/app-shell";
import {
  fallbackHeaderUserForDemoAccess,
  getOptionalHeaderUser,
  isAuthEnforced,
} from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * Work zone(콘솔) 공용 레이아웃 — Sidebar 앱 셸.
 * 사용자 정보를 1회 로드해 셸에 전달한다. 인증 가드는 각 page가 담당(라우트별 callbackUrl 상이).
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const sessionUser = await getOptionalHeaderUser();
  const user = sessionUser
    ?? (!isAuthEnforced() ? fallbackHeaderUserForDemoAccess({ mode: "demo" }) : null);
  return <AppShell user={user}>{children}</AppShell>;
}
