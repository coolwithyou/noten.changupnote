"use client";

import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type {
  KnowledgeDashboardDistributions,
  KnowledgeDistributionBucket,
} from "@/lib/server/knowledge/knowledgeDashboardData";
import { labelForTarget, tierMeta } from "./knowledgeLabels";

interface DistributionPanelsProps {
  distributions: KnowledgeDashboardDistributions;
}

// 정상 바는 --primary(= --color-count), 경고(추정 근거) 바는 --warning — 둘 다 테마 토큰.
const chartConfig = {
  count: { label: "건수", color: "var(--primary)" },
} satisfies ChartConfig;

/** (d) 분포 — target / evidenceTier / program 3열(모바일 세로). recharts 가로 바. */
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
  // 집계 로직 불변 — 표시용으로만 label/warn 을 파생한다.
  const data = buckets.map((bucket) => ({
    key: bucket.key,
    label: renderLabel(bucket.key),
    count: bucket.count,
    warn: isWarn?.(bucket.key) ?? false,
  }));

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {data.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">표시할 lesson 이 없습니다.</p>
      ) : (
        <ChartContainer
          config={chartConfig}
          className="aspect-auto w-full"
          // 동적 높이: 버킷 수에 비례(행당 28px + 여백) — 계산값이라 인라인 style 예외 유지
          style={{ height: data.length * 28 + 8 }}
        >
          <BarChart
            accessibilityLayer
            data={data}
            layout="vertical"
            margin={{ left: 4, right: 28, top: 0, bottom: 0 }}
          >
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="label"
              width={84}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11 }}
              tickFormatter={(value: string) => (value.length > 9 ? `${value.slice(0, 8)}…` : value)}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator />} />
            <Bar dataKey="count" radius={4} fill="var(--color-count)">
              {data.map((entry) => (
                <Cell key={entry.key} fill={entry.warn ? "var(--warning)" : "var(--color-count)"} />
              ))}
              <LabelList dataKey="count" position="right" className="fill-muted-foreground" fontSize={11} />
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}
