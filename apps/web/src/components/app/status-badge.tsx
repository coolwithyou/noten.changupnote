import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

type StatusTone = "brand" | "success" | "warning" | "danger" | "neutral";

const toneVariant: Record<StatusTone, ComponentProps<typeof Badge>["variant"]> = {
  brand: "default",
  success: "secondary",
  warning: "outline",
  danger: "destructive",
  neutral: "secondary",
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
    <Badge variant={toneVariant[tone]} className={cn(className)} {...props}>
      {children}
    </Badge>
  );
}

export function eligibilityTone(value: "eligible" | "conditional" | "ineligible"): StatusTone {
  if (value === "eligible") return "success";
  if (value === "conditional") return "warning";
  return "danger";
}
