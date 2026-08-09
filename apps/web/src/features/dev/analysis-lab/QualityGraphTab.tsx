"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, GitBranch, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import type {
  AnalysisQualityGraph,
  AnalysisQualityNode,
  AnalysisQualityReport,
  AnalysisQualityStatus,
} from "./quality-contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { AnalysisLabPageHeader, AnalysisMetric } from "./AnalysisLabPageHeader";

const QUALITY_URL = "/api/dev/analysis-lab/ops/quality?limit=30";

const STATUS_LABELS: Record<AnalysisQualityStatus, string> = {
  passed: "완료",
  partial: "안전한 부분 완료",
  held: "보류",
  failed: "실패",
  not_evaluated: "미검증",
  not_applicable: "대상 아님",
};

const STATUS_CLASSES: Record<AnalysisQualityStatus, string> = {
  passed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  partial: "border-amber-200 bg-amber-50 text-amber-800",
  held: "border-orange-200 bg-orange-50 text-orange-800",
  failed: "border-red-200 bg-red-50 text-red-700",
  not_evaluated: "border-slate-200 bg-slate-50 text-slate-600",
  not_applicable: "border-blue-200 bg-blue-50 text-blue-700",
};

export function QualityGraphTab() {
  const [report, setReport] = useState<AnalysisQualityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(QUALITY_URL, { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `품질 보고서를 불러오지 못했습니다. (HTTP ${response.status})`);
      }
      setReport((await response.json()) as AnalysisQualityReport);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "품질 보고서를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <QualityLoading />;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AnalysisLabPageHeader
        eyebrow="QUALITY FEEDBACK"
        title="분석 품질 그래프"
        description="딥분석과 빠른 작성의 성공 기준을 분리해 평가하고, 막힌 단계만 다음 재처리 대상으로 찾습니다."
        icon={GitBranch}
        action={(
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            다시 평가
          </Button>
        )}
      />

      {report ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <AnalysisMetric label="평가 공고" value={`${report.summary.total}`} description="현행 정책 최신 런" />
          <AnalysisMetric
            label="분석 완료"
            value={`${report.summary.analysis.passed}`}
            description="딥분석·Kordoc 모두 완료"
          />
          <AnalysisMetric
            label="안전한 부분 완료"
            value={`${report.summary.analysis.partial}`}
            description="비필수 신호만 보류"
          />
          <AnalysisMetric
            label="재처리 필요"
            value={`${report.summary.analysis.held + report.summary.analysis.failed}`}
            description="보류 또는 계약 실패"
          />
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>품질 평가를 불러오지 못했습니다</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {report ? (
        <>
          <QualityFlow report={report} />
          <QualitySummary report={report} />
          <div className="flex flex-col gap-3">
            {report.graphs.map((graph) => <QualityGrantCard key={graph.runId} graph={graph} />)}
          </div>
        </>
      ) : null}
    </div>
  );
}

function QualityFlow({ report }: { report: AnalysisQualityReport }) {
  const blockers = new Map(report.summary.blockers.map((item) => [item.nodeId, item.count]));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">성공 기준 흐름</CardTitle>
        <CardDescription>회색 단계는 아직 제품 증거가 없어 성공으로 추정하지 않은 구간입니다.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 xl:grid-cols-2">
        <FlowLane
          title="22축 딥분석"
          stages={[
            ["input_sealed", "입력 봉인"],
            ["deep_contract", "22축·근거"],
            ["independent_review", "독립 검수"],
            ["deep_promotion", "승격"],
            ["matching_canary", "매칭 카나리"],
          ]}
          blockers={blockers}
        />
        <FlowLane
          title="Kordoc 빠른 작성"
          stages={[
            ["application_source", "원본·파싱"],
            ["field_adjudication", "필드 판정"],
            ["field_materialization", "반영"],
            ["workspace_canary", "작성 카나리"],
          ]}
          blockers={blockers}
        />
      </CardContent>
    </Card>
  );
}

function FlowLane({
  title,
  stages,
  blockers,
}: {
  title: string;
  stages: Array<[AnalysisQualityNode["id"], string]>;
  blockers: Map<AnalysisQualityNode["id"], number>;
}) {
  return (
    <div className="rounded-xl border bg-muted/20 p-4">
      <p className="mb-3 text-sm font-semibold">{title}</p>
      <div className="flex flex-wrap items-center gap-2">
        {stages.map(([id, label], index) => {
          const blocked = blockers.get(id) ?? 0;
          return (
            <div key={id} className="contents">
              <div className={`rounded-lg border px-3 py-2 text-xs font-medium ${blocked > 0 ? "border-orange-200 bg-orange-50 text-orange-800" : "bg-background"}`}>
                <span>{label}</span>
                {blocked > 0 ? <span className="ms-1 font-mono">{blocked}</span> : null}
              </div>
              {index < stages.length - 1 ? <ArrowRight className="size-3.5 text-muted-foreground" /> : null}
            </div>
          );
        })}
        <span className="ms-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <RotateCcw className="size-3" /> 실패 단계로 피드백
        </span>
      </div>
    </div>
  );
}

function QualitySummary({ report }: { report: AnalysisQualityReport }) {
  const evaluated = report.summary.total;
  const ready = report.summary.analysis.passed + report.summary.analysis.partial;
  const readiness = evaluated > 0 ? Math.round((ready / evaluated) * 100) : 0;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.45fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">분석 준비도</CardTitle>
          <CardDescription>정상 완료와 안전한 부분 완료만 사용 가능한 분석으로 셉니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-end justify-between">
            <strong className="text-3xl tabular-nums">{readiness}%</strong>
            <span className="text-sm text-muted-foreground">{ready}/{evaluated}건</span>
          </div>
          <Progress value={readiness} />
          <div className="flex flex-wrap gap-2">
            {statusOrder.map((status) => (
              <QualityBadge key={status} status={status} count={report.summary.analysis[status]} />
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">가장 많은 차단 단계</CardTitle>
          <CardDescription>전체 재실행보다 이 단계부터 좁혀 처리합니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {report.summary.blockers.length === 0 ? (
            <span className="text-sm text-muted-foreground">차단 단계가 없습니다.</span>
          ) : report.summary.blockers.slice(0, 4).map((item) => (
            <div key={item.nodeId} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span>{item.label}</span>
              <Badge variant="secondary">{item.count}건</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function QualityGrantCard({ graph }: { graph: AnalysisQualityGraph }) {
  const actionNodes = graph.nodes.filter((node) => node.status === "held" || node.status === "failed");
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm leading-6 break-words">{graph.title}</CardTitle>
            <CardDescription className="mt-1 font-mono text-[11px]">{graph.runId}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge label="분석" status={graph.analysisReadiness} />
            <StatusBadge label="제품" status={graph.productReadiness} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 flex-col gap-2">
          {actionNodes.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <ShieldCheck className="size-4" /> 분석 하드 게이트를 통과했습니다.
            </div>
          ) : actionNodes.slice(0, 3).map((node) => (
            <div key={node.id} className="rounded-lg border border-orange-200 bg-orange-50/70 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={STATUS_CLASSES[node.status]} variant="outline">{node.label}</Badge>
                <span className="text-sm font-medium text-orange-950">{node.summary}</span>
              </div>
              {node.nextAction ? <p className="mt-1 text-xs text-orange-800">다음: {node.nextAction}</p> : null}
            </div>
          ))}
        </div>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs tabular-nums sm:grid-cols-4 lg:grid-cols-2">
          <Metric label="근거 조건" value={`${graph.metrics.groundedCriteria}/${graph.metrics.criteria}`} />
          <Metric label="22축" value={`${graph.metrics.assessedAxes}/22`} />
          <Metric label="빠른 작성 필드" value={`${graph.metrics.acceptedFields}`} />
          <Metric label="필수 미해결" value={`${graph.metrics.requiredUnresolvedFields}`} />
        </dl>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}

function StatusBadge({ label, status }: { label: string; status: AnalysisQualityStatus }) {
  return (
    <Badge variant="outline" className={STATUS_CLASSES[status]}>
      {label} · {STATUS_LABELS[status]}
    </Badge>
  );
}

function QualityBadge({ status, count }: { status: AnalysisQualityStatus; count: number }) {
  return (
    <Badge variant="outline" className={STATUS_CLASSES[status]}>
      {STATUS_LABELS[status]} {count}
    </Badge>
  );
}

function QualityLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-36 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

const statusOrder: AnalysisQualityStatus[] = [
  "passed",
  "partial",
  "held",
  "failed",
  "not_evaluated",
  "not_applicable",
];
