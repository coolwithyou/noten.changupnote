import assert from "node:assert/strict";
import { isDocumentAgentSensitiveText, isManualLabel, MANUAL_LABEL_KEYWORDS } from "@/lib/documents/manualFieldPolicy";
import {
  DOCUMENT_AGENT_SCHEMA_VERSION,
  assertDocumentEditCandidateIntegrity,
  assertSafeReplacement,
  canonicalSha256,
  canonicalJson,
  decodeDocumentEditCandidate,
  documentEditCandidateId,
  sha256Hex,
  studioDocumentAgentFormatSha256,
} from "./documentAgentContract";

assert.equal(MANUAL_LABEL_KEYWORDS.length, 17);
assert.equal(isManualLabel("대표자 ( 서명 )"), true);
assert.equal(isManualLabel("사업 개요"), false);
assert.equal(isDocumentAgentSensitiveText("900101-1234567"), true);
assert.equal(isDocumentAgentSensitiveText("M12345678"), true);
assert.equal(isDocumentAgentSensitiveText("11-22-333333-44"), true);
assert.equal(isDocumentAgentSensitiveText("시장 진입 전략"), false);

assert.equal(canonicalJson({ z: -0, a: [2, { y: true, x: "가" }] }), '{"a":[2,{"x":"가","y":true}],"z":0}');
assert.throws(() => canonicalJson({ invalid: Number.NaN }), /유한한 숫자/);
assert.throws(() => canonicalJson({ invalid: undefined }), /JSON 값/);
assert.doesNotThrow(() => assertSafeReplacement("한 문단 치환문"));
assert.throws(() => assertSafeReplacement("두 문단\n치환문"), /문단 경계/);
assert.throws(() => assertSafeReplacement("\u0000"), /제어 문자/);

const documentSha256 = await sha256Hex("document");
const reservedAnchorsSha256 = await sha256Hex("reserved");
const beforeSha256 = await sha256Hex("변경 전");
const formatSnapshot = {
  charProperties: { charShapeId: 0 },
  paragraphProperties: { paraShapeId: 0 },
  style: { id: 0 },
};
const adjacentContext = "\n---\n";
const formatSha256 = await canonicalSha256(formatSnapshot);
const adjacentContextSha256 = await sha256Hex(adjacentContext);
const studioCommandEvidence = {
  formatSha256: await studioDocumentAgentFormatSha256(formatSnapshot),
  adjacentContextSha256: await sha256Hex(JSON.stringify({ schemaVersion: 1, previous: null, next: null })),
};
const identity = {
  schemaVersion: DOCUMENT_AGENT_SCHEMA_VERSION,
  sourceKey: "draft:test",
  documentSha256,
  reservedAnchorsSha256,
  anchor: { kind: "body_paragraph" as const, section: 0, paragraph: 0, charOffset: 0 as const, length: 4 },
  beforeSha256,
  formatSha256,
  adjacentContextSha256,
  studioCommandEvidence,
};
const candidate = {
  ...identity,
  candidateId: await documentEditCandidateId(identity),
  location: { page: 1, label: "본문 1구역 1문단" },
  beforeText: "변경 전",
  formatSnapshot,
  adjacentContext,
};
assert.deepEqual(decodeDocumentEditCandidate(candidate), candidate);
await assertDocumentEditCandidateIntegrity(candidate);
await assert.rejects(
  assertDocumentEditCandidateIntegrity({
    ...candidate,
    formatSnapshot: { ...candidate.formatSnapshot, charProperties: { charShapeId: 99 } },
  }),
  /content hash/u,
);
assert.throws(
  () => decodeDocumentEditCandidate({ ...candidate, forged: true }),
  /unrecognized_keys|Unrecognized key/u,
);

console.log("document agent contract tests passed");
