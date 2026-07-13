import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

export function SiteHeader({ title, role }: { title: string; role: string }) {
  return (
    <header className="flex h-(--header-height) shrink-0 items-center border-b bg-background/95 backdrop-blur">
      <div className="flex w-full items-center gap-2 px-4 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-auto" />
        <h1 className="truncate text-sm font-medium sm:text-base">{title}</h1>
        <Badge className="ml-auto" variant="secondary">{role}</Badge>
      </div>
    </header>
  )
}
