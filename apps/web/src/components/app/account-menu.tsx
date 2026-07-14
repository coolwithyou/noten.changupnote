"use client";

import { signOut } from "next-auth/react";
import { BriefcaseBusinessIcon, ChevronDownIcon, CreditCardIcon, LayoutDashboardIcon, LifeBuoyIcon, LogOutIcon, SettingsIcon, UsersRoundIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { APP_ACCOUNT_LINKS } from "@/components/app/app-navigation";
import type { HeaderUser } from "@/lib/server/auth/session";

/**
 * @param variant 트리거 모양.
 *   - "pill"(기본): 아바타 + 이름 + 셰브론 형태의 알약 트리거.
 *   - "avatar": 34px 원형 아바타 단독 트리거(신 AppHeader용). 드롭다운 기능은 동일.
 */
export function AccountMenu({
  user,
  variant = "pill",
}: {
  user: HeaderUser;
  variant?: "pill" | "avatar";
}) {
  const label = user.name?.trim() || user.email?.trim() || "내 계정";

  return (
    <DropdownMenu>
      {variant === "avatar" ? (
        <DropdownMenuTrigger
          aria-label="계정 메뉴 열기"
          className="rounded-full outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/20"
        >
          <Avatar className="size-[34px]">
            <AvatarFallback className="bg-brand-tint text-sm font-extrabold text-brand-hover">
              {accountInitial(user)}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger
          aria-label="계정 메뉴 열기"
          className="group/account inline-flex max-w-[15rem] items-center gap-2 rounded-full border border-border bg-background py-1 pr-3 pl-1 text-sm font-semibold text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20"
        >
          <Avatar className="size-7">
            <AvatarFallback className="text-xs">{accountInitial(user)}</AvatarFallback>
          </Avatar>
          <span className="max-w-[12ch] truncate">{label}</span>
          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-aria-expanded/account:rotate-180" />
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent>
        <DropdownMenuLabel className="truncate">{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {APP_ACCOUNT_LINKS.map((link) => (
          <DropdownMenuLinkItem href={link.href} key={link.href}>
            {accountLinkIcon(link.href)}
            {link.menuLabel ?? link.label}
          </DropdownMenuLinkItem>
        ))}
        <DropdownMenuItem onClick={() => void signOut({ callbackUrl: "/" })}>
          <LogOutIcon />
          로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function accountLinkIcon(href: string) {
  if (href === "/dashboard") return <LayoutDashboardIcon />;
  if (href === "/applications") return <BriefcaseBusinessIcon />;
  if (href === "/team") return <UsersRoundIcon />;
  if (href === "/pricing") return <CreditCardIcon />;
  if (href === "/settings") return <SettingsIcon />;
  return <LifeBuoyIcon />;
}

function accountInitial(user: HeaderUser): string {
  const source = user.name?.trim() || user.email?.trim() || "";
  const first = source[0] ?? "?";
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}
