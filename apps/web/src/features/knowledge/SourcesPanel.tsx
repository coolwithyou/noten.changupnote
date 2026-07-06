"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, FileText, PlayCircle, Plus, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { KnowledgeSourceSummary } from "@/lib/server/knowledge/knowledgeDashboardData";
import { UploadReportForm } from "./UploadReportForm";
import {
  SOURCE_KIND_LABEL,
  SOURCE_STATUS_META,
  fmtDate,
  type KnowledgeSourceKind,
  type KnowledgeSourceStatus,
  type SetBanner,
} from "./knowledgeLabels";

interface ExtractSummary {
  lessonsInserted: number;
  nonLessonItems: number;
  counts: Record<string, number>;
  quotePassRatePct: number;
  dropped: unknown[];
}

interface ExtractResponse {
  ok?: boolean;
  summary?: ExtractSummary;
  message?: string;
  error?: string;
}

interface SourcesPanelProps {
  sources: KnowledgeSourceSummary[];
  onChanged: () => Promise<void>;
  onBanner: SetBanner;
}

/** (e)+(f) 원천 문서 목록 + 추출 실행 + 새 보고서 등록(상단 접이식). */
export function SourcesPanel({ sources, onChanged, onBanner }: SourcesPanelProps) {
  const [showUpload, setShowUpload] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ExtractSummary>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function runExtract(source: KnowledgeSourceSummary) {
    // 이중 클릭·동시 실행 방지: 서버는 진행 중 재호출을 막지 못하므로 클라이언트가 게이트한다.
    if (busyId) return;
    setBusyId(source.id);
    setErrors((prev) => ({ ...prev, [source.id]: "" }));

    try {
      const res = await fetch(`/internal/knowledge/api/sources/${source.id}/extract`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      let payload: ExtractResponse = {};
      try {
        payload = (await res.json()) as ExtractResponse;
      } catch {
        // 본문 없음
      }

      if (res.ok && payload.ok && payload.summary) {
        setResults((prev) => ({ ...prev, [source.id]: payload.summary as ExtractSummary }));
        onBanner({
          kind: "ok",
          text: `추출 완료 — lesson ${payload.summary.lessonsInserted}건 적재. 인박스에서 검수하세요.`,
        });
        await onChanged();
      } else {
        const msg = payload.message ?? payload.error ?? "추출에 실패했습니다.";
        setErrors((prev) => ({ ...prev, [source.id]: msg }));
        onBanner({ kind: res.status === 409 ? "warn" : "error", text: `추출 실패: ${msg}` });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "네트워크 오류가 발생했습니다.";
      setErrors((prev) => ({ ...prev, [source.id]: msg }));
      onBanner({ kind: "error", text: `추출 실패: ${msg}` });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>원천 문서</CardTitle>
        <CardDescription>등록 → 추출 → 인박스 검수 순으로 lesson 이 확정됩니다.</CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant={showUpload ? "outline" : "default"}
            onClick={() => setShowUpload((v) => !v)}
          >
            <Plus data-icon="inline-start" />
            새 보고서 등록
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {showUpload ? (
          <UploadReportForm
            onRegistered={onChanged}
            onBanner={onBanner}
            onClose={() => setShowUpload(false)}
          />
        ) : null}

        {sources.length === 0 ? (
          <Empty className="border border-border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileText />
              </EmptyMedia>
              <EmptyTitle>등록된 원천 문서가 없습니다</EmptyTitle>
              <EmptyDescription>
                상단 [새 보고서 등록]으로 인터뷰·피드백 문서를 올리면 여기에 쌓입니다.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {sources.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                busy={busyId === source.id}
                disabled={busyId !== null && busyId !== source.id}
                result={results[source.id]}
                error={errors[source.id] ?? ""}
                onExtract={() => void runExtract(source)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

interface SourceRowProps {
  source: KnowledgeSourceSummary;
  busy: boolean;
  disabled: boolean;
  result: ExtractSummary | undefined;
  error: string;
  onExtract: () => void;
}

function SourceRow({ source, busy, disabled, result, error, onExtract }: SourceRowProps) {
  const statusMeta = SOURCE_STATUS_META[source.status as KnowledgeSourceStatus] ?? {
    label: source.status,
    variant: "outline" as const,
  };
  const kindLabel = SOURCE_KIND_LABEL[source.kind as KnowledgeSourceKind] ?? source.kind;
  const counts = source.lessonCounts;
  const inboxHref = `/internal/review/lessons?sourceId=${encodeURIComponent(source.id)}`;

  return (
    <li className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate font-medium" title={source.title}>
            {source.title}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{kindLabel}</span>
            <span aria-hidden>·</span>
            <span>{fmtDate(source.sourceDate)}</span>
            <span aria-hidden>·</span>
            <span className="truncate">등록: {source.uploadedBy}</span>
          </div>
        </div>
        <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
      </div>

      {/* lesson·비-lesson 집계 칩 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <CountChip label="제안" value={counts.proposed} />
        <CountChip label="승인" value={counts.approved} />
        <CountChip label="기각" value={counts.rejected} />
        {counts.retired > 0 ? <CountChip label="철회" value={counts.retired} /> : null}
        <CountChip label="비-lesson" value={source.nonLessonItemCount} muted />
        <CountChip label="노출" value={source.exposureTotal} muted />
      </div>

      {/* 추출 결과 */}
      {result ? (
        <div className="rounded-[var(--radius-md)] border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" aria-hidden />
            추출 완료
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-foreground/80">
            <li>lesson 적재 {result.lessonsInserted}건</li>
            <li>quote 통과율 {result.quotePassRatePct}%</li>
            <li>비-lesson 항목 {result.nonLessonItems}건</li>
            {result.dropped.length > 0 ? (
              <li className="text-amber-600 dark:text-amber-500">드롭 {result.dropped.length}건</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {/* 추출 오류 */}
      {error ? (
        <div className="flex items-start gap-1.5 rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}

      {/* 액션 */}
      <div className="flex flex-wrap items-center gap-2">
        {source.status === "registered" ? (
          <Button size="sm" onClick={onExtract} disabled={busy || disabled}>
            {busy ? <Spinner className="size-3.5" /> : <PlayCircle data-icon="inline-start" />}
            {busy ? "추출 중… 1~2분 소요" : "추출 실행"}
          </Button>
        ) : null}
        <Link
          href={inboxHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          인박스에서 검수
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </li>
  );
}

function CountChip({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs",
        muted ? "bg-transparent text-muted-foreground" : "bg-muted/40",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  );
}
