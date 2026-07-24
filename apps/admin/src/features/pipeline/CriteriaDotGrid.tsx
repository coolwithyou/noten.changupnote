"use client"

import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { PipelineCriterionDot } from "./contract"

export function CriteriaDotGrid({
  criteria,
}: {
  criteria: PipelineCriterionDot[]
}) {
  return (
    <div
      className="grid w-fit grid-cols-11 gap-1"
      aria-label={`22축 중 ${criteria.filter((item) => item.filled).length}축 추출`}
    >
      {criteria.map((criterion) => (
        <Tooltip key={criterion.dimension}>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "size-2 rounded-full ring-1 ring-border",
                  criterion.needsReview
                    ? "bg-[var(--warning)]"
                    : criterion.filled
                      ? "bg-[var(--success)]"
                      : "bg-muted",
                )}
                aria-label={`${criterion.label}: ${
                  criterion.needsReview
                    ? "검수 필요"
                    : criterion.filled
                      ? "추출됨"
                      : "공란"
                }`}
              />
            }
          />
          <TooltipContent>
            <span className="font-medium">{criterion.label}</span>
            <span>
              {criterion.valueLabel
                ? ` · ${criterion.valueLabel}`
                : criterion.needsReview
                  ? " · 검수 필요"
                  : " · 공란"}
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
