import assert from "node:assert/strict"

import {
  deriveManagementState,
  parsePipelineQuery,
  type ManagementStateInput,
} from "./noticePipelineGraph"

const healthyPublished: ManagementStateInput = {
  grantStatus: "open",
  pipelineStatus: "published",
  attachmentFailedCount: 0,
  attachmentUnresolvedCount: 0,
  surfaceFailedCount: 0,
  needsReviewCount: 0,
  extractionStatus: "labeled",
}

assert.equal(
  deriveManagementState({ ...healthyPublished, grantStatus: "closed" }),
  "closed",
  "closed notices remain outside the active triage states",
)
assert.equal(
  deriveManagementState({
    ...healthyPublished,
    pipelineStatus: "failed",
    needsReviewCount: 3,
  }),
  "failed",
  "pipeline failure wins over review state",
)
assert.equal(
  deriveManagementState({
    ...healthyPublished,
    attachmentFailedCount: 1,
  }),
  "failed",
  "attachment failure is a first-class failure",
)
assert.equal(
  deriveManagementState({
    ...healthyPublished,
    surfaceFailedCount: 1,
  }),
  "failed",
  "surface failure is a first-class failure",
)
assert.equal(
  deriveManagementState({
    ...healthyPublished,
    needsReviewCount: 2,
  }),
  "needs_admin",
  "criterion review wins before normal state",
)
assert.equal(
  deriveManagementState({
    ...healthyPublished,
    extractionStatus: "review",
  }),
  "needs_admin",
  "latest review history is visible to operators",
)
assert.equal(
  deriveManagementState({
    ...healthyPublished,
    pipelineStatus: "normalized",
    extractionStatus: null,
  }),
  "in_pipeline",
)
assert.equal(deriveManagementState(healthyPublished), "ok")
assert.equal(
  deriveManagementState({
    ...healthyPublished,
    extractionStatus: "auto",
  }),
  "auto_reviewable",
)
assert.equal(
  deriveManagementState({
    ...healthyPublished,
    attachmentUnresolvedCount: 1,
  }),
  "auto_reviewable",
  "unresolved attachment status must not be guessed as healthy",
)

assert.deepEqual(parsePipelineQuery(new URLSearchParams()), {
  lens: "review",
  source: null,
  bucket: "needs_admin",
  q: "",
  sort: "deadline",
  page: 1,
  includeClosed: false,
})

assert.deepEqual(
  parsePipelineQuery(new URLSearchParams({
    lens: "pipeline",
    source: "bizinfo",
    bucket: "normalized",
    q: "  수출바우처  ",
    sort: "review",
    page: "3",
    closed: "include",
  })),
  {
    lens: "pipeline",
    source: "bizinfo",
    bucket: "normalized",
    q: "수출바우처",
    sort: "review",
    page: 3,
    includeClosed: true,
  },
)

assert.equal(
  parsePipelineQuery(new URLSearchParams({
    lens: "deadline",
    bucket: "needs_admin",
  })).bucket,
  null,
  "a bucket from another lens is ignored",
)

assert.equal(
  parsePipelineQuery(new URLSearchParams({ page: "0" })).page,
  1,
  "page numbers start at one",
)
assert.equal(
  parsePipelineQuery(new URLSearchParams({ page: "not-a-number" })).page,
  1,
  "invalid page numbers fall back to the first page",
)

console.log("admin pipeline graph: 16 cases passed")
