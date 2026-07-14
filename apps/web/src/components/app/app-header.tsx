import { AccountMenu } from "@/components/app/account-menu";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HeaderUser } from "@/lib/server/auth/session";

export interface AppHeaderLink {
  href: string;
  label: string;
}

/**
 * 우측 내비 링크 계약: 로그인 상태에서만, 최대 3개까지만 노출한다.
 * (디자인 계약 — 링크 ≤ 3. 초과분은 slice로 잘라낸다.)
 */
const MAX_HEADER_LINKS = 3;

const APP_HEADER_DEFAULT_LINKS: AppHeaderLink[] = [
  { href: "/applications", label: "내 신청 현황" },
  { href: "/settings#company-settings", label: "내 정보" },
];

export interface AppHeaderProps {
  user: HeaderUser | null;
  /** 로그인 상태에서 노출할 우측 내비 링크(최대 3개). 기본: 내 신청 현황 / 내 정보. */
  links?: AppHeaderLink[];
  /** 비로그인 시 로그인 버튼이 돌아올 내부 경로. */
  loginCallbackUrl?: string | undefined;
  /** 로고 클릭 시 이동 경로. 기본 "/". */
  homeHref?: string;
  /**
   * 남은 도우미 횟수 pill(✍ 남은 N회). null/undefined면 비노출.
   * 0이면 소진 경고(오렌지) 표기. 과금 표면 라운드에서 실데이터를 배선한다.
   */
  remaining?: number | null;
}

/**
 * 64px 단일 헤더. 사이드바 없는 셸의 유일한 상단바.
 * 좌측 로고(28px 블루 그라디언트 라운드 사각형 "C" + "창업노트") /
 * 우측: 비로그인 → 로그인 버튼 1개, 로그인 → 내비 링크(≤3) + 아바타 드롭다운(AccountMenu 재사용).
 * 시각 스펙은 docs/design/2026-07-14-components/AppHeader.dc.html을 토큰으로 재현.
 */
export function AppHeader({
  user,
  links = APP_HEADER_DEFAULT_LINKS,
  loginCallbackUrl,
  homeHref = "/",
  remaining,
}: AppHeaderProps) {
  const navLinks = links.slice(0, MAX_HEADER_LINKS);
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border-subtle bg-background px-5 sm:h-16 sm:px-10">
      <a href={homeHref} className="flex items-center gap-[9px] no-underline" aria-label="창업노트 홈">
        <span
          className="grid size-7 place-items-center rounded-[8px] bg-grad-logo text-base font-extrabold text-primary-foreground shadow-[var(--shadow-logo)]"
          aria-hidden
        >
          C
        </span>
        <span className="text-[17px] font-extrabold tracking-[-0.3px] text-ink">창업노트</span>
      </a>
      <div className="flex items-center gap-[22px]">
        {user ? (
          <>
            <nav className="hidden items-center gap-[22px] sm:flex">
              {navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-sm font-semibold text-text-nav no-underline transition-colors hover:text-ink"
                >
                  {link.label}
                </a>
              ))}
            </nav>
            {typeof remaining === "number" ? <RemainingPill remaining={remaining} /> : null}
            <AccountMenu user={user} variant="avatar" />
          </>
        ) : (
          <a
            href={loginHref(loginCallbackUrl)}
            className={cn(
              buttonVariants({ variant: "secondary", size: "sm" }),
              "h-auto px-4 py-[9px] text-sm",
            )}
          >
            로그인
          </a>
        )}
      </div>
    </header>
  );
}

/** 남은 도우미 횟수 pill — 0이면 소진 경고(오렌지), 그 외 블루 틴트. */
function RemainingPill({ remaining }: { remaining: number }) {
  const exhausted = remaining <= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-[13px] py-1.5 text-[13px] whitespace-nowrap tabular-nums",
        exhausted
          ? "bg-warning-strong-soft font-extrabold text-warning-strong"
          : "bg-brand-tint font-bold text-brand-hover",
      )}
    >
      ✍ {exhausted ? "0회" : `남은 ${remaining}회`}
    </span>
  );
}

function loginHref(callbackUrl?: string): string {
  if (!callbackUrl) return "/login";
  return `/login?${new URLSearchParams({ callbackUrl }).toString()}`;
}
