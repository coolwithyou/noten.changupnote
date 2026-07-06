import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { WeeklyAccumulationPoint } from "@/lib/server/knowledge/knowledgeDashboardData";
import { fmtShortDate } from "./knowledgeLabels";

interface AccumulationChartProps {
  points: WeeklyAccumulationPoint[];
}

/**
 * (c) 축적 추이 — 최근 12주 주별 lesson 생성 수를 CSS 세로 바로.
 * 데이터가 대부분 0 이어도 어색하지 않게: 바 최소 높이 floor + 창 전체가 0 일 때 안내 문구.
 * 누적은 우상단 배지와 마지막 주 강조로 표현한다.
 */
export function AccumulationChart({ points }: AccumulationChartProps) {
  const maxCreated = Math.max(1, ...points.map((p) => p.created));
  const lastCumulative = points.length > 0 ? (points[points.length - 1]?.cumulative ?? 0) : 0;
  const windowCreated = points.reduce((sum, p) => sum + p.created, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>축적 추이</CardTitle>
        <CardDescription>최근 12주 · 주별 lesson 생성 수 (오른쪽 끝이 현재 누적)</CardDescription>
        <CardAction>
          <Badge variant="secondary" className="tabular-nums">
            누적 {lastCumulative.toLocaleString("ko-KR")}건
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {windowCreated === 0 ? (
          <p className="text-xs text-muted-foreground">
            이번 12주 창에는 새로 생성된 lesson 이 없습니다 (누적 {lastCumulative.toLocaleString("ko-KR")}건 유지).
          </p>
        ) : null}

        {/* 바 영역 */}
        <div className="flex items-end gap-1 sm:gap-1.5">
          {points.map((p, index) => {
            const isLast = index === points.length - 1;
            const heightPct = p.created > 0 ? Math.max(10, (p.created / maxCreated) * 100) : 0;
            return (
              <div
                key={p.weekStart}
                className="flex min-w-0 flex-1 flex-col items-center gap-1"
                title={`${fmtShortDate(p.weekStart)} 주 · 생성 ${p.created} · 누적 ${p.cumulative}`}
              >
                <span
                  className={cn(
                    "h-4 text-[10px] leading-4 tabular-nums",
                    p.created > 0 ? "font-medium text-foreground" : "text-muted-foreground/40",
                  )}
                >
                  {p.created > 0 ? p.created : "·"}
                </span>
                <div className="relative h-28 w-full overflow-hidden rounded-[3px] bg-muted/50">
                  {heightPct > 0 ? (
                    <div
                      className={cn(
                        "absolute inset-x-0 bottom-0 rounded-[3px] transition-[height]",
                        isLast ? "bg-primary" : "bg-primary/55",
                      )}
                      style={{ height: `${heightPct}%` }}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* 주 시작일(MM.DD) 라벨 — 바와 열 정렬 */}
        <div className="flex items-start gap-1 sm:gap-1.5">
          {points.map((p, index) => {
            const isLast = index === points.length - 1;
            return (
              <span
                key={p.weekStart}
                className={cn(
                  "min-w-0 flex-1 truncate text-center text-[10px] tabular-nums",
                  isLast ? "font-semibold text-primary" : "text-muted-foreground",
                )}
              >
                {fmtShortDate(p.weekStart)}
              </span>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
