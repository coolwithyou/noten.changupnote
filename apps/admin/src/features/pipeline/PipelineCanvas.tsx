"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DatabaseZapIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  type PipelineBucket,
  type PipelineSource,
  type PipelineSummary,
} from "./contract"

interface PipelineCanvasProps {
  summary: PipelineSummary
  activeSource: PipelineSource | null
  activeBucket: PipelineBucket | null
  onSourceChange: (source: PipelineSource | null) => void
  onBucketChange: (bucket: PipelineBucket | null) => void
}

const VIEWBOX_WIDTH = 1200
const SOURCE_X = 52
const SOURCE_WIDTH = 280
const BUCKET_X = 820
const BUCKET_WIDTH = 328
const NODE_HEIGHT = 64
const BUCKET_GAP = 20

export function PipelineCanvas({
  summary,
  activeSource,
  activeBucket,
  onSourceChange,
  onBucketChange,
}: PipelineCanvasProps) {
  const [open, setOpen] = useState(true)
  const height = Math.max(330, 36 + summary.buckets.length * (NODE_HEIGHT + BUCKET_GAP))
  const sourceGap = (height - 3 * NODE_HEIGHT) / 4
  const sourceNodes = summary.sources.map((source, index) => ({
    ...source,
    x: SOURCE_X,
    y: sourceGap + index * (NODE_HEIGHT + sourceGap),
  }))
  const bucketNodes = summary.buckets.map((bucket, index) => ({
    ...bucket,
    x: BUCKET_X,
    y: 30 + index * (NODE_HEIGHT + BUCKET_GAP),
  }))
  const maxFlow = useMemo(
    () => Math.max(1, ...summary.buckets.flatMap((bucket) => Object.values(bucket.bySource))),
    [summary.buckets],
  )

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CardHeader>
          <CardTitle>집계 관제 캔버스</CardTitle>
          <CardDescription>
            소스와 현재 렌즈의 버킷 사이 유량입니다. 노드를 선택하면 큐 필터가 즉시 바뀝니다.
          </CardDescription>
          <CardAction>
            <CollapsibleTrigger
              render={<Button size="sm" variant="outline" />}
            >
              {open ? (
                <ChevronUpIcon data-icon="inline-start" />
              ) : (
                <ChevronDownIcon data-icon="inline-start" />
              )}
              {open ? "캔버스 접기" : "캔버스 펼치기"}
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            <div className="overflow-x-auto rounded-xl border bg-muted/20">
              <svg
                aria-label="공고 수집 소스와 관제 버킷 연결도"
                className="min-w-[900px]"
                role="group"
                viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
              >
                <defs>
                  <linearGradient id="pipeline-wire" x1="0" x2="1">
                    <stop offset="0%" stopColor="var(--muted-foreground)" stopOpacity="0.24" />
                    <stop offset="100%" stopColor="var(--foreground)" stopOpacity="0.55" />
                  </linearGradient>
                </defs>

                <text x={SOURCE_X} y={22} className="fill-muted-foreground text-[12px] font-semibold">
                  수집 소스
                </text>
                <text x={BUCKET_X} y={22} className="fill-muted-foreground text-[12px] font-semibold">
                  관제 버킷
                </text>

                <g aria-hidden="true">
                  {sourceNodes.flatMap((source) => bucketNodes.map((bucket) => {
                    const count = bucket.bySource[source.source]
                    if (count <= 0) return null
                    const startX = source.x + SOURCE_WIDTH
                    const startY = source.y + NODE_HEIGHT / 2
                    const endX = bucket.x
                    const endY = bucket.y + NODE_HEIGHT / 2
                    const controlOffset = (endX - startX) * 0.46
                    return (
                      <path
                        key={`${source.source}-${bucket.key}`}
                        d={[
                          `M ${startX} ${startY}`,
                          `C ${startX + controlOffset} ${startY}`,
                          `${endX - controlOffset} ${endY}`,
                          `${endX} ${endY}`,
                        ].join(" ")}
                        fill="none"
                        opacity={activeSource && activeSource !== source.source ? 0.2 : 1}
                        stroke="url(#pipeline-wire)"
                        strokeLinecap="round"
                        strokeWidth={1.5 + (count / maxFlow) * 8}
                      />
                    )
                  }))}
                </g>

                {sourceNodes.map((source) => (
                  <foreignObject
                    key={source.source}
                    x={source.x}
                    y={source.y}
                    width={SOURCE_WIDTH}
                    height={NODE_HEIGHT}
                  >
                    <Button
                      className={cn(
                        "h-full w-full justify-between rounded-xl border bg-background px-4 text-left shadow-sm",
                        activeSource === source.source && "border-primary bg-primary/5",
                      )}
                      variant="ghost"
                      onClick={() => onSourceChange(
                        activeSource === source.source ? null : source.source,
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <DatabaseZapIcon className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{source.label}</span>
                          <span className="block text-xs text-muted-foreground">
                            오늘 +{source.todayNewCount.toLocaleString("ko-KR")}
                          </span>
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        {source.stale ? (
                          <AlertTriangleIcon className="text-destructive" />
                        ) : null}
                        <Badge variant={source.stale ? "destructive" : "secondary"}>
                          {source.openCount.toLocaleString("ko-KR")}
                        </Badge>
                      </span>
                    </Button>
                  </foreignObject>
                ))}

                {bucketNodes.map((bucket) => (
                  <foreignObject
                    key={bucket.key}
                    x={bucket.x}
                    y={bucket.y}
                    width={BUCKET_WIDTH}
                    height={NODE_HEIGHT}
                  >
                    <Button
                      className={cn(
                        "h-full w-full justify-between rounded-xl border bg-background px-4 text-left shadow-sm",
                        activeBucket === bucket.key && "border-primary bg-primary/5",
                      )}
                      variant="ghost"
                      onClick={() => onBucketChange(
                        activeBucket === bucket.key ? null : bucket.key,
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{bucket.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {Object.entries(bucket.bySource)
                            .filter(([, count]) => count > 0)
                            .map(([source, count]) => `${source} ${count}`)
                            .join(" · ") || "유입 없음"}
                        </span>
                      </span>
                      <Badge variant="secondary">
                        {bucket.count.toLocaleString("ko-KR")}
                      </Badge>
                    </Button>
                  </foreignObject>
                ))}
              </svg>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
