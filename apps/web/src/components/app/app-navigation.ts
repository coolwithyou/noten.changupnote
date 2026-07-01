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

const OPTIONAL_HEADER_LINKS = {
  onboarding: { href: "/onboarding", label: "온보딩" },
  support: { href: "/support", label: "도움말" },
} satisfies Record<string, AppNavLink>;

export function appHeaderLinks({
  currentHref,
  includeOnboarding = false,
  includeSupport = false,
}: {
  currentHref?: string;
  includeOnboarding?: boolean;
  includeSupport?: boolean;
} = {}): AppNavLink[] {
  const links = [
    ...APP_HEADER_LINKS,
    ...(includeOnboarding ? [OPTIONAL_HEADER_LINKS.onboarding] : []),
    ...(includeSupport ? [OPTIONAL_HEADER_LINKS.support] : []),
  ];

  return links.filter((link) => link.href !== currentHref);
}
