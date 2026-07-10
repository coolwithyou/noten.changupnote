export interface AppNavLink {
  href: string;
  label: string;
}

export interface AppAccountNavLink extends AppNavLink {
  menuLabel?: string;
}

export const APP_HEADER_LINKS = [
  { href: "/dashboard", label: "기회 맵" },
  { href: "/archive", label: "아카이브" },
  { href: "/applications", label: "신청 관리" },
  { href: "/roadmap", label: "로드맵" },
  { href: "/team", label: "팀" },
  { href: "/billing", label: "플랜" },
  { href: "/settings", label: "설정" },
] satisfies AppNavLink[];

export const APP_ACCOUNT_LINKS = [
  { href: "/dashboard", label: "기회 맵", menuLabel: "대시보드" },
  { href: "/archive", label: "아카이브" },
  { href: "/applications", label: "신청 관리" },
  { href: "/account", label: "내 계정" },
  { href: "/team", label: "팀" },
  { href: "/billing", label: "플랜", menuLabel: "플랜과 청구" },
  { href: "/settings", label: "설정" },
  { href: "/onboarding", label: "온보딩" },
  { href: "/support", label: "고객지원" },
] satisfies AppAccountNavLink[];

/**
 * 앱 네비게이션 링크 상수. 현재 위치 하이라이트는 Sidebar의 `isActive`(usePathname)로 처리하므로
 * 구 "현재 링크 숨김" 필터는 제거했다. 링크 전체 집합만 반환한다.
 */
export function appHeaderLinks(): AppNavLink[] {
  return [...APP_HEADER_LINKS];
}
