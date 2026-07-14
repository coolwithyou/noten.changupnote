import { AppHeader, type AppHeaderLink } from "@/components/app/app-header";
import type { HeaderUser } from "@/lib/server/auth/session";

interface PublicHeaderProps {
  user: HeaderUser | null;
  links?: AppHeaderLink[];
  /** 비로그인 시 로그인 후 돌아올 내부 경로. */
  loginCallbackUrl?: string;
}

const DEFAULT_LINKS: AppHeaderLink[] = [
  { href: "/applications", label: "내 신청 현황" },
  { href: "/settings#company-settings", label: "내 정보" },
];

/**
 * 마케팅(퍼블릭) 페이지 공용 상단 헤더 — AppHeader 기반.
 * 비로그인: 로고 + 로그인 버튼(디자인 스펙, 내비 링크 없음).
 * 로그인: 제품 내비(≤3) + 아바타 드롭다운.
 * export 시그니처(user/links/loginCallbackUrl)는 기존 호출부 호환을 위해 유지한다.
 */
export function PublicHeader({ user, links = DEFAULT_LINKS, loginCallbackUrl }: PublicHeaderProps) {
  return <AppHeader user={user} links={links} loginCallbackUrl={loginCallbackUrl} />;
}
