import { AccountMenu } from "@/components/app/account-menu";
import { buttonVariants } from "@/components/ui/button";
import type { HeaderUser } from "@/lib/server/auth/session";

interface PublicHeaderProps {
  user: HeaderUser | null;
  links?: Array<{ href: string; label: string }>;
  /** 비로그인 시 로그인 후 돌아올 내부 경로. */
  loginCallbackUrl?: string;
}

const DEFAULT_LINKS = [
  { href: "/matches", label: "매칭 미리보기" },
  { href: "/pricing", label: "요금제" },
  { href: "/support", label: "고객지원" },
];

/**
 * 마케팅(퍼블릭) 페이지 공용 상단 헤더. 구 service-header landing variant를 대체하며
 * 커스텀 클래스(service-nav/brand-mark/nav-pill) 대신 Tailwind 유틸 + shadcn Button을 쓴다.
 * 세션 인지: 로그인 상태면 "대시보드로" + 계정 메뉴, 아니면 로그인 버튼.
 */
export function PublicHeader({ user, links = DEFAULT_LINKS, loginCallbackUrl }: PublicHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <a
          href="/"
          className="inline-flex items-center gap-2.5 text-base font-extrabold text-foreground"
          aria-label="창업노트 홈"
        >
          <span
            className="grid size-8 place-items-center rounded-[var(--radius-lg)] bg-primary text-sm font-extrabold text-primary-foreground shadow-[var(--shadow-subtle)]"
            aria-hidden
          >
            C
          </span>
          <span>창업노트</span>
        </a>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <nav className="hidden flex-wrap items-center gap-1 sm:flex">
            {links.map((link) => (
              <a
                key={`${link.href}:${link.label}`}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                href={link.href}
              >
                {link.label}
              </a>
            ))}
          </nav>
          {user ? (
            <div className="flex items-center gap-2">
              <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard">
                대시보드로
              </a>
              <AccountMenu user={user} />
            </div>
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
