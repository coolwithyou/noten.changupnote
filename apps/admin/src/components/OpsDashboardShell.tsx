"use client"

import type { ReactNode } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import type { AdminRole } from "@/lib/server/auth/adminUsers"

interface OpsDashboardShellProps {
  children: ReactNode
  title: string
  user: {
    email: string
    name: string | null
    role: AdminRole
  }
}

export function OpsDashboardShell({ children, title, user }: OpsDashboardShellProps) {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "17rem",
          "--header-height": "3.5rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar user={user} variant="inset" />
      <SidebarInset>
        <SiteHeader title={title} role={user.role} />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
