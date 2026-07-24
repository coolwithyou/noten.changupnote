"use client"

import { useMemo, useState } from "react"
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  ArrowUpDownIcon,
  ExternalLinkIcon,
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
  type PipelineNoticeItem,
  type PipelineSort,
} from "./contract"

const columnHelper = createColumnHelper<PipelineNoticeItem>()

interface PipelineQueueProps {
  items: PipelineNoticeItem[]
  sort: PipelineSort
  onOpen: (notice: PipelineNoticeItem) => void
  onSortChange: (sort: PipelineSort) => void
}

export function PipelineQueue({
  items,
  sort,
  onOpen,
  onSortChange,
}: PipelineQueueProps) {
  const [rowSelection, setRowSelection] = useState({})
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
      header: "22축",
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
  const selectedCount = table.getSelectedRowModel().rows.length

  return (
    <div className="flex flex-col gap-3">
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
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  className="[content-visibility:auto] [contain-intrinsic-size:auto_3rem]"
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
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/50 p-3">
          <span className="text-sm">
            선택 {selectedCount.toLocaleString("ko-KR")}건 · 현재 단계는 읽기 전용입니다.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRowSelection({})}
          >
            <XIcon data-icon="inline-start" />
            선택 해제
          </Button>
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
