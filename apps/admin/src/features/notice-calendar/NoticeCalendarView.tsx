import Link from "next/link"
import {
  ArrowDownToLineIcon,
  BrainCircuitIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckBigIcon,
  DatabaseIcon,
} from "lucide-react"

import type {
  NoticeCalendarCounts,
  NoticeCalendarDay,
  NoticeCalendarSnapshot,
} from "./contract"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const

export function NoticeCalendarView({
  snapshot,
}: {
  snapshot: NoticeCalendarSnapshot
}) {
  return (
    <main className="flex flex-col gap-6 p-4 md:p-6">
      <section className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-2xl font-semibold tracking-tight">
              공고 처리 캘린더
            </h2>
            <Badge variant="outline">KST</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            수집한 공고가 분석을 거쳐 실제 매칭 후보로 노출되기까지의 일별 처리량입니다.
          </p>
        </div>

        <nav className="flex items-center gap-2" aria-label="월 이동">
          <Link
            className={buttonVariants({ size: "icon", variant: "outline" })}
            href={`/notice-calendar?month=${snapshot.previousMonth}`}
            aria-label="이전 달"
          >
            <ChevronLeftIcon />
          </Link>
          <Link
            className={buttonVariants({ variant: "outline" })}
            href={`/notice-calendar?month=${snapshot.todayMonth}`}
          >
            오늘
          </Link>
          <Link
            className={buttonVariants({ size: "icon", variant: "outline" })}
            href={`/notice-calendar?month=${snapshot.nextMonth}`}
            aria-label="다음 달"
          >
            <ChevronRightIcon />
          </Link>
        </nav>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label="수집·갱신"
          value={snapshot.totals.collected}
          description="신규 또는 내용이 바뀐 공고"
          icon={ArrowDownToLineIcon}
          tone="collected"
        />
        <SummaryCard
          label="분석 완료"
          value={snapshot.totals.analyzed}
          description="분석 완료 검증을 통과한 공고"
          icon={BrainCircuitIcon}
          tone="analyzed"
        />
        <SummaryCard
          label="매칭 후보 활성화"
          value={snapshot.totals.activated}
          description="실제 매칭 노출 검증을 통과한 공고"
          icon={CircleCheckBigIcon}
          tone="activated"
        />
      </section>

      {snapshot.collectionHistorySource === "latest_raw_fallback" ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <DatabaseIcon className="mt-0.5 size-4 shrink-0" />
          <p>
            수집 이력 마이그레이션 적용 전이라 최신 관측일 기준으로 표시합니다. 마이그레이션 적용 후부터
            날짜별 이력이 고정됩니다.
          </p>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl">
              <CalendarDaysIcon className="size-5 text-muted-foreground" />
              {snapshot.monthLabel}
            </CardTitle>
            <CardDescription>
              같은 분석 실행의 재검증 기록은 최초 통과 시각 한 번만 집계합니다.
            </CardDescription>
          </div>
          <CardAction>
            <Badge variant="secondary">
              {formatGeneratedAt(snapshot.generatedAt)} 기준
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] table-fixed border-collapse">
              <caption className="sr-only">
                {snapshot.monthLabel} 공고 수집, 분석 완료, 매칭 후보 활성화 건수
              </caption>
              <thead>
                <tr className="border-b bg-muted/40">
                  {WEEKDAYS.map((weekday, index) => (
                    <th
                      key={weekday}
                      className={cn(
                        "h-10 px-3 text-left text-xs font-medium text-muted-foreground",
                        index === 0 && "text-rose-600 dark:text-rose-400",
                        index === 6 && "text-blue-600 dark:text-blue-400",
                      )}
                      scope="col"
                    >
                      {weekday}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {chunkDays(snapshot.days).map((week) => (
                  <tr className="border-b last:border-b-0" key={week[0]?.date}>
                    {week.map((day) => (
                      <CalendarDayCell day={day} key={day.date} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <section className="grid gap-3 text-sm text-muted-foreground lg:grid-cols-3">
        <Definition
          tone="collected"
          title="수집·갱신"
          description="원문 해시가 처음 보이거나 변경되어 발행 파이프라인에 들어온 공고입니다."
        />
        <Definition
          tone="analyzed"
          title="분석 완료"
          description="딥분석의 analysis_complete 검증 영수증이 통과한 고유 공고입니다."
        />
        <Definition
          tone="activated"
          title="매칭 후보 활성화"
          description="serving_complete 검증으로 사용자 매칭 노출까지 확인된 고유 공고입니다."
        />
      </section>
    </main>
  )
}

function SummaryCard({
  label,
  value,
  description,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  description: string
  icon: typeof CalendarDaysIcon
  tone: keyof NoticeCalendarCounts
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardAction>
          <span className={cn("flex size-8 items-center justify-center rounded-lg", toneClass(tone, "soft"))}>
            <Icon className="size-4" />
          </span>
        </CardAction>
        <CardTitle className="text-3xl tabular-nums">
          {value.toLocaleString("ko-KR")}
          <span className="ml-1 text-sm font-normal text-muted-foreground">건</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{description}</CardContent>
    </Card>
  )
}

function CalendarDayCell({ day }: { day: NoticeCalendarDay }) {
  const hasActivity = day.collected + day.analyzed + day.activated > 0
  const sourceSummary = [
    day.collectedBySource.kstartup > 0 ? `K-Startup ${day.collectedBySource.kstartup}` : null,
    day.collectedBySource.bizinfo > 0 ? `기업마당 ${day.collectedBySource.bizinfo}` : null,
    day.collectedBySource.bizinfoEvent > 0 ? `기업마당 행사 ${day.collectedBySource.bizinfoEvent}` : null,
  ].filter(Boolean).join(" · ")

  return (
    <td
      className={cn(
        "h-32 border-r p-2 align-top last:border-r-0",
        !day.inCurrentMonth && "bg-muted/20 text-muted-foreground/60",
        day.isToday && "bg-primary/[0.04] shadow-[inset_0_0_0_2px_var(--color-primary)]",
      )}
    >
      <div className="flex items-center justify-between">
        <time
          className={cn(
            "flex size-7 items-center justify-center rounded-full text-xs font-medium tabular-nums",
            day.isToday && "bg-primary text-primary-foreground",
          )}
          dateTime={day.date}
        >
          {day.dayOfMonth}
        </time>
        {hasActivity ? (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            총 {day.collected + day.analyzed + day.activated}
          </span>
        ) : null}
      </div>

      {hasActivity ? (
        <div className="mt-2 flex flex-col gap-1">
          <CountRow label="수집" value={day.collected} tone="collected" title={sourceSummary} />
          <CountRow label="분석" value={day.analyzed} tone="analyzed" />
          <CountRow label="활성" value={day.activated} tone="activated" />
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-muted-foreground/50">기록 없음</p>
      )}
    </td>
  )
}

function CountRow({
  label,
  value,
  tone,
  title,
}: {
  label: string
  value: number
  tone: keyof NoticeCalendarCounts
  title?: string
}) {
  return (
    <div
      className={cn(
        "flex h-6 items-center justify-between gap-2 rounded-md px-2 text-[11px]",
        value > 0 ? toneClass(tone, "soft") : "bg-muted/30 text-muted-foreground/50",
      )}
      title={title || undefined}
    >
      <span>{label}</span>
      <strong className="tabular-nums">{value.toLocaleString("ko-KR")}</strong>
    </div>
  )
}

function Definition({
  title,
  description,
  tone,
}: {
  title: string
  description: string
  tone: keyof NoticeCalendarCounts
}) {
  return (
    <div className="flex gap-3 rounded-lg border bg-card p-4">
      <span className={cn("mt-1 size-2 shrink-0 rounded-full", toneClass(tone, "dot"))} />
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs leading-relaxed">{description}</p>
      </div>
    </div>
  )
}

function toneClass(
  tone: keyof NoticeCalendarCounts,
  kind: "soft" | "dot",
): string {
  if (kind === "dot") {
    if (tone === "collected") return "bg-sky-500"
    if (tone === "analyzed") return "bg-violet-500"
    return "bg-emerald-500"
  }
  if (tone === "collected") return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200"
  if (tone === "analyzed") return "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200"
  return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
}

function chunkDays(days: NoticeCalendarDay[]): NoticeCalendarDay[][] {
  return Array.from({ length: 6 }, (_, index) => days.slice(index * 7, index * 7 + 7))
}

function formatGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}
