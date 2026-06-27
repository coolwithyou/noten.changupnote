"use client";

import { signOut } from "next-auth/react";
import { ChevronDownIcon, LayoutDashboardIcon, LogOutIcon } from "lucide-react";
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
import type { HeaderUser } from "@/lib/server/auth/session";

export function AccountMenu({ user }: { user: HeaderUser }) {
  const label = user.name?.trim() || user.email?.trim() || "내 계정";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="계정 메뉴 열기"
        className="account-trigger group/account inline-flex items-center gap-2 rounded-full border border-border bg-background py-1 pr-3 pl-1 text-sm font-bold text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20"
      >
        <Avatar className="size-7">
          <AvatarFallback className="text-xs">{accountInitial(user)}</AvatarFallback>
        </Avatar>
        <span className="max-w-[12ch] truncate">{label}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-aria-expanded/account:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel className="truncate">{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem href="/dashboard">
          <LayoutDashboardIcon />
          대시보드
        </DropdownMenuLinkItem>
        <DropdownMenuItem onClick={() => void signOut({ callbackUrl: "/" })}>
          <LogOutIcon />
          로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function accountInitial(user: HeaderUser): string {
  const source = user.name?.trim() || user.email?.trim() || "";
  const first = source[0] ?? "?";
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}
