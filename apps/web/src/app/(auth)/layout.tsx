import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

/**
 * 인증(로그인·비밀번호 재설정) 그룹 레이아웃 — 중앙정렬 브랜드존 캔버스.
 * 전체화면 래퍼(min-h-screen + 중앙 배치 + 절제된 브랜드존 배경)를 이 레이아웃이 소유한다.
 * 패널(LoginPanel/PasswordResetPanel)은 카드 콘텐츠만 렌더한다.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-background px-5 py-10 text-foreground">
      <div aria-hidden className="bg-mesh absolute inset-0 opacity-70" />
      <div className="relative w-full max-w-md">{children}</div>
    </main>
  );
}
