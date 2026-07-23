"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  ActivityIcon,
  BadgeDollarSignIcon,
  BanknoteIcon,
  BookOpenCheckIcon,
  CircleGaugeIcon,
  ClipboardListIcon,
  CoinsIcon,
  DatabaseZapIcon,
  FileClockIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  ReceiptTextIcon,
  Settings2Icon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react"

import { NavUser } from "@/components/nav-user"
import { defaultAdminPath } from "@/lib/auth/routeAccess"
import type { AdminRole } from "@/lib/server/auth/adminUsers"
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
} from "@/components/ui/sidebar"

const NAV_GROUPS = [
  {
    label: "검수",
    roles: ["reviewer", "admin", "owner"],
    items: [
      { title: "주간 검수", href: "/review", icon: BookOpenCheckIcon },
    ],
  },
  {
    label: "운영",
    roles: ["viewer", "support", "admin", "owner"],
    items: [
      { title: "운영 개요", href: "/", icon: LayoutDashboardIcon },
      { title: "공개명단 업데이트", href: "/registry-imports", icon: DatabaseZapIcon },
      { title: "라이브 매칭", href: "/internal/live-match", icon: ActivityIcon },
    ],
  },
  {
    label: "크레딧",
    roles: ["viewer", "support", "admin", "owner"],
    items: [
      { title: "크레딧 개요", href: "/credits", icon: CoinsIcon },
      { title: "회원 관리", href: "/credits/members", icon: UsersIcon },
      { title: "결제·환불", href: "/credits/payments", icon: ReceiptTextIcon },
      { title: "구독", href: "/credits/subscriptions", icon: BadgeDollarSignIcon },
      { title: "요율 관리", href: "/credits/pricing", icon: BanknoteIcon },
      { title: "대사", href: "/credits/reconciliation", icon: ListChecksIcon },
      { title: "감사 로그", href: "/credits/audit", icon: FileClockIcon },
      { title: "설정", href: "/credits/settings", icon: Settings2Icon },
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string
  roles: readonly AdminRole[]
  items: ReadonlyArray<{
    title: string
    href: string
    icon: React.ComponentType
  }>
}>

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  user: {
    email: string
    name: string | null
    role: AdminRole
  }
}

export function AppSidebar({ user, ...props }: AppSidebarProps) {
  const pathname = usePathname()

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Cunote Ops"
              render={<Link href={defaultAdminPath(user.role)} />}
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <LandmarkIcon />
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">Cunote Ops</span>
                <span className="truncate text-xs text-muted-foreground">창업노트 운영 콘솔</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.filter((group) => group.roles.some((role) => role === user.role)).map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={item.title}
                        render={<Link href={item.href} />}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        <SidebarGroup className="mt-auto group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>운영 원칙</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="flex gap-2 rounded-lg border bg-background p-3 text-xs text-muted-foreground">
              <ShieldCheckIcon className="mt-0.5 shrink-0" />
              <p>사용자 프론트와 분리된 세션에서 변경 이력을 남깁니다.</p>
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
