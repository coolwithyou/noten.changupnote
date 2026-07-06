import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  KnowledgeDashboardDistributions,
  KnowledgeDistributionBucket,
} from "@/lib/server/knowledge/knowledgeDashboardData";
import { labelForTarget, tierMeta } from "./knowledgeLabels";

interface DistributionPanelsProps {
  distributions: KnowledgeDashboardDistributions;
}

/** (d) 분포 — target / evidenceTier / program 3열(모바일 세로). CSS 가로 바. */
export function DistributionPanels({ distributions }: DistributionPanelsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>지식 분포</CardTitle>
        <CardDescription>승인·제안 상태 lesson 기준 분포입니다.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-3">
        <DistColumn
          title="목적별 (target)"
          buckets={distributions.byTarget}
          renderLabel={(key) => labelForTarget(key)}
        />
        <DistColumn
          title="근거 수준별 (tier)"
          buckets={distributions.byEvidenceTier}
          renderLabel={(key) => tierMeta(key).label}
          isWarn={(key) => tierMeta(key).warn}
        />
        <DistColumn
          title="프로그램별"
          buckets={distributions.byProgram}
          renderLabel={(key) => key}
        />
      </CardContent>
    </Card>
  );
}

interface DistColumnProps {
  title: string;
  buckets: KnowledgeDistributionBucket[];
  renderLabel: (key: string) => string;
  isWarn?: (key: string) => boolean;
}

function DistColumn({ title, buckets, renderLabel, isWarn }: DistColumnProps) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {buckets.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">표시할 lesson 이 없습니다.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {buckets.map((bucket) => {
            const warn = isWarn?.(bucket.key) ?? false;
            const widthPct = Math.max(4, (bucket.count / max) * 100);
            const label = renderLabel(bucket.key);
            return (
              <div key={bucket.key} className="flex items-center gap-2">
                <span className="w-20 shrink-0 truncate text-xs text-foreground/80" title={label}>
                  {label}
                </span>
                <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full",
                      warn ? "bg-amber-500" : "bg-primary",
                    )}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {bucket.count}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
