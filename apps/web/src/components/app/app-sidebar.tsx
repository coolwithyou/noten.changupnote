"use client";

import { usePathname } from "next/navigation";
import {
  Archive,
  ClipboardList,
  Coins,
  Compass,
  CreditCard,
  Route,
  Settings,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { AccountMenu } from "@/components/app/account-menu";
import { buttonVariants } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import type { HeaderUser } from "@/lib/server/auth/session";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_MAIN: NavItem[] = [
  { href: "/dashboard", label: "기회 맵", icon: Compass },
  { href: "/archive", label: "아카이브", icon: Archive },
  { href: "/applications", label: "신청 관리", icon: ClipboardList },
  { href: "/roadmap", label: "로드맵", icon: Route },
];

const NAV_SECONDARY: NavItem[] = [
  { href: "/team", label: "팀", icon: UsersRound },
  { href: "/billing", label: "플랜", icon: CreditCard },
  { href: "/credits", label: "크레딧", icon: Coins },
  { href: "/settings", label: "설정", icon: Settings },
];

export function AppSidebar({ user }: { user: HeaderUser | null }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Sidebar>
      <SidebarHeader>
        <a
          href="/dashboard"
          className="flex min-w-0 items-center gap-2 rounded-[var(--radius-lg)] px-2 py-1.5"
          aria-label="창업노트 홈"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
            C
          </span>
          <span className="min-w-0 truncate text-sm font-semibold group-data-[state=collapsed]/sidebar-wrapper:hidden">
            창업노트
          </span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>워크스페이스</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_MAIN.map((item) => (
                <NavRow key={item.href} item={item} active={isActive(item.href)} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>관리</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_SECONDARY.map((item) => (
                <NavRow key={item.href} item={item} active={isActive(item.href)} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="min-w-0 group-data-[state=collapsed]/sidebar-wrapper:hidden">
          {user ? (
            <AccountMenu user={user} />
          ) : (
            <a
              href="/login"
              className={buttonVariants({ variant: "outline", size: "sm", className: "w-full justify-center" })}
            >
              로그인
            </a>
          )}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton href={item.href} isActive={active}>
        <Icon aria-hidden />
        <span className="truncate group-data-[state=collapsed]/sidebar-wrapper:hidden">{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
