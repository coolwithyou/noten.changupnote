import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

/**
 * 인증(로그인·비밀번호 재설정) 그룹 레이아웃.
 * 현재 각 패널이 자체 중앙정렬 캔버스(min-h-screen)를 렌더하므로 pass-through로 둔다.
 * (Phase 7에서 캔버스를 이 레이아웃으로 승격 예정.)
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
