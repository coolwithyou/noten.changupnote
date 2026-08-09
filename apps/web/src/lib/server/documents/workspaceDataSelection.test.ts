import assert from "node:assert/strict";
import { selectActiveWorkspaceDocumentKey } from "./workspaceData";

const syntheticFirst = {
  documentKey: "application_form::신청서::::0",
  sourceAttachment: null,
  surface: null,
};
const kordocReady = {
  documentKey: "business_plan::사업계획서::양식.hwp::1",
  sourceAttachment: "양식.hwp",
  surface: { pageCount: 0, extractionStatus: "fields_ready" },
};

assert.equal(
  selectActiveWorkspaceDocumentKey({ documents: [syntheticFirst, kordocReady] }),
  kordocReady.documentKey,
  "페이지 이미지가 없어도 Kordoc fields_ready 문서를 첨부 없는 합성 문서보다 먼저 연다",
);

assert.equal(
  selectActiveWorkspaceDocumentKey({
    documents: [syntheticFirst, kordocReady],
    requestedDocumentKey: syntheticFirst.documentKey,
  }),
  syntheticFirst.documentKey,
  "사용자가 명시한 문서 선택은 자동 우선순위보다 앞선다",
);

assert.equal(
  selectActiveWorkspaceDocumentKey({
    documents: [
      kordocReady,
      {
        documentKey: "application_form::페이지양식::양식2.hwp::2",
        sourceAttachment: "양식2.hwp",
        surface: { pageCount: 3, extractionStatus: "preview_ready" },
      },
    ],
  }),
  "application_form::페이지양식::양식2.hwp::2",
  "실제 페이지 프리뷰가 있는 문서는 fields_ready 무페이지 문서보다 먼저 연다",
);

assert.throws(
  () => selectActiveWorkspaceDocumentKey({ documents: [] }),
  /작성형 문서가 없는 workspace/,
);

console.log("workspace default document selection tests: ok");
