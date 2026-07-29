import assert from "node:assert/strict"

import { DEEP_ANALYSIS_MODEL_POLICY_VERSION } from "@cunote/contracts"

import {
  buildInputPreparationSummary,
  buildServingMonitorSummary,
  buildWorkerSummary,
  parseDeepPipelineQuery,
} from "./deepPipeline"
import {
  parseDeepPipelineActionRequest,
} from "./deepPipelineActions"

const query = parseDeepPipelineQuery(new URLSearchParams({
  bucket: "blocked_or_failed",
  stage: "attachment_text_complete",
  q: "  HWP 공고  ",
  limit: "5000",
}))
assert.deepEqual(query, {
  bucket: "blocked_or_failed",
  stage: "attachment_text_complete",
  q: "HWP 공고",
  limit: 100,
})

const invalidQuery = parseDeepPipelineQuery(new URLSearchParams({
  bucket: "완료",
  stage: "manual_reviewed",
  limit: "-2",
}))
assert.deepEqual(invalidQuery, {
  bucket: null,
  stage: null,
  q: "",
  limit: 1,
})

const humanReviewQuery = parseDeepPipelineQuery(new URLSearchParams({
  bucket: "human_review_required",
}))
assert.equal(humanReviewQuery.bucket, "human_review_required")

const action = parseDeepPipelineActionRequest({
  requestId: "11111111-1111-4111-8111-111111111111",
  action: "claim_exception",
  grantId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  exceptionKey: "audit:investment",
})
assert.equal(action.action, "claim_exception")
assert.equal(action.exceptionKey, "audit:investment")

const aggregateSplitApproval = parseDeepPipelineActionRequest({
  requestId: "44444444-4444-4444-8444-444444444444",
  action: "approve_aggregate_split",
  grantId: "22222222-2222-4222-8222-222222222222",
  aggregateSplitCaseId: "55555555-5555-4555-8555-555555555555",
})
assert.equal(aggregateSplitApproval.action, "approve_aggregate_split")
assert.equal(
  aggregateSplitApproval.aggregateSplitCaseId,
  "55555555-5555-4555-8555-555555555555",
)

assert.deepEqual(buildServingMonitorSummary({
  execution_id: "cunote-deep-analysis-serving-monitor-test",
  verified_at: new Date("2026-07-25T02:35:19.000Z"),
  stale_seconds: 30,
  expected_items: 2,
  checked_items: 2,
  fresh_items: 2,
  failed_receipts: 0,
  stale_receipts: 0,
}), {
  executionId: "cunote-deep-analysis-serving-monitor-test",
  verifiedAt: "2026-07-25T02:35:19.000Z",
  stale: false,
  staleSeconds: 30,
  expectedItems: 2,
  checkedItems: 2,
  freshItems: 2,
  failedReceipts: 0,
  staleReceipts: 0,
  healthy: true,
})
assert.equal(buildServingMonitorSummary().healthy, false)
assert.equal(buildServingMonitorSummary({
  execution_id: "failed-monitor",
  verified_at: new Date(),
  stale_seconds: 30,
  expected_items: 2,
  checked_items: 2,
  fresh_items: 1,
  failed_receipts: 1,
  stale_receipts: 0,
}).healthy, false)
assert.deepEqual(buildInputPreparationSummary({
  worker_id: "cunote-deep-analysis-input-preparation-test",
  status: "idle",
  model_policy_version: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  service_revision: "revision",
  last_error_code: null,
  metadata: {
    targetCount: 4,
    sealedCount: 3,
    unresolvedCount: 1,
    archiveFailedCount: 0,
    conversionFailedCount: 0,
    conversionStillPending: 1,
    conversionCandidateAttachmentCount: 2,
    conversionSurfacesUpserted: 2,
    conversionJobsEnqueued: 1,
    conversionCacheHits: 1,
    conversionRegistrationSkipped: 0,
    conversionRegistrationWarnings: 0,
    budgetExhausted: false,
  },
  heartbeat_at: new Date("2026-07-25T03:00:00.000Z"),
  stale_seconds: 30,
}), {
  executionId: "cunote-deep-analysis-input-preparation-test",
  status: "idle",
  modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  expectedModelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  policyMatches: true,
  serviceRevision: "revision",
  heartbeatAt: "2026-07-25T03:00:00.000Z",
  stale: false,
  staleSeconds: 30,
  targetCount: 4,
  sealedCount: 3,
  unresolvedCount: 1,
  archiveFailedCount: 0,
  conversionFailedCount: 0,
  conversionStillPending: 1,
  conversionCandidateAttachmentCount: 2,
  conversionSurfacesUpserted: 2,
  conversionJobsEnqueued: 1,
  conversionCacheHits: 1,
  conversionRegistrationSkipped: 0,
  conversionRegistrationWarnings: 0,
  budgetExhausted: false,
  healthy: true,
})
assert.equal(buildInputPreparationSummary().healthy, false)
assert.equal(buildInputPreparationSummary({
  worker_id: "failed",
  status: "degraded",
  model_policy_version: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  service_revision: "revision",
  last_error_code: "input_preparation_failed",
  metadata: {
    archiveFailedCount: 1,
    conversionFailedCount: 0,
    budgetExhausted: false,
  },
  heartbeat_at: new Date(),
  stale_seconds: 30,
}).healthy, false)
assert.equal(buildInputPreparationSummary({
  worker_id: "registration-warning",
  status: "idle",
  model_policy_version: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  service_revision: "revision",
  last_error_code: null,
  metadata: {
    archiveFailedCount: 0,
    conversionFailedCount: 0,
    conversionRegistrationWarnings: 1,
    budgetExhausted: false,
  },
  heartbeat_at: new Date(),
  stale_seconds: 30,
}).healthy, false)
assert.equal(buildInputPreparationSummary({
  worker_id: "different-policy",
  status: "idle",
  model_policy_version: "deep-analysis-model-policy-v999",
  service_revision: "revision",
  last_error_code: null,
  metadata: {},
  heartbeat_at: new Date(),
  stale_seconds: 30,
}).policyMatches, false)

assert.deepEqual(buildWorkerSummary({
  worker_id: "cunote-deep-analysis-test",
  current_job_id: null,
  status: "idle",
  model_policy_version: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  service_revision: "revision",
  metadata: {
    executionMode: "observe_only",
    claimScope: "unconfigured",
    claimCohortCount: 0,
    claimCohortSha256: null,
  },
  heartbeat_at: new Date("2026-07-25T03:00:00.000Z"),
  stale_seconds: 30,
  active_worker_count: 0,
  active_lease_count: 0,
  stale_active_worker_count: 0,
}), {
  workerId: "cunote-deep-analysis-test",
  currentJobId: null,
  status: "idle",
  modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  expectedModelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  policyMatches: true,
  executionMode: "observe_only",
  claimScope: "unconfigured",
  claimCohortCount: 0,
  claimCohortSha256: null,
  serviceRevision: "revision",
  heartbeatAt: "2026-07-25T03:00:00.000Z",
  stale: false,
  staleSeconds: 30,
  activeWorkerCount: 0,
  activeLeaseCount: 0,
  staleActiveWorkerCount: 0,
  healthy: true,
})
assert.equal(buildWorkerSummary({
  worker_id: "running",
  current_job_id: "11111111-1111-4111-8111-111111111111",
  status: "running",
  model_policy_version: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  service_revision: "revision",
  metadata: {
    executionMode: "active",
    claimScope: "bounded",
    claimCohortCount: 20,
    claimCohortSha256: "a".repeat(64),
  },
  heartbeat_at: new Date(),
  stale_seconds: 30,
  active_worker_count: 1,
  active_lease_count: 1,
  stale_active_worker_count: 0,
}).healthy, true)
assert.equal(buildWorkerSummary({
  worker_id: "unsafe-active",
  current_job_id: null,
  status: "idle",
  model_policy_version: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  service_revision: "revision",
  metadata: { executionMode: "active", claimScope: "unconfigured" },
  heartbeat_at: new Date(),
  stale_seconds: 30,
  active_worker_count: 0,
  active_lease_count: 0,
  stale_active_worker_count: 0,
}).healthy, false)
assert.equal(buildWorkerSummary({
  worker_id: "hidden-lease",
  current_job_id: null,
  status: "idle",
  model_policy_version: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  service_revision: "revision",
  metadata: {},
  heartbeat_at: new Date(),
  stale_seconds: 30,
  active_worker_count: 0,
  active_lease_count: 1,
  stale_active_worker_count: 0,
}).healthy, false)
assert.equal(buildWorkerSummary({
  worker_id: "over-concurrent",
  current_job_id: "11111111-1111-4111-8111-111111111111",
  status: "running",
  model_policy_version: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  service_revision: "revision",
  metadata: { executionMode: "active" },
  heartbeat_at: new Date(),
  stale_seconds: 30,
  active_worker_count: 2,
  active_lease_count: 2,
  stale_active_worker_count: 0,
}).healthy, false)
assert.equal(buildWorkerSummary({
  worker_id: "different-policy",
  current_job_id: null,
  status: "idle",
  model_policy_version: "deep-analysis-model-policy-v999",
  service_revision: "revision",
  metadata: { executionMode: "observe_only", claimScope: "unconfigured" },
  heartbeat_at: new Date(),
  stale_seconds: 30,
  active_worker_count: 0,
  active_lease_count: 0,
  stale_active_worker_count: 0,
}).policyMatches, false)
assert.equal(buildWorkerSummary().healthy, false)

assert.throws(
  () => parseDeepPipelineActionRequest({
    requestId: "11111111-1111-4111-8111-111111111111",
    action: "mark_reviewed",
    grantId: "22222222-2222-4222-8222-222222222222",
  }),
  /허용되지 않은 관제 액션/,
)

assert.throws(
  () => parseDeepPipelineActionRequest({
    requestId: "11111111-1111-4111-8111-111111111111",
    action: "approve_aggregate_split",
    grantId: "22222222-2222-4222-8222-222222222222",
    aggregateSplitCaseId: "not-a-uuid",
  }),
  /aggregateSplitCaseId는 UUID/,
)

console.log("deep pipeline contract tests: ok")
