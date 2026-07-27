"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  type RowSelectionState,
  useReactTable,
} from "@tanstack/react-table"
import {
  ArrowUpDownIcon,
  CheckCheckIcon,
  ExternalLinkIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { CriteriaDotGrid } from "./CriteriaDotGrid"
import {
  MANAGEMENT_STATE_LABELS,
  PIPELINE_SOURCE_LABELS,
  PIPELINE_STATUS_LABELS,
  type ManagementState,
  type PipelineAction,
  type PipelineActionTarget,
  type PipelineNoticeItem,
  type PipelineSort,
} from "./contract"

const columnHelper = createColumnHelper<PipelineNoticeItem>()

interface PipelineQueueProps {
  items: PipelineNoticeItem[]
  sort: PipelineSort
  canMutate: boolean
  canReconvert: boolean
  resetSelectionToken: number
  openNoticeId: string | null
  onOpen: (notice: PipelineNoticeItem) => void
  onClose: () => void
  onRequestAction: (action: PipelineAction, targets: PipelineActionTarget[]) => void
  onSortChange: (sort: PipelineSort) => void
}

export function PipelineQueue({
  items,
  sort,
  canMutate,
  canReconvert,
  resetSelectionToken,
  openNoticeId,
  onOpen,
  onClose,
  onRequestAction,
  onSortChange,
}: PipelineQueueProps) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [activeIndex, setActiveIndex] = useState(0)
  const columns = useMemo(() => [
    columnHelper.display({
      id: "select",
      header: ({ table }) => (
        <Checkbox
          aria-label="현재 페이지 전체 선택"
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={table.getIsSomePageRowsSelected()}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(Boolean(value))}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`${row.original.title} 선택`}
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(Boolean(value))}
        />
      ),
    }),
    columnHelper.accessor("managementState", {
      header: "상태",
      cell: ({ getValue }) => <ManagementStateBadge state={getValue()} />,
    }),
    columnHelper.accessor("title", {
      header: "공고",
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col gap-1">
          <Button
            className="h-auto justify-start p-0 text-left whitespace-normal"
            variant="link"
            onClick={() => onOpen(row.original)}
          >
            {row.original.title}
            <ExternalLinkIcon data-icon="inline-end" />
          </Button>
          <span className="truncate text-xs text-muted-foreground">
            {row.original.agency ?? row.original.sourceId}
          </span>
        </div>
      ),
    }),
    columnHelper.accessor("source", {
      header: "소스",
      cell: ({ getValue }) => (
        <Badge variant="outline">{PIPELINE_SOURCE_LABELS[getValue()]}</Badge>
      ),
    }),
    columnHelper.accessor("dDay", {
      header: () => (
        <SortButton
          active={sort === "deadline"}
          label="D-day"
          onClick={() => onSortChange("deadline")}
        />
      ),
      cell: ({ getValue }) => <Deadline value={getValue()} />,
    }),
    columnHelper.accessor("attachmentCount", {
      header: () => (
        <SortButton
          active={sort === "attachments"}
          label="HWP"
          onClick={() => onSortChange("attachments")}
        />
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.attachmentCount}
          {row.original.attachmentProblemCount > 0
            ? ` (${row.original.attachmentProblemCount}⚠)`
            : null}
        </span>
      ),
    }),
    columnHelper.accessor("criteriaDots", {
      header: "22축 기본 추출",
      cell: ({ getValue }) => <CriteriaDotGrid criteria={getValue()} />,
    }),
    columnHelper.accessor("needsReviewCount", {
      header: () => (
        <SortButton
          active={sort === "review"}
          label="검수"
          onClick={() => onSortChange("review")}
        />
      ),
      cell: ({ getValue }) => (
        <span className="tabular-nums">{getValue().toLocaleString("ko-KR")}</span>
      ),
    }),
    columnHelper.accessor("pipelineStatus", {
      header: "단계",
      cell: ({ getValue }) => {
        const value = getValue()
        return value ? (
          <Badge variant="secondary">{PIPELINE_STATUS_LABELS[value]}</Badge>
        ) : (
          <Badge variant="outline">미상</Badge>
        )
      },
    }),
  ], [onOpen, onSortChange, sort])

  const table = useReactTable({
    data: items,
    columns,
    state: { rowSelection },
    enableRowSelection: true,
    getRowId: (row) => row.grantId,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
  })
  const selectedRows = table.getSelectedRowModel().rows.map((row) => row.original)
  const selectedCount = selectedRows.length
  const activeNotice = items[activeIndex] ?? null
  const actionNotices = selectedRows.length > 0
    ? selectedRows
    : activeNotice
      ? [activeNotice]
      : []
  const reviewActionNotices = actionNotices.filter(isReviewActionCandidate)
  const reconvertActionNotices = actionNotices.filter((notice) => notice.attachmentCount > 0)
  const selectedReviewNotices = selectedRows.filter(isReviewActionCandidate)
  const selectedReconvertNotices = selectedRows.filter((notice) => notice.attachmentCount > 0)

  useEffect(() => {
    setRowSelection({})
  }, [resetSelectionToken])
  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, items.length - 1)))
  }, [items.length])

  const requestForNotices = useCallback((
    action: PipelineAction,
    notices: PipelineNoticeItem[],
  ) => {
    if (notices.length === 0) return
    onRequestAction(action, notices.map(toActionTarget))
  }, [onRequestAction])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return
      if (document.querySelector("[data-slot='alert-dialog-content']")) return
      const key = event.key.toLowerCase()
      if (!["j", "k", "enter", "x", "a", "r"].includes(key)) return
      if (items.length === 0) return

      if (key === "j" || key === "k") {
        event.preventDefault()
        const direction = key === "j" ? 1 : -1
        const nextIndex = Math.min(items.length - 1, Math.max(0, activeIndex + direction))
        setActiveIndex(nextIndex)
        if (openNoticeId) {
          const nextNotice = items[nextIndex]
          if (nextNotice) onOpen(nextNotice)
        }
        return
      }

      const active = items[activeIndex]
      if (!active) return
      if (key === "enter") {
        event.preventDefault()
        if (openNoticeId === active.grantId) onClose()
        else onOpen(active)
        return
      }
      if (key === "x") {
        event.preventDefault()
        setRowSelection((current) => ({
          ...current,
          [active.grantId]: !current[active.grantId],
        }))
        return
      }
      if (!canMutate || event.repeat) return
      if (key === "a") {
        event.preventDefault()
        if (reviewActionNotices.length > 0) {
          requestForNotices("mark_reviewed", reviewActionNotices)
        } else if (canReconvert) {
          requestForNotices("reconvert", reconvertActionNotices)
        }
      }
      if (key === "r") {
        event.preventDefault()
        requestForNotices("reconvert", reconvertActionNotices)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    activeIndex,
    canMutate,
    canReconvert,
    items,
    onClose,
    onOpen,
    openNoticeId,
    reconvertActionNotices,
    requestForNotices,
    reviewActionNotices,
  ])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>키보드: j/k 이동 · Enter 상세 · x 선택 · a 기본 추출 검수 완료 · r 재변환</span>
        {activeNotice ? <span>현재 행 {activeIndex + 1}/{items.length}</span> : null}
      </div>

      <div className="overflow-hidden rounded-xl border bg-background">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row, index) => (
                <TableRow
                  key={row.id}
                  aria-current={index === activeIndex ? "true" : undefined}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  className={cn(
                    "[content-visibility:auto] [contain-intrinsic-size:auto_3rem]",
                    index === activeIndex && "outline-2 -outline-offset-2 outline-ring",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32 text-center">
                  조건에 맞는 공고가 없습니다.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {selectedCount > 0 ? (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur">
          <span className="text-sm">
            선택 {selectedCount.toLocaleString("ko-KR")}건
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={!canMutate || selectedReviewNotices.length === 0}
              size="sm"
              onClick={() => requestForNotices("mark_reviewed", selectedReviewNotices)}
            >
              <CheckCheckIcon data-icon="inline-start" />
              기본 추출 검수 완료
            </Button>
            <Button
              disabled={!canMutate || !canReconvert || selectedReconvertNotices.length === 0}
              size="sm"
              title={!canReconvert ? "변환 서버 연결 환경변수가 필요합니다." : undefined}
              variant="outline"
              onClick={() => requestForNotices("reconvert", selectedReconvertNotices)}
            >
              <RotateCcwIcon data-icon="inline-start" />
              재변환
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRowSelection({})}
            >
              <XIcon data-icon="inline-start" />
              선택 해제
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SortButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <Button
      className="-ml-2"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
    >
      {label}
      <ArrowUpDownIcon data-icon="inline-end" />
    </Button>
  )
}

function ManagementStateBadge({ state }: { state: ManagementState }) {
  const variant = state === "failed"
    ? "destructive"
    : state === "auto_reviewable"
      ? "default"
      : state === "in_pipeline" || state === "ok"
        ? "secondary"
        : "outline"
  return <Badge variant={variant}>{MANAGEMENT_STATE_LABELS[state]}</Badge>
}

function Deadline({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">미상</span>
  const label = value === 0 ? "오늘" : value > 0 ? `D-${value}` : `D+${Math.abs(value)}`
  return (
    <span className={cn("tabular-nums", value <= 3 ? "font-semibold text-destructive" : null)}>
      {label}
    </span>
  )
}

function toActionTarget(notice: PipelineNoticeItem): PipelineActionTarget {
  return { source: notice.source, sourceId: notice.sourceId }
}

function isReviewActionCandidate(notice: PipelineNoticeItem): boolean {
  return notice.needsReviewCount > 0 || notice.managementState === "needs_admin"
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable
  )
}
