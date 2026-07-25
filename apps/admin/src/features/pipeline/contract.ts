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

export const AXIS_LABELS: Record<CriterionDimension, string> = {
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
  activeTotal: number
  classifiedTotal: number
  degraded: boolean
  buckets: DeepPipelineBucketSummary[]
  stages: DeepPipelineStageSummary[]
  worker: {
    workerId: string | null
    currentJobId: string | null
    status: string | null
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
}

export const DEEP_PIPELINE_ACTIONS = [
  "requeue_job",
  "claim_exception",
  "release_exception",
] as const

export type DeepPipelineAction = (typeof DEEP_PIPELINE_ACTIONS)[number]

export interface DeepPipelineActionRequest {
  requestId: string
  action: DeepPipelineAction
  grantId: string
  jobId?: string
  runId?: string
  exceptionKey?: string
}

export interface DeepPipelineActionResult {
  requestId: string
  action: DeepPipelineAction
  outcome: "succeeded"
  grantId: string
  jobId: string | null
  runId: string | null
  exceptionKey: string | null
}

export function isDeepPipelineBucket(value: unknown): value is DeepPipelineBucket {
  return typeof value === "string" && DEEP_PIPELINE_BUCKETS.includes(value as DeepPipelineBucket)
}

export function isDeepPipelineAction(value: unknown): value is DeepPipelineAction {
  return typeof value === "string" && DEEP_PIPELINE_ACTIONS.includes(value as DeepPipelineAction)
}
