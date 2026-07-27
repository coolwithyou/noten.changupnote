import {
  CRITERION_DIMENSIONS,
  DEEP_ANALYSIS_STAGE_KEYS,
  type CriterionDimension,
  type DeepAnalysisAxisStatus,
  type DeepAnalysisStageKey,
  type DeepAnalysisStageStatus,
} from "@cunote/contracts"

export const DEEP_PIPELINE_BUCKETS = [
  "serving_complete_fresh",
  "analysis_complete_not_published",
  "in_progress",
  "blocked_or_failed",
  "stale",
] as const

export type DeepPipelineBucket = (typeof DEEP_PIPELINE_BUCKETS)[number]

export const DEEP_PIPELINE_BUCKET_LABELS: Record<DeepPipelineBucket, string> = {
  serving_complete_fresh: "서빙 완료·최신",
  analysis_complete_not_published: "분석 완료·미발행",
  in_progress: "대기·진행 중",
  blocked_or_failed: "차단·실패",
  stale: "원문 변경·stale",
}

export const DEEP_STAGE_LABELS: Record<DeepAnalysisStageKey, string> = {
  source_fresh: "S0 원문 최신",
  attachment_inventory_complete: "S1 첨부 목록",
  attachment_archive_complete: "S2 원본 보관",
  attachment_text_complete: "S3 본문 변환",
  input_coverage_verified: "S4 입력 전수 확인",
  input_sealed: "S5 입력 봉인",
  model_call_passed: "S6 최상급 모델",
  response_contract_valid: "S7 응답 계약",
  axis_coverage_complete: "S8 22축 완전성",
  evidence_grounded: "S9 근거 검증",
  independent_audit_passed: "S10 독립 감사",
  analysis_complete: "S11 분석 완료",
  publication_complete: "S12 발행 완료",
  serving_complete: "S13 서빙 검증",
  analysis_fresh: "S14 최신성 검증",
}

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
  published: "기본 데이터 발행",
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
  mark_reviewed: "기본 추출 검수 완료",
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

export const AXIS_LABELS = CRITERION_DIMENSION_LABELS

export const DEEP_PIPELINE_DIMENSIONS = CRITERION_DIMENSIONS
export const DEEP_PIPELINE_STAGES = DEEP_ANALYSIS_STAGE_KEYS

export interface DeepPipelineBucketSummary {
  key: DeepPipelineBucket
  label: string
  count: number
}

export interface DeepPipelineStageSummary {
  stage: DeepAnalysisStageKey
  label: string
  passed: number
  failed: number
  blocked: number
  stale: number
  running: number
  pending: number
  notApplicable: number
  missing: number
}

export interface DeepPipelineSummary {
  generatedAt: string
  modelPolicyVersion: string
  contractModelPolicyVersion: string
  policyMatchesContract: boolean
  activeTotal: number
  classifiedTotal: number
  activeReleaseCount: number
  reanalysisRequiredCount: number
  degraded: boolean
  buckets: DeepPipelineBucketSummary[]
  stages: DeepPipelineStageSummary[]
  worker: {
    workerId: string | null
    currentJobId: string | null
    status: string | null
    modelPolicyVersion: string | null
    expectedModelPolicyVersion: string
    policyMatches: boolean
    executionMode: "active" | "observe_only" | null
    claimScope: "unconfigured" | "bounded" | "all" | null
    claimCohortCount: number
    claimCohortSha256: string | null
    serviceRevision: string | null
    heartbeatAt: string | null
    stale: boolean
    staleSeconds: number | null
    activeWorkerCount: number
    activeLeaseCount: number
    staleActiveWorkerCount: number
    healthy: boolean
  }
  inputPreparation: {
    executionId: string | null
    status: string | null
    modelPolicyVersion: string | null
    expectedModelPolicyVersion: string
    policyMatches: boolean
    serviceRevision: string | null
    heartbeatAt: string | null
    stale: boolean
    staleSeconds: number | null
    targetCount: number
    sealedCount: number
    unresolvedCount: number
    archiveFailedCount: number
    conversionFailedCount: number
    conversionStillPending: number
    conversionCandidateAttachmentCount: number
    conversionSurfacesUpserted: number
    conversionJobsEnqueued: number
    conversionCacheHits: number
    conversionRegistrationSkipped: number
    conversionRegistrationWarnings: number
    budgetExhausted: boolean
    healthy: boolean
  }
  servingMonitor: {
    executionId: string | null
    verifiedAt: string | null
    stale: boolean
    staleSeconds: number | null
    expectedItems: number
    checkedItems: number
    freshItems: number
    failedReceipts: number
    staleReceipts: number
    healthy: boolean
  }
}

export interface DeepPipelineAxis {
  dimension: CriterionDimension
  label: string
  status: DeepAnalysisAxisStatus
  confidence: number
  comment: string | null
  evidenceRefs: Array<Record<string, unknown>>
  criterionSemanticHashes: string[]
}

export interface DeepPipelineNoticeItem {
  grantId: string
  source: string
  sourceId: string
  title: string
  agency: string | null
  url: string | null
  applyEnd: string | null
  dDay: number | null
  bucket: DeepPipelineBucket
  jobId: string | null
  jobStatus: string | null
  modelPolicyVersion: string | null
  currentPolicyVersion: string
  currentPolicyJobStatus: string | null
  activeReleaseId: string | null
  activeReleaseRevision: number | null
  requiresCurrentPolicyReanalysis: boolean
  runId: string | null
  runPublicId: string | null
  runStatus: string | null
  firstBlockingStage: DeepAnalysisStageKey | null
  sourceChanged: boolean
  attachmentCount: number
  archivedCount: number
  convertedCount: number
  blockedAttachmentCount: number
  inputChars: number | null
  model: string | null
  promptVersion: string | null
  attemptCount: number | null
  costUsd: number | null
  axisCounts: Record<DeepAnalysisAxisStatus, number>
  auditVerdict: string | null
  publicationStatus: string | null
  updatedAt: string
}

export interface DeepPipelineNoticesResult {
  generatedAt: string
  total: number
  items: DeepPipelineNoticeItem[]
}

export interface DeepPipelineStageReceipt {
  id: string
  stage: DeepAnalysisStageKey
  label: string
  status: DeepAnalysisStageStatus
  verifierVersion: string
  evidence: Record<string, unknown>
  evidenceSha256: string
  artifactKey: string | null
  attempt: number
  createdAt: string
}

export interface DeepPipelineAudit {
  id: string
  attempt: number
  model: string
  promptVersion: string
  verdict: string
  itemResults: Array<Record<string, unknown>>
  artifactKey: string
  artifactSha256: string
  startedAt: string
  completedAt: string
}

export interface DeepPipelineException {
  id: string
  exceptionKey: string
  eventType: string
  reasonCode: string
  actorType: string
  actor: string
  detail: Record<string, unknown>
  evidenceSha256: string
  createdAt: string
  current: boolean
}

export interface DeepPipelineAttachment {
  id: string
  filename: string
  sourceUri: string
  contentType: string | null
  bytes: number | null
  sha256: string | null
  storageKey: string | null
  conversionStatus: string | null
  markdownStorageKey: string | null
  markdownSha256: string | null
  converter: string | null
  conversionError: string | null
  updatedAt: string
}

export interface DeepPipelinePromotion {
  itemId: string
  releaseId: string
  releaseStatus: string
  itemStatus: string
  planSha256: string
  beforeSha256: string
  afterSha256: string | null
  appliedAt: string | null
  updatedAt: string
}

export interface DeepPipelineAdminAction {
  id: string
  requestId: string
  actorEmail: string
  action: DeepPipelineAction
  outcome: "succeeded" | "failed"
  exceptionKey: string | null
  detail: Record<string, unknown>
  error: string | null
  createdAt: string
}

export interface DeepPipelineAggregateSplitCase {
  id: string
  status: "pending_review" | "approved" | "processing" | "completed" | "failed"
  reasonCode: "oversized_aggregate_notice"
  sourceRevisionSha256: string
  inputChars: number
  inputCapChars: number
  costCapUsd: number
  chunkCount: number
  attachmentCount: number
  evidenceSha256: string
  approvedByEmail: string | null
  approvedAt: string | null
  attemptCount: number
  maxAttempts: number
  availableAt: string
  leasedAt: string | null
  leaseExpiresAt: string | null
  workerId: string | null
  processingStartedAt: string | null
  completedAt: string | null
  model: string | null
  promptVersion: string | null
  inputArtifactKey: string | null
  inputSha256: string | null
  manifestArtifactKey: string | null
  manifestSha256: string | null
  rawResponseArtifactKey: string | null
  rawResponseSha256: string | null
  segmentCount: number | null
  programCount: number | null
  externalCallsMade: number | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  materializationStatus: "not_ready" | "pending" | "processing" | "prepared" | "failed"
  materializationAttemptCount: number
  materializationMaxAttempts: number
  materializationAvailableAt: string
  materializationLeasedAt: string | null
  materializationLeaseExpiresAt: string | null
  materializationWorkerId: string | null
  preparedChildCount: number
  childrenPreparedAt: string | null
  materializationLastErrorCode: string | null
  materializationLastErrorMessage: string | null
  promotionStatus: "not_ready" | "pending" | "staged" | "enqueued" | "failed"
  stagedChildCount: number
  enqueuedChildCount: number
  childrenStagedAt: string | null
  childrenEnqueuedAt: string | null
  activeFeederBypassReason: string | null
  promotionLastErrorCode: string | null
  promotionLastErrorMessage: string | null
  exposureStatus: "not_ready" | "verifying" | "visible" | "rolled_back"
  exposureReleaseId: string | null
  exposedChildCount: number
  childrenVisibleAt: string | null
  servingVerifiedAt: string | null
  visibilityRolledBackAt: string | null
  exposureActor: string | null
  exposureLastErrorCode: string | null
  exposureLastErrorMessage: string | null
  children: DeepPipelineAggregateSplitChild[]
  createdAt: string
  updatedAt: string
}

export interface DeepPipelineAggregateSplitChild {
  id: string
  stableKey: string
  ordinal: number
  status: "pending" | "prepared" | "failed"
  source: string
  sourceId: string
  title: string
  agencyPrimary: string | null
  grantProjectionSha256: string
  manifestSha256: string
  sourceRevisionSha256: string
  rawPayloadSha256: string
  attachmentManifestSha256: string | null
  inputArtifactKey: string | null
  inputSha256: string | null
  inputChars: number | null
  preparedAt: string | null
  stagedGrantAt: string | null
  servingState: "visible" | "staged" | "suppressed" | null
  deepAnalysisJobId: string | null
  deepAnalysisJobStatus: string | null
  deepAnalysisEnqueuedAt: string | null
  activeFeederBypassReason: string | null
  deepAnalysisRunId: string | null
  deepAnalysisRunStatus: string | null
  passedStageCount: number
  latestStage: DeepAnalysisStageKey | null
  latestStageStatus: DeepAnalysisStageStatus | null
  analysisCompleteStatus: DeepAnalysisStageStatus | null
  aiAuditVerdict: "concur" | "disagree" | "unsure" | "failed" | null
  promotionReleaseId: string | null
  promotionReleaseStatus: string | null
  promotionItemStatus: string | null
  publicationCompleteStatus: DeepAnalysisStageStatus | null
  servingCompleteStatus: DeepAnalysisStageStatus | null
  analysisFreshStatus: DeepAnalysisStageStatus | null
  publicationFirstBlocker: {
    code: string
    stage: DeepAnalysisStageKey | null
    message: string
  } | null
  exposureFirstBlocker: {
    code: string
    stage: DeepAnalysisStageKey | null
    message: string
  } | null
  promotionLastErrorCode: string | null
  promotionLastErrorMessage: string | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface DeepPipelineNoticeDetail {
  notice: DeepPipelineNoticeItem
  sourceRevisionSha256: string | null
  attachmentManifestSha256: string | null
  inputSha256: string | null
  inputArtifactKey: string | null
  outputArtifactKey: string | null
  rawResponseArtifactKey: string | null
  errorCode: string | null
  errorMessage: string | null
  receipts: DeepPipelineStageReceipt[]
  axes: DeepPipelineAxis[]
  audits: DeepPipelineAudit[]
  exceptions: DeepPipelineException[]
  attachments: DeepPipelineAttachment[]
  promotions: DeepPipelinePromotion[]
  adminActions: DeepPipelineAdminAction[]
  aggregateSplitCase: DeepPipelineAggregateSplitCase | null
}

export const DEEP_PIPELINE_ACTIONS = [
  "requeue_job",
  "claim_exception",
  "release_exception",
  "approve_aggregate_split",
] as const

export type DeepPipelineAction = (typeof DEEP_PIPELINE_ACTIONS)[number]

export interface DeepPipelineActionRequest {
  requestId: string
  action: DeepPipelineAction
  grantId: string
  jobId?: string
  runId?: string
  exceptionKey?: string
  aggregateSplitCaseId?: string
}

export interface DeepPipelineActionResult {
  requestId: string
  action: DeepPipelineAction
  outcome: "succeeded"
  grantId: string
  jobId: string | null
  runId: string | null
  exceptionKey: string | null
  aggregateSplitCaseId: string | null
}

export function isDeepPipelineBucket(value: unknown): value is DeepPipelineBucket {
  return typeof value === "string" && DEEP_PIPELINE_BUCKETS.includes(value as DeepPipelineBucket)
}

export function isDeepPipelineAction(value: unknown): value is DeepPipelineAction {
  return typeof value === "string" && DEEP_PIPELINE_ACTIONS.includes(value as DeepPipelineAction)
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
