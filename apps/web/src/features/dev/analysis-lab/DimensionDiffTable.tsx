"use client";

import type { LabCriterion, LabCurrentCriterion, LabDimensionDiff } from "./contract";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AXIS_STATUS_META,
  VERDICT_META,
  criterionValueEntries,
  kindBadgeVariant,
  kindLabel,
} from "./labels";

// 22축 A/B diff — 가로 스크롤이 생기던 5열 테이블 대신 축 단위 세로 블럭 레이아웃.
// 채워진 축(값이 하나라도 있는 축)은 상단에 A/B 패널 블럭으로, 미채움 축은 하단에
// 컴팩트 칩 그리드로 명확히 구분해 보여준다.

const VERDICT_ORDER: Record<LabDimensionDiff["verdict"], number> = {
  new: 0,
  changed: 1,
  only_current: 2,
  same: 3,
  none: 4,
};

export function DimensionDiffTable({ diffs }: { diffs: LabDimensionDiff[] }) {
  const filled = diffs
    .filter((diff) => diff.verdict !== "none")
    .sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]);
  const empty = diffs.filter((diff) => diff.verdict === "none");

  return (
    <TooltipProvider>
      <div className="flex min-w-0 flex-col gap-4">
        <SummaryStrip filled={filled} emptyCount={empty.length} />
        {filled.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            채워진 축이 없습니다 — 현재 DB와 딥분석 제안 모두 비어 있습니다.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {filled.map((diff) => (
              <FilledAxisBlock key={diff.dimension} diff={diff} />
            ))}
          </div>
        )}
        {empty.length > 0 ? <EmptyAxesBlock diffs={empty} /> : null}
      </div>
    </TooltipProvider>
  );
}

/** 상단 요약 스트립 — 채워진/미채움 축 개수와 verdict 분포. */
function SummaryStrip({ filled, emptyCount }: { filled: LabDimensionDiff[]; emptyCount: number }) {
  const counts = filled.reduce<Record<string, number>>((acc, diff) => {
    acc[diff.verdict] = (acc[diff.verdict] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge>채워진 축 {filled.length}</Badge>
      {(["new", "changed", "only_current", "same"] as const).map((verdict) =>
        counts[verdict] ? (
          <Badge key={verdict} variant={VERDICT_META[verdict].variant}>
            {VERDICT_META[verdict].label} {counts[verdict]}
          </Badge>
        ) : null,
      )}
      <Badge variant="ghost">미채움 축 {emptyCount}</Badge>
    </div>
  );
}

/** 채워진 축 블럭 — 헤더(축·검사 상태·verdict) + A/B 패널. */
function FilledAxisBlock({ diff }: { diff: LabDimensionDiff }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-border">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border bg-muted/40 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold">{diff.label}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{diff.dimension}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {diff.assessment ? (
            <Badge variant={AXIS_STATUS_META[diff.assessment.status].variant}>
              {AXIS_STATUS_META[diff.assessment.status].label}{" "}
              {Math.round(diff.assessment.confidence * 100)}%
            </Badge>
          ) : null}
          <Badge variant={VERDICT_META[diff.verdict].variant}>
            {VERDICT_META[diff.verdict].label}
          </Badge>
        </div>
      </header>
      <div className="grid min-w-0 gap-3 p-3 lg:grid-cols-2">
        <SidePanel title="현재 DB (A)" empty={diff.current.length === 0} tone="current">
          {diff.current.map((criterion, index) => (
            <CurrentCriterionItem key={index} criterion={criterion} />
          ))}
        </SidePanel>
        <SidePanel title="딥분석 제안 (B)" empty={diff.proposed.length === 0} tone="proposed">
          {diff.proposed.map((criterion, index) => (
            <ProposedCriterionItem key={index} criterion={criterion} />
          ))}
        </SidePanel>
      </div>
      {diff.assessment?.comment ? (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          검사 코멘트: {diff.assessment.comment}
        </p>
      ) : null}
    </section>
  );
}

/** A/B 한쪽 패널 — 값이 없으면 점선 블럭으로 "없음"을 명시. */
function SidePanel({
  title,
  empty,
  tone,
  children,
}: {
  title: string;
  empty: boolean;
  tone: "current" | "proposed";
  children: React.ReactNode;
}) {
  if (empty) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-dashed border-border bg-muted/20 p-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
        <span className="py-2 text-center text-xs text-muted-foreground">없음</span>
      </div>
    );
  }
  return (
    <div
      className={
        tone === "proposed"
          ? "flex min-w-0 flex-col gap-2 rounded-md border border-primary/25 bg-primary/5 p-2.5"
          : "flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted/30 p-2.5"
      }
    >
      <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
      {children}
    </div>
  );
}

/** criterion value 를 key-value 줄로 렌더 — 긴 JSON 도 줄바꿈되어 가로 스크롤이 없다. */
function ValueLines({ value }: { value: unknown }) {
  const entries = criterionValueEntries(value);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {entries.map((entry, index) => (
        <div key={index} className="flex min-w-0 gap-1.5 text-xs">
          {entry.key ? (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {entry.key}
            </span>
          ) : null}
          <span className="min-w-0 break-all">{entry.text}</span>
        </div>
      ))}
    </div>
  );
}

function CurrentCriterionItem({ criterion }: { criterion: LabCurrentCriterion }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={kindBadgeVariant(criterion.kind)}>{kindLabel(criterion.kind)}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">{criterion.operator}</span>
        {typeof criterion.confidence === "number" ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            신뢰도 {Math.round(criterion.confidence * 100)}%
          </span>
        ) : null}
        {criterion.needsReview ? <Badge variant="outline">검수 필요</Badge> : null}
      </div>
      <ValueLines value={criterion.value} />
      {criterion.sourceSpan ? <SourceQuote span={criterion.sourceSpan} /> : null}
    </div>
  );
}

function ProposedCriterionItem({ criterion }: { criterion: LabCriterion }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={kindBadgeVariant(criterion.kind)}>{kindLabel(criterion.kind)}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">{criterion.operator}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          신뢰도 {Math.round(criterion.confidence * 100)}%
        </span>
        {criterion.spanVerified ? null : <Badge variant="destructive">근거 미확인</Badge>}
      </div>
      <ValueLines value={criterion.value} />
      {criterion.sourceSpan ? <SourceQuote span={criterion.sourceSpan} /> : null}
      {criterion.note ? (
        <p className="text-[11px] text-muted-foreground">비고: {criterion.note}</p>
      ) : null}
    </div>
  );
}

/** 미채움 축 블럭 — 컴팩트 칩 그리드. 검사 상태가 "검사·조건 없음"이 아닌 축은 배지로 드러낸다. */
function EmptyAxesBlock({ diffs }: { diffs: LabDimensionDiff[] }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-dashed border-border bg-muted/20 p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-muted-foreground">
          미채움 축 ({diffs.length})
        </span>
        <span className="text-[11px] text-muted-foreground">
          현재 DB에도, 딥분석 제안에도 조건이 없는 축입니다. 배지는 딥분석의 검사 결과입니다.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {diffs.map((diff) => (
          <EmptyAxisChip key={diff.dimension} diff={diff} />
        ))}
      </div>
    </section>
  );
}

function EmptyAxisChip({ diff }: { diff: LabDimensionDiff }) {
  const chip = (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="text-xs font-medium">{diff.label}</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {diff.dimension}
        </span>
      </div>
      {diff.assessment ? (
        <Badge variant={AXIS_STATUS_META[diff.assessment.status].variant} className="w-fit">
          {AXIS_STATUS_META[diff.assessment.status].label}
        </Badge>
      ) : (
        <Badge variant="ghost" className="w-fit">
          검사 없음
        </Badge>
      )}
    </div>
  );
  if (!diff.assessment?.comment) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="min-w-0 cursor-help" />}>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-md">
        <span className="whitespace-pre-wrap">{diff.assessment.comment}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** 원문 인용 — 2줄 미리보기 + hover 로 전문. 긴 인용도 블럭 안에서 줄바꿈된다. */
function SourceQuote({ span }: { span: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <p className="line-clamp-2 min-w-0 cursor-help break-words text-[11px] text-muted-foreground" />
        }
      >
        근거: “{span}”
      </TooltipTrigger>
      <TooltipContent className="max-w-md">
        <span className="whitespace-pre-wrap">{span}</span>
      </TooltipContent>
    </Tooltip>
  );
}
