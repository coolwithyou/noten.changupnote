import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function AnalysisLabPageHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  badges,
  action,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  badges?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Icon />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{eyebrow}</span>
            <Badge variant="outline">dev</Badge>
            {badges}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
          <p className="mt-1 max-w-3xl break-words text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function AnalysisMetric({
  label,
  value,
  description,
}: {
  label: string;
  value: React.ReactNode;
  description: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-muted/60 p-4 ring-1 ring-foreground/5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground" title={description}>{description}</span>
    </div>
  );
}
