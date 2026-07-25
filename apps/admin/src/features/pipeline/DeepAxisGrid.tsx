"use client"

import type {
  CriterionDimension,
  DeepAnalysisAxisStatus,
} from "@cunote/contracts"

import {
  AXIS_LABELS,
  DEEP_PIPELINE_DIMENSIONS,
  type DeepPipelineAxis,
} from "@/features/pipeline/contract"
import { cn } from "@/lib/utils"

const STATUS_LABELS: Record<DeepAnalysisAxisStatus, string> = {
  condition_found: "조건 있음",
  inspected_no_condition: "검사 완료·조건 없음",
  ambiguous: "모호",
  input_missing: "입력 누락",
  unassessed: "미검사",
}

export function DeepAxisGrid({
  axes,
  compact = false,
}: {
  axes: DeepPipelineAxis[] | Partial<Record<CriterionDimension, DeepAnalysisAxisStatus>>
  compact?: boolean
}) {
  const statusByDimension = Array.isArray(axes)
    ? new Map(axes.map((axis) => [axis.dimension, axis.status]))
    : new Map(Object.entries(axes) as Array<[CriterionDimension, DeepAnalysisAxisStatus]>)

  return (
    <div
      className={cn(
        "grid gap-1",
        compact ? "grid-cols-11" : "grid-cols-4 sm:grid-cols-6 lg:grid-cols-11",
      )}
      aria-label="22개 분류축 검사 상태"
    >
      {DEEP_PIPELINE_DIMENSIONS.map((dimension) => {
        const status = statusByDimension.get(dimension) ?? "unassessed"
        const label = AXIS_LABELS[dimension]
        return (
          <span
            key={dimension}
            className={cn(
              "flex aspect-square items-center justify-center rounded-sm border text-[10px] font-medium",
              status === "condition_found" && "border-primary bg-primary text-primary-foreground",
              status === "inspected_no_condition" && "border-border bg-muted text-muted-foreground",
              status === "ambiguous" && "border-ring bg-accent text-accent-foreground",
              status === "input_missing" && "border-destructive bg-destructive/10 text-destructive",
              status === "unassessed" && "border-dashed border-border bg-background text-muted-foreground",
            )}
            title={`${label}: ${STATUS_LABELS[status]}`}
            aria-label={`${label}: ${STATUS_LABELS[status]}`}
          >
            {compact ? "" : label.slice(0, 2)}
          </span>
        )
      })}
    </div>
  )
}
