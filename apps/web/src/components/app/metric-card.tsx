import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: string;
  detail?: string;
  className?: string;
}) {
  return (
    <Card className={cn("min-w-0", className)} size="sm">
      <CardContent className="flex min-h-24 flex-col justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <strong className="text-2xl font-semibold tracking-normal text-foreground">{value}</strong>
        {detail ? <small className="text-xs leading-relaxed text-muted-foreground">{detail}</small> : null}
      </CardContent>
    </Card>
  );
}
