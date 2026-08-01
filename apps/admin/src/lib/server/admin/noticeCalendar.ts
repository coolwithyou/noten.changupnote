import {
  buildNoticeCalendarSnapshot,
  type NoticeCalendarRange,
} from "@/features/notice-calendar/calendar"
import type { NoticeCalendarSnapshot } from "@/features/notice-calendar/contract"
import { getAdminSql } from "@/lib/server/db/client"

interface CollectionRow {
  day: string
  source: "kstartup" | "bizinfo" | "bizinfo_event"
  count: number
}

interface MilestoneRow {
  day: string
  analyzed: number
  activated: number
}

interface DailyAggregate {
  date: string
  collected: number
  analyzed: number
  activated: number
  kstartup: number
  bizinfo: number
  bizinfoEvent: number
}

export async function getNoticeCalendarSnapshot(
  range: NoticeCalendarRange,
  now = new Date(),
): Promise<NoticeCalendarSnapshot> {
  const sql = getAdminSql()
  const [eventTable] = await sql<{ available: boolean }[]>`
    SELECT to_regclass('public.grant_collection_events') IS NOT NULL AS available
  `
  const historySource = eventTable?.available ? "events" : "latest_raw_fallback"

  const [collectionRows, milestoneRows] = await Promise.all([
    historySource === "events"
      ? loadCollectionEventRows(range)
      : loadLatestRawRows(range),
    loadMilestoneRows(range),
  ])

  return buildNoticeCalendarSnapshot({
    range,
    generatedAt: now,
    historySource,
    aggregates: mergeDailyRows(collectionRows, milestoneRows),
  })
}

async function loadCollectionEventRows(
  range: NoticeCalendarRange,
): Promise<CollectionRow[]> {
  const sql = getAdminSql()
  return sql<CollectionRow[]>`
    SELECT
      to_char(timezone('Asia/Seoul', collected_at), 'YYYY-MM-DD') AS day,
      source::text AS source,
      count(*)::int AS count
    FROM grant_collection_events
    WHERE collected_at >= ${range.startAt}
      AND collected_at < ${range.endAt}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `
}

async function loadLatestRawRows(
  range: NoticeCalendarRange,
): Promise<CollectionRow[]> {
  const sql = getAdminSql()
  return sql<CollectionRow[]>`
    SELECT
      to_char(timezone('Asia/Seoul', collected_at), 'YYYY-MM-DD') AS day,
      source::text AS source,
      count(*)::int AS count
    FROM grant_raw
    WHERE collected_at >= ${range.startAt}
      AND collected_at < ${range.endAt}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `
}

async function loadMilestoneRows(
  range: NoticeCalendarRange,
): Promise<MilestoneRow[]> {
  const sql = getAdminSql()
  return sql<MilestoneRow[]>`
    WITH first_passed_receipt AS (
      SELECT
        receipt.run_id,
        receipt.stage,
        min(receipt.created_at) AS first_passed_at
      FROM grant_deep_analysis_stage_receipts receipt
      WHERE receipt.stage IN ('analysis_complete', 'serving_complete')
        AND receipt.status = 'passed'
      GROUP BY receipt.run_id, receipt.stage
    ),
    daily AS (
      SELECT
        to_char(timezone('Asia/Seoul', first_passed.first_passed_at), 'YYYY-MM-DD') AS day,
        count(DISTINCT run.grant_id) FILTER (
          WHERE first_passed.stage = 'analysis_complete'
        )::int AS analyzed,
        count(DISTINCT run.grant_id) FILTER (
          WHERE first_passed.stage = 'serving_complete'
        )::int AS activated
      FROM first_passed_receipt first_passed
      JOIN grant_deep_analysis_runs run ON run.id = first_passed.run_id
      WHERE first_passed.first_passed_at >= ${range.startAt}
        AND first_passed.first_passed_at < ${range.endAt}
      GROUP BY 1
    )
    SELECT day, analyzed, activated
    FROM daily
    ORDER BY day
  `
}

function mergeDailyRows(
  collectionRows: CollectionRow[],
  milestoneRows: MilestoneRow[],
): DailyAggregate[] {
  const rows = new Map<string, DailyAggregate>()
  const getRow = (date: string) => {
    const current = rows.get(date)
    if (current) return current
    const created: DailyAggregate = {
      date,
      collected: 0,
      analyzed: 0,
      activated: 0,
      kstartup: 0,
      bizinfo: 0,
      bizinfoEvent: 0,
    }
    rows.set(date, created)
    return created
  }

  for (const item of collectionRows) {
    const row = getRow(item.day)
    row.collected += item.count
    if (item.source === "kstartup") row.kstartup += item.count
    else if (item.source === "bizinfo") row.bizinfo += item.count
    else row.bizinfoEvent += item.count
  }
  for (const item of milestoneRows) {
    const row = getRow(item.day)
    row.analyzed = item.analyzed
    row.activated = item.activated
  }

  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date))
}
