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
    <Card className={cn("metric-card", className)} size="sm">
      <CardContent>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </CardContent>
    </Card>
  );
}
