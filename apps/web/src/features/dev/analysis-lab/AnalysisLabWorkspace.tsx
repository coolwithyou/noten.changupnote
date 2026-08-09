"use client";

import { useEffect, useState } from "react";
import { FileCheck2, Gauge, GitBranch, SearchCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AnalysisLab } from "./AnalysisLab";
import { ApplicationRoundtripLab } from "./ApplicationRoundtripLab";
import { BatchOpsTab } from "./BatchOpsTab";
import { LocalAnalysisRuntimeCard } from "./LocalAnalysisRuntimeCard";
import { QualityGraphTab } from "./QualityGraphTab";
import { useLocalAnalysisRuntime } from "./useLocalAnalysisRuntime";

const WORKSPACES = [
  {
    value: "batch-ops",
    title: "분석 실행",
    description: "대기 공고를 확인하고 일괄 분석",
    icon: Gauge,
  },
  {
    value: "criteria",
    title: "공고 조건 딥분석",
    description: "22축 결과를 비교하고 검수",
    icon: SearchCheck,
  },
  {
    value: "application-roundtrip",
    title: "빠른 작성 검수",
    description: "지원서 입력칸과 채움 결과 확인",
    icon: FileCheck2,
  },
  {
    value: "quality",
    title: "품질 그래프",
    description: "성공 기준과 재처리 지점 확인",
    icon: GitBranch,
  },
] as const;
type WorkspaceValue = (typeof WORKSPACES)[number]["value"];

function isWorkspaceValue(value: string): value is WorkspaceValue {
  return WORKSPACES.some((item) => item.value === value);
}

export function AnalysisLabWorkspace() {
  const runtime = useLocalAnalysisRuntime();
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceValue>("batch-ops");

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (isWorkspaceValue(hash)) setActiveWorkspace(hash);
  }, []);

  const changeWorkspace = (value: string) => {
    if (!isWorkspaceValue(value)) return;
    setActiveWorkspace(value);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${value}`);
  };

  return (
    <Tabs value={activeWorkspace} onValueChange={changeWorkspace} orientation="vertical" className="min-h-dvh w-full min-w-0 max-w-full flex-col gap-0 overflow-x-hidden bg-surface-soft/70">
      <header className="w-full min-w-0 max-w-full overflow-hidden border-b bg-background">
        <div className="mx-auto grid w-full min-w-0 max-w-[1480px] gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:px-8">
          <div className="flex min-w-0 max-w-full flex-col gap-2 lg:max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">LOCAL DEV</Badge>
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Sparkles /> Claude 구독 모델 전용
              </span>
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">로컬 AI 분석 센터</h1>
              <p className="mt-1 break-all text-sm leading-6 text-muted-foreground sm:break-words sm:text-base">
                공고의 22축 자격조건과 HWP/HWPX 빠른 작성 필드를 함께 분석하고, 결과를 검수·관리합니다.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={runtime.allowed ? "default" : "secondary"}>
              {runtime.allowed ? "구독 분석 준비됨" : "구독 분석 모드 꺼짐"}
            </Badge>
            <span>운영 자동화와 동시 실행되지 않습니다.</span>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full min-w-0 max-w-full flex-1 gap-6 px-4 py-6 sm:px-6 lg:max-w-[1480px] lg:grid-cols-[260px_minmax(0,1fr)] lg:px-8">
        <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <div className="flex flex-col gap-4">
            <TabsList
              aria-label="로컬 분석 작업 선택"
              className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl border bg-muted/50 p-1.5 group-data-vertical/tabs:flex-row lg:items-stretch lg:group-data-vertical/tabs:flex-col"
            >
              {WORKSPACES.map((item) => (
                <TabsTrigger
                  key={item.value}
                  value={item.value}
                  className="h-auto min-w-40 flex-none flex-col items-start gap-1 px-3 py-3 text-left after:hidden data-active:bg-background data-active:text-foreground lg:w-full lg:min-w-0"
                >
                  <span className="flex w-full items-center gap-2 font-medium">
                    <item.icon data-icon="inline-start" />
                    <span className="truncate">{item.title}</span>
                  </span>
                  <span className="hidden whitespace-normal text-xs font-normal leading-5 text-muted-foreground lg:block">
                    {item.description}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
            <LocalAnalysisRuntimeCard runtime={runtime} />
          </div>
        </aside>

        <div className="min-w-0">
          <TabsContent value="batch-ops">
            <BatchOpsTab analysisAllowed={runtime.allowed} analysisOwnerId={runtime.ownerId} />
          </TabsContent>
          <TabsContent value="criteria">
            <AnalysisLab analysisAllowed={runtime.allowed} analysisOwnerId={runtime.ownerId} />
          </TabsContent>
          <TabsContent value="application-roundtrip">
            <ApplicationRoundtripLab analysisAllowed={runtime.allowed} analysisOwnerId={runtime.ownerId} />
          </TabsContent>
          <TabsContent value="quality">
            <QualityGraphTab />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  );
}
