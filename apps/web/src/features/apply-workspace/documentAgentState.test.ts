import assert from "node:assert/strict";
import { initialDocumentAgentUiState, reduceDocumentAgentUiState } from "./documentAgentState";

const open = reduceDocumentAgentUiState(initialDocumentAgentUiState, { type: "open", pageCount: 3 });
const scanning = reduceDocumentAgentUiState(open, { type: "scan_started" });
const candidate = {
  schemaVersion: "document-agent-v1" as const,
  candidateId: "a".repeat(64),
  sourceKey: "draft:test",
  documentSha256: "b".repeat(64),
  reservedAnchorsSha256: "c".repeat(64),
  anchor: { kind: "body_paragraph" as const, section: 0, paragraph: 0, charOffset: 0 as const, length: 2 },
  location: { page: 1, label: "본문 1구역 1문단" },
  beforeText: "본문",
  beforeSha256: "d".repeat(64),
  formatSnapshot: { charProperties: {}, paragraphProperties: {}, style: {} },
  formatSha256: "e".repeat(64),
  adjacentContext: "",
  adjacentContextSha256: "f".repeat(64),
  studioCommandEvidence: { formatSha256: "1".repeat(64), adjacentContextSha256: "2".repeat(64) },
};
const targeted = reduceDocumentAgentUiState(scanning, { type: "scan_succeeded", candidates: [candidate] });
assert.equal(targeted.phase, "target_selected");
assert.equal(targeted.selectedCandidateId, candidate.candidateId);
const checkpointing = reduceDocumentAgentUiState(targeted, {
  type: "request_started",
  checkpointRequestId: "00000000-0000-4000-8000-000000000001",
  clientRequestId: "00000000-0000-4000-8000-000000000002",
});
assert.equal(checkpointing.phase, "checkpointing");
assert.throws(() => reduceDocumentAgentUiState(checkpointing, { type: "close" }), /진행 중/);
assert.throws(() => reduceDocumentAgentUiState(open, { type: "checkpoint_saved" }), /illegal transition/);

const history = reduceDocumentAgentUiState(open, {
  type: "history_loaded",
  run: {
    id: "00000000-0000-4000-8000-000000000003",
    clientRequestId: "00000000-0000-4000-8000-000000000004",
    status: "ready",
    statusVersion: 1,
    baseRevisionId: "00000000-0000-4000-8000-000000000005",
    documentSha256: candidate.documentSha256,
    selectedPage: 1,
    candidateId: candidate.candidateId,
    candidate,
    modelVersion: "test",
    promptVersion: "test",
    failureCode: null,
    createdAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    suggestions: [],
  },
});
assert.equal(history.phase, "reviewing");
assert.equal(history.selectedCandidateId, candidate.candidateId);

console.log("document agent UI state tests passed");
