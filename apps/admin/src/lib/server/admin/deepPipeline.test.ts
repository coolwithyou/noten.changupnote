import assert from "node:assert/strict"

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

const action = parseDeepPipelineActionRequest({
  requestId: "11111111-1111-4111-8111-111111111111",
  action: "claim_exception",
  grantId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  exceptionKey: "audit:investment",
})
assert.equal(action.action, "claim_exception")
assert.equal(action.exceptionKey, "audit:investment")

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
  service_revision: "revision",
  last_error_code: null,
  metadata: {
    targetCount: 4,
    sealedCount: 3,
    unresolvedCount: 1,
    archiveFailedCount: 0,
    conversionFailedCount: 0,
    conversionStillPending: 1,
    budgetExhausted: false,
  },
  heartbeat_at: new Date("2026-07-25T03:00:00.000Z"),
  stale_seconds: 30,
}), {
  executionId: "cunote-deep-analysis-input-preparation-test",
  status: "idle",
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
  budgetExhausted: false,
  healthy: true,
})
assert.equal(buildInputPreparationSummary().healthy, false)
assert.equal(buildInputPreparationSummary({
  worker_id: "failed",
  status: "degraded",
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

assert.deepEqual(buildWorkerSummary({
  worker_id: "cunote-deep-analysis-test",
  current_job_id: null,
  status: "idle",
  service_revision: "revision",
  heartbeat_at: new Date("2026-07-25T03:00:00.000Z"),
  stale_seconds: 30,
  active_worker_count: 0,
  active_lease_count: 0,
  stale_active_worker_count: 0,
}), {
  workerId: "cunote-deep-analysis-test",
  currentJobId: null,
  status: "idle",
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
  service_revision: "revision",
  heartbeat_at: new Date(),
  stale_seconds: 30,
  active_worker_count: 1,
  active_lease_count: 1,
  stale_active_worker_count: 0,
}).healthy, true)
assert.equal(buildWorkerSummary({
  worker_id: "hidden-lease",
  current_job_id: null,
  status: "idle",
  service_revision: "revision",
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
  service_revision: "revision",
  heartbeat_at: new Date(),
  stale_seconds: 30,
  active_worker_count: 2,
  active_lease_count: 2,
  stale_active_worker_count: 0,
}).healthy, false)
assert.equal(buildWorkerSummary().healthy, false)

assert.throws(
  () => parseDeepPipelineActionRequest({
    requestId: "11111111-1111-4111-8111-111111111111",
    action: "mark_reviewed",
    grantId: "22222222-2222-4222-8222-222222222222",
  }),
  /허용되지 않은 관제 액션/,
)

console.log("deep pipeline contract tests: ok")
