import type {
  NoticeCalendarCounts,
  NoticeCalendarDay,
  NoticeCalendarSnapshot,
} from "./contract"

const MONTH_PATTERN = /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/
const KST_OFFSET = "+09:00"

interface DailyAggregate {
  date: string
  collected: number
  analyzed: number
  activated: number
  kstartup: number
  bizinfo: number
  bizinfoEvent: number
}

export interface NoticeCalendarRange {
  month: string
  startDate: string
  endDateExclusive: string
  startAt: Date
  endAt: Date
  previousMonth: string
  nextMonth: string
  days: Array<{
    date: string
    dayOfMonth: number
    inCurrentMonth: boolean
  }>
}

export function parseNoticeCalendarMonth(
  value: string | string[] | undefined,
  now = new Date(),
): string {
  const candidate = Array.isArray(value) ? value[0] : value
  if (candidate && MONTH_PATTERN.test(candidate)) return candidate
  return formatMonthInKst(now)
}

export function buildNoticeCalendarRange(month: string): NoticeCalendarRange {
  if (!MONTH_PATTERN.test(month)) {
    throw new Error(`Invalid notice calendar month: ${month}`)
  }

  const [yearText, monthText] = month.split("-")
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1
  const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1))
  const gridStart = addUtcDays(firstOfMonth, -firstOfMonth.getUTCDay())
  const gridEnd = addUtcDays(gridStart, 42)

  return {
    month,
    startDate: formatUtcDate(gridStart),
    endDateExclusive: formatUtcDate(gridEnd),
    startAt: new Date(`${formatUtcDate(gridStart)}T00:00:00${KST_OFFSET}`),
    endAt: new Date(`${formatUtcDate(gridEnd)}T00:00:00${KST_OFFSET}`),
    previousMonth: formatUtcMonth(new Date(Date.UTC(year, monthIndex - 1, 1))),
    nextMonth: formatUtcMonth(new Date(Date.UTC(year, monthIndex + 1, 1))),
    days: Array.from({ length: 42 }, (_, index) => {
      const date = addUtcDays(gridStart, index)
      return {
        date: formatUtcDate(date),
        dayOfMonth: date.getUTCDate(),
        inCurrentMonth: date.getUTCMonth() === monthIndex,
      }
    }),
  }
}

export function buildNoticeCalendarSnapshot(input: {
  range: NoticeCalendarRange
  aggregates: DailyAggregate[]
  generatedAt?: Date
  historySource: NoticeCalendarSnapshot["collectionHistorySource"]
}): NoticeCalendarSnapshot {
  const generatedAt = input.generatedAt ?? new Date()
  const today = formatDateInKst(generatedAt)
  const aggregateByDate = new Map(input.aggregates.map((item) => [item.date, item]))
  const zero: Omit<DailyAggregate, "date"> = {
    collected: 0,
    analyzed: 0,
    activated: 0,
    kstartup: 0,
    bizinfo: 0,
    bizinfoEvent: 0,
  }

  const days: NoticeCalendarDay[] = input.range.days.map((day) => {
    const aggregate = aggregateByDate.get(day.date) ?? zero
    return {
      ...day,
      isToday: day.date === today,
      collected: aggregate.collected,
      analyzed: aggregate.analyzed,
      activated: aggregate.activated,
      collectedBySource: {
        kstartup: aggregate.kstartup,
        bizinfo: aggregate.bizinfo,
        bizinfoEvent: aggregate.bizinfoEvent,
      },
    }
  })

  const totals = days.reduce<NoticeCalendarCounts>((sum, day) => {
    if (!day.inCurrentMonth) return sum
    sum.collected += day.collected
    sum.analyzed += day.analyzed
    sum.activated += day.activated
    return sum
  }, { collected: 0, analyzed: 0, activated: 0 })

  return {
    month: input.range.month,
    monthLabel: `${Number(input.range.month.slice(0, 4))}년 ${Number(input.range.month.slice(5))}월`,
    previousMonth: input.range.previousMonth,
    nextMonth: input.range.nextMonth,
    todayMonth: formatMonthInKst(generatedAt),
    generatedAt: generatedAt.toISOString(),
    timeZone: "Asia/Seoul",
    collectionHistorySource: input.historySource,
    totals,
    days,
  }
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function formatUtcMonth(date: Date): string {
  return date.toISOString().slice(0, 7)
}

function formatDateInKst(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

function formatMonthInKst(date: Date): string {
  return formatDateInKst(date).slice(0, 7)
}
