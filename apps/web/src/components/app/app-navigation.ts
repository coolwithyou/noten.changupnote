export interface AppNavLink {
  href: string;
  label: string;
}

export interface AppAccountNavLink extends AppNavLink {
  menuLabel?: string;
}

export const APP_HEADER_LINKS = [
  { href: "/dashboard", label: "기회 맵" },
  { href: "/applications", label: "신청 관리" },
  { href: "/team", label: "팀" },
  { href: "/billing", label: "플랜" },
  { href: "/settings", label: "설정" },
] satisfies AppNavLink[];

export const APP_ACCOUNT_LINKS = [
  { href: "/dashboard", label: "기회 맵", menuLabel: "대시보드" },
  { href: "/applications", label: "신청 관리" },
  { href: "/team", label: "팀" },
  { href: "/billing", label: "플랜", menuLabel: "플랜과 청구" },
  { href: "/settings", label: "설정", menuLabel: "계정 설정" },
  { href: "/support", label: "고객지원" },
] satisfies AppAccountNavLink[];

/**
 * 통폐합된 archive/roadmap/onboarding을 제외한 앱 네비게이션 링크 집합.
 */
export function appHeaderLinks(): AppNavLink[] {
  return [...APP_HEADER_LINKS];
}
