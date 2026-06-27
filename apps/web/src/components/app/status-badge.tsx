import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type StatusTone = "brand" | "success" | "warning" | "danger" | "neutral";

const toneClassName: Record<StatusTone, string> = {
  brand: "status-badge-brand",
  success: "status-badge-success",
  warning: "status-badge-warning",
  danger: "status-badge-danger",
  neutral: "status-badge-neutral",
};

export function StatusBadge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: StatusTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant="secondary" className={cn("status-badge", toneClassName[tone], className)}>
      {children}
    </Badge>
  );
}

export function eligibilityTone(value: "eligible" | "conditional" | "ineligible"): StatusTone {
  if (value === "eligible") return "success";
  if (value === "conditional") return "warning";
  return "danger";
}
