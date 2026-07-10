"use client";

import { Bar, BarChart, Cell, XAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { WeeklyAccumulationPoint } from "@/lib/server/knowledge/knowledgeDashboardData";
import { fmtShortDate } from "./knowledgeLabels";

interface AccumulationChartProps {
  points: WeeklyAccumulationPoint[];
}

// 브랜드 톤 유지: 바 색은 테마 토큰 --primary(= --color-primary)만 사용, 마지막 주만 불투명 강조.
const chartConfig = {
  created: { label: "생성", color: "var(--primary)" },
} satisfies ChartConfig;

/**
 * (c) 축적 추이 — 최근 12주 주별 lesson 생성 수를 recharts 세로 바로.
 * 데이터·집계 로직 불변: 마지막 주 강조 + 창 전체가 0 일 때 안내 문구.
 * 누적은 우상단 배지와 툴팁으로 표현한다.
 */
export function AccumulationChart({ points }: AccumulationChartProps) {
  const lastCumulative = points.length > 0 ? (points[points.length - 1]?.cumulative ?? 0) : 0;
  const windowCreated = points.reduce((sum, p) => sum + p.created, 0);
  const lastIndex = points.length - 1;

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

        <ChartContainer config={chartConfig} className="aspect-auto h-40 w-full">
          <BarChart accessibilityLayer data={points} margin={{ top: 12, left: 0, right: 0, bottom: 0 }}>
            <XAxis
              dataKey="weekStart"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval={0}
              tick={{ fontSize: 10 }}
              tickFormatter={(value: string) => fmtShortDate(value)}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  hideIndicator
                  labelFormatter={(_, payload) => {
                    const point = payload?.[0]?.payload as WeeklyAccumulationPoint | undefined;
                    return point ? `${fmtShortDate(point.weekStart)} 주` : "";
                  }}
                  formatter={(_value, _name, item) => {
                    const point = item.payload as WeeklyAccumulationPoint;
                    return (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-foreground tabular-nums">생성 {point.created}건</span>
                        <span className="text-muted-foreground tabular-nums">누적 {point.cumulative}건</span>
                      </div>
                    );
                  }}
                />
              }
            />
            <Bar dataKey="created" radius={[3, 3, 0, 0]} fill="var(--color-created)">
              {points.map((point, index) => (
                <Cell key={point.weekStart} fillOpacity={index === lastIndex ? 1 : 0.55} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
