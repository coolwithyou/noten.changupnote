"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowRight, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { KnowledgeDashboardData } from "@/lib/server/knowledge/knowledgeDashboardData";
import { AccumulationChart } from "./AccumulationChart";
import { DistributionPanels } from "./DistributionPanels";
import { ExposurePanel } from "./ExposurePanel";
import { KnowledgeMetricCards } from "./KnowledgeMetricCards";
import { NonLessonPanel } from "./NonLessonPanel";
import { ReviewDuePanel } from "./ReviewDuePanel";
import { SourcesPanel } from "./SourcesPanel";
import { fmtTime, type DashboardBanner } from "./knowledgeLabels";

interface KnowledgeDashboardViewProps {
  initialData: KnowledgeDashboardData;
}

/**
 * 지식 관리 대시보드 클라이언트 뷰.
 * 초기 데이터는 서버 컴포넌트에서 조립해 넘겨받고(플래시 방지), 이후 업로드·추출 액션 뒤에는
 * GET /internal/knowledge/api/overview 로 전체 상태를 재페치해 교체한다.
 */
export function KnowledgeDashboardView({ initialData }: KnowledgeDashboardViewProps) {
  const [data, setData] = useState<KnowledgeDashboardData>(initialData);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<DashboardBanner>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/internal/knowledge/api/overview", {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        setBanner({ kind: "error", text: "대시보드 데이터를 새로고침하지 못했습니다." });
        return;
      }
      const next = (await res.json()) as KnowledgeDashboardData;
      setData(next);
    } catch {
      setBanner({ kind: "error", text: "네트워크 오류로 새로고침에 실패했습니다." });
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="flex w-full flex-col gap-6">
      {/* (a) 헤더 */}
      <header className="flex flex-col gap-3 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-2">
          <Badge variant="outline" className="w-fit">
            지식 루프 · 축적 현황
          </Badge>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            지식 대시보드 — 운영 지식 축적 현황
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            보고 문서가 올 때마다 lesson 으로 축적되어 지원서 에이전트가 강해지는 루프의 현황판입니다.
            <span className="ml-1 text-muted-foreground/70">
              마지막 갱신 {fmtTime(data.generatedAt)}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void refetch()} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
            갱신
          </Button>
          <Link
            href="/internal/review/lessons"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            lesson 인박스
            <ArrowRight data-icon="inline-end" />
          </Link>
        </div>
      </header>

      {/* 배너 */}
      {banner ? (
        <Alert
          variant={banner.kind === "error" ? "destructive" : "default"}
          className={cn(
            banner.kind === "ok" && "border-emerald-500/30 bg-emerald-500/5",
            banner.kind === "warn" && "border-amber-500/40 bg-amber-500/5",
          )}
        >
          <AlertTitle>
            {banner.kind === "ok" ? "완료" : banner.kind === "warn" ? "확인 필요" : "오류"}
          </AlertTitle>
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      ) : null}

      {/* (b) 지표 카드 */}
      <KnowledgeMetricCards totals={data.totals} reviewDueCount={data.reviewDue.length} />

      {/* (c) 축적 추이 */}
      <AccumulationChart points={data.weeklyAccumulation} />

      {/* (d) 분포 */}
      <DistributionPanels distributions={data.distributions} />

      {/* (d2) 노출 지표 — 죽은 지식 경보 + 최근 30일 노출 랭킹 */}
      <ExposurePanel lessonExposure={data.lessonExposure} deadKnowledge={data.deadKnowledge} />

      {/* (e)+(f) 원천 문서 + 새 보고서 등록 */}
      <SourcesPanel sources={data.sources} onChanged={refetch} onBanner={setBanner} />

      {/* (g) 비-lesson 항목 */}
      <NonLessonPanel items={data.nonLessonItems} />

      {/* (h) 재검토 임박 */}
      <ReviewDuePanel items={data.reviewDue} />
    </div>
  );
}
