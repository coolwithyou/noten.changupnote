import assert from "node:assert/strict";
import type { DocumentEditCandidate } from "@/lib/rhwp/documentAgentContract";
import type { DocumentAgentGroundingSource } from "./documentAgentGrounding";
import { verifyModelSuggestions } from "./documentAgentPrompt";

const candidate: DocumentEditCandidate = {
  schemaVersion: "document-agent-v1",
  candidateId: "a".repeat(64),
  sourceKey: "draft:test",
  documentSha256: "b".repeat(64),
  reservedAnchorsSha256: "c".repeat(64),
  anchor: { kind: "body_paragraph", section: 0, paragraph: 1, charOffset: 0, length: 15 },
  location: { page: 1, label: "본문 1구역 2문단" },
  beforeText: "친환경 포장재를 개발합니다.",
  beforeSha256: "d".repeat(64),
  formatSnapshot: { charProperties: {}, paragraphProperties: {}, style: {} },
  formatSha256: "e".repeat(64),
  adjacentContext: "제품 소개\n---\n사업 목표",
  adjacentContextSha256: "f".repeat(64),
  studioCommandEvidence: {
    formatSha256: "1".repeat(64),
    adjacentContextSha256: "2".repeat(64),
  },
};

const sources: DocumentAgentGroundingSource[] = [{
  sourceId: "grant_announcement:0:source",
  kind: "announcement",
  title: "공고문",
  content: "친환경 소재 기반 제품의 사업화를 지원합니다.",
  sha256: "3".repeat(64),
  provenance: {},
}];

const accepted = verifyModelSuggestions({
  candidate,
  sources,
  suggestions: [{
    candidateId: candidate.candidateId,
    replacement: "친환경 포장재의 사업화를 추진합니다.",
    rationale: "공고 목적에 맞게 명료화",
    evidenceRefs: [{ sourceId: sources[0]!.sourceId, quote: "친환경 소재 기반 제품의 사업화" }],
  }],
});
assert.equal(accepted.length, 1);
assert.equal(accepted[0]!.evidence[0]!.sourceId, sources[0]!.sourceId);

assert.deepEqual(verifyModelSuggestions({
  candidate,
  sources,
  suggestions: [{
    candidateId: candidate.candidateId,
    replacement: "친환경 포장재의 사업화를 추진합니다.",
    rationale: "근거 위조",
    evidenceRefs: [{ sourceId: sources[0]!.sourceId, quote: "원문에 없는 문장" }],
  }],
}), []);

assert.deepEqual(verifyModelSuggestions({
  candidate,
  sources,
  suggestions: [{
    candidateId: "9".repeat(64),
    replacement: "친환경 포장재의 사업화를 추진합니다.",
    rationale: "다른 target",
    evidenceRefs: [{ sourceId: sources[0]!.sourceId, quote: "친환경 소재" }],
  }],
}), []);

assert.deepEqual(verifyModelSuggestions({
  candidate,
  sources: [{
    sourceId: `current_document:${candidate.candidateId}`,
    kind: "current_document",
    title: "현재 문서",
    content: candidate.beforeText,
    sha256: "4".repeat(64),
    provenance: {},
  }],
  suggestions: [{
    candidateId: candidate.candidateId,
    replacement: "2027년에 ISO9001 인증을 취득합니다.",
    rationale: "근거 없는 구체 사실",
    evidenceRefs: [{ sourceId: `current_document:${candidate.candidateId}`, quote: "친환경 포장재" }],
  }],
}), []);

console.log("document agent prompt verification tests passed");
