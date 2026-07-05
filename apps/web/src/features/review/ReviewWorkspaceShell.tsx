import type { ReactNode } from "react";
import {
  BookOpen,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

interface ReviewWorkspaceShellProps {
  reviewerEmail: string;
  currentPath: string;
  title: string;
  description?: string;
  badge?: string;
  actions?: ReactNode;
  children: ReactNode;
  metrics?: Array<{ label: string; value: string | number }>;
  document?: {
    docId: string;
    statusLabel: string;
    fieldCount: number;
    pageCount: number;
  };
}

export function ReviewWorkspaceShell({
  reviewerEmail,
  currentPath,
  title,
  description,
  badge,
  actions,
  children,
  metrics = [],
  document,
}: ReviewWorkspaceShellProps) {
  const navItems = [
    { href: "/internal/review", label: "문서 목록", icon: LayoutDashboard },
    { href: "/internal/review/guide", label: "검수 가이드", icon: BookOpen },
  ];

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <a href="/internal/review" className="flex min-w-0 items-center gap-2 rounded-[var(--radius-lg)] px-2 py-1.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
              R
            </span>
            <span className="min-w-0 group-data-[state=collapsed]/sidebar-wrapper:hidden">
              <span className="block truncate text-sm font-semibold">리뷰어 워크스페이스</span>
              <span className="block truncate text-xs text-sidebar-foreground/60">Gate 1 필드맵</span>
            </span>
          </a>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>워크스페이스</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton href={item.href} isActive={currentPath === item.href}>
                        <Icon aria-hidden />
                        <span className="truncate group-data-[state=collapsed]/sidebar-wrapper:hidden">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {document ? (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel>현재 문서</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton href={`/internal/review/${document.docId}`} isActive={currentPath.includes(document.docId)}>
                        <FileText aria-hidden />
                        <span className="truncate group-data-[state=collapsed]/sidebar-wrapper:hidden">{document.docId}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                  <div className="mt-2 grid gap-2 rounded-[var(--radius-lg)] border border-sidebar-border bg-sidebar-accent/60 p-3 text-xs group-data-[state=collapsed]/sidebar-wrapper:hidden">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sidebar-foreground/60">상태</span>
                      <Badge variant="outline">{document.statusLabel}</Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sidebar-foreground/60">필드</span>
                      <strong>{document.fieldCount.toLocaleString("ko-KR")}</strong>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sidebar-foreground/60">페이지</span>
                      <strong>{document.pageCount.toLocaleString("ko-KR")}</strong>
                    </div>
                  </div>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          ) : null}
          {metrics.length > 0 ? (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel>요약</SidebarGroupLabel>
                <SidebarGroupContent>
                  <div className="grid gap-2 group-data-[state=collapsed]/sidebar-wrapper:hidden">
                    {metrics.map((metric) => (
                      <div
                        key={metric.label}
                        className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-sidebar-border bg-sidebar-accent/60 px-3 py-2 text-xs"
                      >
                        <span className="text-sidebar-foreground/60">{metric.label}</span>
                        <strong>{metric.value}</strong>
                      </div>
                    ))}
                  </div>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          ) : null}
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center gap-2 rounded-[var(--radius-lg)] border border-sidebar-border bg-sidebar-accent/60 px-3 py-2 group-data-[state=collapsed]/sidebar-wrapper:justify-center">
            <ShieldCheck className="size-4 shrink-0 text-sidebar-foreground/70" aria-hidden />
            <div className="min-w-0 group-data-[state=collapsed]/sidebar-wrapper:hidden">
              <p className="truncate text-xs font-medium">검수자</p>
              <p className="truncate text-xs text-sidebar-foreground/60">{reviewerEmail}</p>
            </div>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <div className="flex min-h-14 items-center gap-2 px-4 lg:px-6">
            <SidebarTrigger />
            <Separator orientation="vertical" className="hidden h-6 sm:block" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                {badge ? <Badge variant="outline">{badge}</Badge> : null}
                <h1 className="truncate text-base font-semibold tracking-normal sm:text-lg">{title}</h1>
              </div>
              {description ? (
                <p className="truncate text-sm text-muted-foreground">{description}</p>
              ) : null}
            </div>
            {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
          </div>
        </header>
        <div className="flex w-full flex-1 flex-col gap-4 p-4 lg:p-6">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
