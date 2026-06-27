import { AccountMenu } from "@/components/app/account-menu";
import { PageNav } from "@/components/app/page-nav";
import { buttonVariants } from "@/components/ui/button";
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
  return (
    <header className={variant === "landing" ? "service-nav" : "dashboard-nav"}>
      <a className="brand-mark" href="/" aria-label="창업노트 홈">
        <span className="brand-symbol" aria-hidden="true">C</span>
        <span>창업노트</span>
      </a>
      <div className="flex flex-wrap items-center gap-3">
        <PageNav links={links} />
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

function loginHref(callbackUrl?: string): string {
  if (!callbackUrl) return "/login";
  return `/login?${new URLSearchParams({ callbackUrl }).toString()}`;
}
