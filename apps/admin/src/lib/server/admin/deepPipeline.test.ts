import assert from "node:assert/strict"

import {
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

assert.throws(
  () => parseDeepPipelineActionRequest({
    requestId: "11111111-1111-4111-8111-111111111111",
    action: "mark_reviewed",
    grantId: "22222222-2222-4222-8222-222222222222",
  }),
  /허용되지 않은 관제 액션/,
)

console.log("deep pipeline contract tests: ok")
