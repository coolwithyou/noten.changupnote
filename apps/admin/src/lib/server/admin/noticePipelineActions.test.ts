import assert from "node:assert/strict"

import {
  parsePipelineActionRequest,
  PipelineActionError,
} from "./noticePipelineActions"

const requestId = "018f5f16-7f4d-7c0a-8b6f-2e07b42a7c11"
const attachmentId = "018f5f16-7f4d-7c0a-8b6f-2e07b42a7c12"

assert.deepEqual(
  parsePipelineActionRequest({
    requestId,
    action: "mark_reviewed",
    targets: [
      { source: "bizinfo", sourceId: "PBLN-1" },
      { source: "bizinfo", sourceId: "PBLN-1" },
    ],
  }),
  {
    requestId,
    action: "mark_reviewed",
    targets: [{ source: "bizinfo", sourceId: "PBLN-1" }],
  },
)

assert.deepEqual(
  parsePipelineActionRequest({
    requestId,
    action: "reconvert",
    targets: [{
      source: "kstartup",
      sourceId: "KS-1",
      attachmentIds: [attachmentId, attachmentId],
    }],
  }),
  {
    requestId,
    action: "reconvert",
    targets: [{
      source: "kstartup",
      sourceId: "KS-1",
      attachmentIds: [attachmentId],
    }],
  },
)

assertPipelineActionError(
  () => parsePipelineActionRequest({
    requestId,
    action: "reextract",
    targets: [{ source: "bizinfo", sourceId: "PBLN-1" }],
  }),
  "invalid_pipeline_action",
)
assertPipelineActionError(
  () => parsePipelineActionRequest({
    requestId: "not-a-uuid",
    action: "mark_reviewed",
    targets: [{ source: "bizinfo", sourceId: "PBLN-1" }],
  }),
  "invalid_pipeline_request_id",
)
assertPipelineActionError(
  () => parsePipelineActionRequest({
    requestId,
    action: "reconvert",
    targets: [{
      source: "bizinfo",
      sourceId: "PBLN-1",
      attachmentIds: ["not-a-uuid"],
    }],
  }),
  "invalid_pipeline_attachment_ids",
)
assertPipelineActionError(
  () => parsePipelineActionRequest({
    requestId,
    action: "mark_reviewed",
    targets: Array.from({ length: 51 }, (_, index) => ({
      source: "bizinfo",
      sourceId: `PBLN-${index}`,
    })),
  }),
  "invalid_pipeline_targets",
)

console.log("admin pipeline actions: 6 cases passed")

function assertPipelineActionError(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => (
    error instanceof PipelineActionError && error.code === code
  ))
}
