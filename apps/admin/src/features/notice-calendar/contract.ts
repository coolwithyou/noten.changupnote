export interface NoticeCalendarCounts {
  collected: number
  analyzed: number
  activated: number
}

export interface NoticeCalendarDay extends NoticeCalendarCounts {
  date: string
  dayOfMonth: number
  inCurrentMonth: boolean
  isToday: boolean
  collectedBySource: {
    kstartup: number
    bizinfo: number
    bizinfoEvent: number
  }
}

export interface NoticeCalendarSnapshot {
  month: string
  monthLabel: string
  previousMonth: string
  nextMonth: string
  todayMonth: string
  generatedAt: string
  timeZone: "Asia/Seoul"
  collectionHistorySource: "events" | "latest_raw_fallback"
  totals: NoticeCalendarCounts
  days: NoticeCalendarDay[]
}
