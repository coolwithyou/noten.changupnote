import assert from "node:assert/strict";
import type { VirtualCompanyTarget } from "./catalog";
import { verifyVirtualCompanyFlowBaseline } from "./verifyVirtualCompanyFlowBaseline";

const target = {
  source: "bizinfo",
  sourceId: "target",
  expectedExtractorVersion: "extractor",
  expectedRevision: "a".repeat(64),
  expected: "recommendable",
  expectedNextQuestionDimension: null,
  expectedWritingEntry: "available",
  expectedDocument: {
    documentKey: "application_form::신청서::::0",
    sourceSha256: "b".repeat(64),
  },
  expectedAuthoring: {
    documentCount: 2,
    connectedFieldCount: 6,
    seededAnswerCount: 0,
    manualQuestionCount: 6,
    pageCount: 4,
  },
} satisfies VirtualCompanyTarget;

const pass = verifyVirtualCompanyFlowBaseline({
  target,
  actual: {
    documentKey: target.expectedDocument.documentKey,
    sourceSha256: target.expectedDocument.sourceSha256,
    authoring: target.expectedAuthoring ?? null,
  },
});
assert.equal(pass.status, "pass");
assert.deepEqual(pass.issues, []);

const sourceChanged = verifyVirtualCompanyFlowBaseline({
  target,
  actual: {
    documentKey: target.expectedDocument.documentKey,
    sourceSha256: "c".repeat(64),
    authoring: { ...target.expectedAuthoring!, connectedFieldCount: 7 },
  },
});
assert.equal(sourceChanged.status, "needs_rebaseline");
assert.match(sourceChanged.issues[0] ?? "", /원본 SHA-256 변경/);
assert.ok(sourceChanged.issues.some((issue) => issue.includes("연결 필드 수 불일치")));

const authoringChanged = verifyVirtualCompanyFlowBaseline({
  target,
  actual: {
    documentKey: target.expectedDocument.documentKey,
    sourceSha256: target.expectedDocument.sourceSha256,
    authoring: { ...target.expectedAuthoring!, seededAnswerCount: 1, manualQuestionCount: 5 },
  },
});
assert.equal(authoringChanged.status, "product_regression");
assert.ok(authoringChanged.issues.some((issue) => issue.includes("자동 시드 수 불일치")));
assert.ok(authoringChanged.issues.some((issue) => issue.includes("수동 질문 수 불일치")));

const missingDocument = verifyVirtualCompanyFlowBaseline({
  target,
  actual: { documentKey: null, sourceSha256: null, authoring: null },
});
assert.equal(missingDocument.status, "needs_rebaseline");
assert.ok(missingDocument.issues.some((issue) => issue.includes("기준 문서 변경")));

console.log("verifyVirtualCompanyFlowBaseline.test.ts: all assertions passed");
