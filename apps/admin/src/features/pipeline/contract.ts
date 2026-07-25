import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
} from "@cunote/contracts"

export const PIPELINE_SOURCES = [
  "kstartup",
  "bizinfo",
  "bizinfo_event",
] as const

export type PipelineSource = (typeof PIPELINE_SOURCES)[number]

export const PIPELINE_SOURCE_LABELS: Record<PipelineSource, string> = {
  kstartup: "K-Startup",
  bizinfo: "기업마당",
  bizinfo_event: "기업마당 이벤트",
}

export const MANAGEMENT_STATES = [
  "failed",
  "needs_admin",
  "auto_reviewable",
  "in_pipeline",
  "ok",
  "closed",
] as const

export type ManagementState = (typeof MANAGEMENT_STATES)[number]

export const MANAGEMENT_STATE_LABELS: Record<ManagementState, string> = {
  failed: "실패",
  needs_admin: "확인 필요",
  auto_reviewable: "자동 검수 가능",
  in_pipeline: "진행 중",
  ok: "정상",
  closed: "마감",
}

export const PIPELINE_LENSES = ["review", "pipeline", "deadline"] as const

export type PipelineLens = (typeof PIPELINE_LENSES)[number]

export const PIPELINE_LENS_LABELS: Record<PipelineLens, string> = {
  review: "검수",
  pipeline: "파이프라인",
  deadline: "마감",
}

export const PIPELINE_SORTS = ["deadline", "review", "attachments"] as const

export type PipelineSort = (typeof PIPELINE_SORTS)[number]

export const PIPELINE_SORT_LABELS: Record<PipelineSort, string> = {
  deadline: "마감 임박",
  review: "검수 많은 순",
  attachments: "첨부 문제 많은 순",
}

export const PIPELINE_STATUSES = [
  "fetched",
  "converted",
  "extracted",
  "normalized",
  "published",
  "failed",
] as const

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number]

export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
  fetched: "수집",
  converted: "변환",
  extracted: "추출",
  normalized: "정규화",
  published: "발행",
  failed: "실패",
}

export const DEADLINE_BUCKETS = [
  "today",
  "within_3_days",
  "within_7_days",
  "within_30_days",
  "later",
  "unknown",
] as const

export type DeadlineBucket = (typeof DEADLINE_BUCKETS)[number]

export const DEADLINE_BUCKET_LABELS: Record<DeadlineBucket, string> = {
  today: "오늘",
  within_3_days: "3일 이내",
  within_7_days: "7일 이내",
  within_30_days: "30일 이내",
  later: "이후",
  unknown: "마감 미상",
}

export type PipelineBucket =
  | ManagementState
  | PipelineStatus
  | DeadlineBucket

export const PIPELINE_ACTIONS = ["mark_reviewed", "reconvert"] as const

export type PipelineAction = (typeof PIPELINE_ACTIONS)[number]

export const PIPELINE_ACTION_LABELS: Record<PipelineAction, string> = {
  mark_reviewed: "검수 완료",
  reconvert: "재변환 요청",
}

export const CRITERION_DIMENSION_LABELS: Record<CriterionDimension, string> = {
  region: "지역",
  biz_age: "업력",
  industry: "업종",
  size: "기업 규모",
  revenue: "매출",
  employees: "임직원",
  founder_age: "대표자 연령",
  founder_trait: "대표자 특성",
  certification: "인증",
  prior_award: "기수혜",
  ip: "지식재산",
  target_type: "신청 대상",
  business_status: "사업 상태",
  tax_compliance: "세금 체납",
  credit_status: "신용 상태",
  sanction: "제재·참여제한",
  financial_health: "재무 건전성",
  insured_workforce: "고용보험 피보험자",
  investment: "투자 유치",
  premises: "사업장·입지",
  export_performance: "수출 실적",
  other: "기타",
}

export const PIPELINE_CRITERION_DIMENSIONS = CRITERION_DIMENSIONS

export interface PipelineSourceSummary {
  source: PipelineSource
  label: string
  openCount: number
  todayNewCount: number
  lastCollectedAt: string | null
  stale: boolean
}

export interface PipelineBucketSummary {
  key: PipelineBucket
  label: string
  count: number
  bySource: Record<PipelineSource, number>
}

export interface PipelineSummary {
  generatedAt: string
  lens: PipelineLens
  total: number
  sources: PipelineSourceSummary[]
  buckets: PipelineBucketSummary[]
  refreshAfterSeconds: number
}

export interface PipelineCriterionDot {
  dimension: CriterionDimension
  label: string
  filled: boolean
  needsReview: boolean
  valueLabel: string | null
}

export interface PipelineNoticeItem {
  grantId: string
  source: PipelineSource
  sourceId: string
  title: string
  agency: string | null
  applyStart: string | null
  applyEnd: string | null
  dDay: number | null
  managementState: ManagementState
  pipelineStatus: PipelineStatus | null
  attachmentCount: number
  attachmentProblemCount: number
  criteriaFilledCount: number
  needsReviewCount: number
  criteriaDots: PipelineCriterionDot[]
  updatedAt: string
}

export interface PipelineNoticesResult {
  generatedAt: string
  total: number
  page: number
  pageSize: number
  pageCount: number
  hasPrevious: boolean
  hasNext: boolean
  items: PipelineNoticeItem[]
}

export interface PipelineCriterionDetail {
  id: string
  dimension: CriterionDimension
  label: string
  operator: string
  kind: string
  value: Record<string, unknown>
  valueLabel: string
  confidence: number
  rawText: string | null
  sourceSpan: string | null
  needsReview: boolean
  parserVersion: string | null
}

export interface PipelineAttachmentDetail {
  id: string
  filename: string
  contentType: string | null
  bytes: number | null
  conversionStatus: string | null
  markdownUrl: string | null
  conversionError: string | null
  converter: string | null
  convertedAt: string | null
  updatedAt: string
}

export interface PipelineSurfaceDetail {
  id: string
  title: string
  type: string
  format: string
  extractionStatus: string
  extractionVersion: string | null
  confidence: number | null
  sourceUrl: string | null
  updatedAt: string
}

export interface PipelineHistoryDetail {
  id: string
  status: string
  confidence: number
  modelVer: string
  promptVer: string
  reviewer: string | null
  at: string
}

export interface PipelineAdminActionDetail {
  id: string
  requestId: string
  action: PipelineAction
  status: "queued" | "succeeded" | "partial" | "failed"
  actorEmail: string
  result: Record<string, unknown>
  error: string | null
  createdAt: string
  completedAt: string | null
}

export interface PipelineGoldenSetDetail {
  id: string
  ref: string
  goldenVer: string
}

export interface PipelineNoticeDetail {
  notice: PipelineNoticeItem & {
    url: string | null
    parserVersion: string | null
    modelVer: string | null
    promptVer: string | null
    collectedAt: string | null
    demoHref: string
  }
  criteria: PipelineCriterionDetail[]
  attachments: PipelineAttachmentDetail[]
  surfaces: PipelineSurfaceDetail[]
  history: PipelineHistoryDetail[]
  adminActions: PipelineAdminActionDetail[]
  goldenSet: PipelineGoldenSetDetail[]
}

export interface PipelineActionTarget {
  source: PipelineSource
  sourceId: string
  attachmentIds?: string[]
}

export interface PipelineActionRequest {
  requestId: string
  action: PipelineAction
  targets: PipelineActionTarget[]
}

export interface PipelineActionTargetResult extends PipelineActionTarget {
  grantId: string
  title: string
  status: "succeeded" | "partial" | "failed"
  affectedCount: number
  message: string
}

export interface PipelineActionResponse {
  requestId: string
  action: PipelineAction
  totals: {
    requested: number
    succeeded: number
    partial: number
    failed: number
    affected: number
  }
  results: PipelineActionTargetResult[]
}

export interface PipelineQueryState {
  lens: PipelineLens
  source: PipelineSource | null
  bucket: PipelineBucket | null
  q: string
  sort: PipelineSort
  page: number
  includeClosed: boolean
}

export interface PipelineMeasurement {
  measuredAt: string
  activeNotices: number
  managementStates: Record<ManagementState, number>
  sources: Record<PipelineSource, number>
  rawStatuses: Record<string, number>
  attachmentStatuses: Record<string, number>
  needsReview: {
    noticeCount: number
    rowCount: number
    p50RowsPerNotice: number
    p95RowsPerNotice: number
    maxRowsPerNotice: number
  }
  attachments: {
    noticeCount: number
    failedNoticeCount: number
    nullStatusCount: number
    totalCount: number
  }
  extractionHistory: Record<string, number>
}

export function isPipelineSource(value: string | null): value is PipelineSource {
  return PIPELINE_SOURCES.includes(value as PipelineSource)
}

export function isManagementState(value: string | null): value is ManagementState {
  return MANAGEMENT_STATES.includes(value as ManagementState)
}

export function isPipelineStatus(value: string | null): value is PipelineStatus {
  return PIPELINE_STATUSES.includes(value as PipelineStatus)
}

export function isDeadlineBucket(value: string | null): value is DeadlineBucket {
  return DEADLINE_BUCKETS.includes(value as DeadlineBucket)
}

export function isPipelineBucket(value: string | null): value is PipelineBucket {
  return isManagementState(value) || isPipelineStatus(value) || isDeadlineBucket(value)
}

export function isPipelineLens(value: string | null): value is PipelineLens {
  return PIPELINE_LENSES.includes(value as PipelineLens)
}

export function isPipelineSort(value: string | null): value is PipelineSort {
  return PIPELINE_SORTS.includes(value as PipelineSort)
}

export function isPipelineAction(value: string | null): value is PipelineAction {
  return PIPELINE_ACTIONS.includes(value as PipelineAction)
}

export function labelForPipelineBucket(
  lens: PipelineLens,
  bucket: PipelineBucket,
): string {
  if (lens === "review" && isManagementState(bucket)) {
    return MANAGEMENT_STATE_LABELS[bucket]
  }
  if (lens === "pipeline" && isPipelineStatus(bucket)) {
    return PIPELINE_STATUS_LABELS[bucket]
  }
  if (lens === "deadline" && isDeadlineBucket(bucket)) {
    return DEADLINE_BUCKET_LABELS[bucket]
  }
  return bucket
}
