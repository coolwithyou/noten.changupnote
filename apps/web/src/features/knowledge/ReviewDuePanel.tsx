import { CalendarClock, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ReviewDueLesson } from "@/lib/server/knowledge/knowledgeDashboardData";
import {
  SCOPE_AXES,
  SCOPE_AXIS_LABEL,
  ddayLabel,
  fmtDate,
  tierMeta,
  type ScopeAxis,
} from "./knowledgeLabels";

interface ReviewDuePanelProps {
  items: ReviewDueLesson[];
}

/** (h) 재검토 임박 — 승인 lesson 중 reviewBy 가 90일 내. 없으면 한 줄 안내. */
export function ReviewDuePanel({ items }: ReviewDuePanelProps) {
  if (items.length === 0) {
    return (
      <Card size="sm">
        <CardContent className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
          <CalendarClock className="size-4 shrink-0" aria-hidden />
          재검토 임박 항목이 없습니다 (90일 내 예정된 승인 lesson 없음).
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>재검토 임박</CardTitle>
        <CardDescription>90일 내 재검토가 예정된 승인 lesson 입니다.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {items.map((lesson) => {
            const tier = tierMeta(lesson.evidenceTier);
            const dday = ddayLabel(lesson.reviewBy);
            const scopeEntries = SCOPE_AXES.map(
              (axis: ScopeAxis) => [axis, lesson.scope?.[axis]] as const,
            ).filter(([, value]) => typeof value === "string" && value.length > 0);

            return (
              <li
                key={lesson.id}
                className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-border p-3.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="tabular-nums">
                    {dday}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      tier.warn &&
                        "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {tier.warn ? <TriangleAlert className="size-3" aria-hidden /> : null}
                    {tier.label}
                  </Badge>
                  <span className="ml-auto text-xs text-muted-foreground">
                    재검토 기한 {fmtDate(lesson.reviewBy)}
                  </span>
                </div>
                <p className="text-sm leading-6 text-foreground/90">{lesson.instruction}</p>
                {scopeEntries.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {scopeEntries.map(([axis, value]) => (
                      <span
                        key={axis}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
                      >
                        <span className="text-muted-foreground">{SCOPE_AXIS_LABEL[axis]}</span>
                        <span className="font-medium">{value}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
