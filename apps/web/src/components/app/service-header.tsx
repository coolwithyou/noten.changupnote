import { AccountMenu } from "@/components/app/account-menu";
import { PageNav } from "@/components/app/page-nav";
import { buttonVariants } from "@/components/ui/button";
import { CreditBalanceWidget } from "@/features/credits/CreditBalanceWidget";
import type { HeaderUser } from "@/lib/server/auth/session";

interface ServiceHeaderProps {
  user: HeaderUser | null;
  links: Array<{ href: string; label: string }>;
  variant?: "landing" | "app";
  /** 비로그인 시 로그인 후 돌아올 경로. 내부 경로만 전달할 것. */
  loginCallbackUrl?: string;
}

/**
 * 랜딩과 모든 시스템 페이지가 공유하는 세션 인지 헤더.
 * 표현용 컴포넌트라 서버/클라이언트 트리 양쪽에서 렌더할 수 있다(로그아웃 동작만 AccountMenu가 클라이언트).
 */
export function ServiceHeader({
  user,
  links,
  variant = "app",
  loginCallbackUrl,
}: ServiceHeaderProps) {
  if (variant === "landing") {
    return (
      <header className="service-nav">
        <a className="brand-mark" href="/" aria-label="창업노트 홈">
          <span className="brand-symbol" aria-hidden="true">C</span>
          <span>창업노트</span>
        </a>
        <div className="flex flex-wrap items-center gap-3">
          <PageNav links={links} variant="landing" />
          {user ? (
            <AccountMenu user={user} />
          ) : (
            <a className={buttonVariants({ size: "sm", className: "nav-login" })} href={loginHref(loginCallbackUrl)}>
              로그인
            </a>
          )}
        </div>
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <a className="inline-flex items-center gap-2 text-sm font-semibold text-foreground" href="/" aria-label="창업노트 홈">
          <span
            className="flex size-8 items-center justify-center rounded-[var(--radius-lg)] bg-primary text-sm font-semibold text-primary-foreground shadow-[var(--shadow-subtle)]"
            aria-hidden="true"
          >
            C
          </span>
          <span>창업노트</span>
        </a>
        <div className="flex min-w-0 items-center gap-2">
          <PageNav links={links} />
          {user ? (
            <>
              {/* 잔액 위젯(10.5) — 인증 상태에서만. available 표시, lowBalance 배지. */}
              <CreditBalanceWidget />
              <AccountMenu user={user} />
            </>
          ) : (
            <a className={buttonVariants({ size: "sm" })} href={loginHref(loginCallbackUrl)}>
              로그인
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

function loginHref(callbackUrl?: string): string {
  if (!callbackUrl) return "/login";
  return `/login?${new URLSearchParams({ callbackUrl }).toString()}`;
}
