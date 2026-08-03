"use client";

import { RefreshCw } from "lucide-react";
import type { LabOpsSummary } from "./contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatDateTime } from "./batch-ops-format";

// ─────────────────────────────────────────────────────────────────────────────
// 깔때기 보드 — 아카이빙 → 모집기간 → 코호트 → 딥분석 → 검수·감사 → 승격 6단계.
// ⑤ 검수·감사는 사람/감사 확정/AI 자동확정을 절대 합산하지 않는다(무은폐 원칙 — 계획 §2 ⑤).
// 수치는 서버 집계(ops-summary) 스냅샷이며 ?refresh=1 로 파일 스캔 캐시를 무효화한다.
// ─────────────────────────────────────────────────────────────────────────────

export function BatchOpsFunnelBoard({
  summary,
  refreshing,
  onRefresh,
}: {
  summary: LabOpsSummary;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { funnel } = summary;
  return (
    <Card>
      <CardHeader>
        <CardTitle>깔때기 현황</CardTitle>
        <CardDescription>
          아카이빙 → 모집기간 → 코호트 → 딥분석 → 검수·감사 → 승격 (집계 시점 스냅샷)
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant="outline" className="tabular-nums">
            {formatDateTime(summary.generatedAt)} · {summary.cacheHit ? "캐시" : "실측"}
          </Badge>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            새로고침
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <FunnelStage step="①" title="아카이빙 visible">
            <BigNumber value={funnel.archivedVisible} label="전 소스" />
            <p className="text-xs text-muted-foreground tabular-nums">
              실험 소스 한정 {funnel.archivedVisibleLabSources}건
            </p>
          </FunnelStage>

          <FunnelStage step="②" title="모집기간 (KST)">
            <div className="flex flex-col gap-1.5">
              <SplitRow label="모집중" value={funnel.openToday} emphasis />
              <SplitRow label="기간 미상" value={funnel.periodUnknown} />
              <SplitRow label="마감·시작 전" value={funnel.closedOrNotStarted} />
            </div>
            <p className="text-[11px] text-muted-foreground">실험 소스·visible 한정 3분할</p>
          </FunnelStage>

          <FunnelStage step="③" title="코호트 편입">
            <BigNumber value={funnel.cohortSize} label="공고" />
            <p className="truncate text-xs text-muted-foreground" title={funnel.cohortLabel ?? undefined}>
              {funnel.cohortLabel ?? "라벨 없음"}
              {funnel.cohortSelectedAt ? ` · ${formatDateTime(funnel.cohortSelectedAt)} 선정` : ""}
            </p>
          </FunnelStage>

          <FunnelStage step="④" title="딥분석 4버킷">
            <BigNumber value={funnel.analysisOkCurrent} label="ok·현행" />
            <div className="flex flex-col gap-1">
              <SplitRow label="구버전만" value={funnel.analysisOkOutdatedOnly} />
              <SplitRow label="error 보류" value={funnel.analysisErrorHeld} />
              <SplitRow label="잔여(실행 대상)" value={funnel.analysisPending} />
            </div>
          </FunnelStage>

          {/* ⑤ 무은폐 원칙 — 세 갈래를 합산한 단일 숫자를 만들지 않는다. */}
          <FunnelStage step="⑤" title="검수·감사 3분할">
            <div className="flex flex-col gap-1.5">
              <SplitRow label="사람 검수" value={funnel.humanReviewed} emphasis />
              <SplitRow label="감사 확정(사람 포함)" value={funnel.auditConfirmed} emphasis />
              <SplitRow label="AI 자동확정" value={funnel.auditAiAutoConfirmed} emphasis />
            </div>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              감사 대기 {funnel.auditPending}건 · 합산 없음(무은폐)
            </p>
          </FunnelStage>

          <FunnelStage step="⑥" title="승격 반영">
            <BigNumber value={funnel.promotedGrants} label="공고" />
            <p className="text-xs text-muted-foreground">applied · 롤백 제외 · 중복 제거</p>
          </FunnelStage>
        </div>
      </CardContent>
    </Card>
  );
}

/** 단계 카드 — ops admin 지표 카드 감성(작은 라벨 + 큰 tabular 숫자)의 최소 이식. */
function FunnelStage({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-muted/20 p-3">
      <span className="text-xs font-medium text-muted-foreground">
        {step} {title}
      </span>
      <div className="flex flex-1 flex-col justify-end gap-1.5">{children}</div>
    </div>
  );
}

function BigNumber({ value, label }: { value: number; label?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-3xl font-semibold tabular-nums">{value}</span>
      {label ? <span className="text-xs text-muted-foreground">{label}</span> : null}
    </div>
  );
}

function SplitRow({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={cn("text-xs", emphasis ? "font-medium" : "text-muted-foreground")}>
        {label}
      </span>
      <span
        className={cn(
          "font-semibold tabular-nums",
          emphasis ? "text-lg" : "text-sm text-muted-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}
