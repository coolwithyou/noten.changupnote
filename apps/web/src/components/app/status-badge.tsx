import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

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
  ...props
}: {
  tone?: StatusTone;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Badge>, "variant">) {
  return (
    <Badge variant="secondary" className={cn("status-badge", toneClassName[tone], className)} {...props}>
      {children}
    </Badge>
  );
}

export function eligibilityTone(value: "eligible" | "conditional" | "ineligible"): StatusTone {
  if (value === "eligible") return "success";
  if (value === "conditional") return "warning";
  return "danger";
}
