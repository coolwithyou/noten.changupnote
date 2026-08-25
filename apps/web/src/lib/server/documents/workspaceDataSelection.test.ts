import assert from "node:assert/strict";
import { classifyWorkspace, selectActiveWorkspaceDocumentKey } from "./workspaceData";

const syntheticFirst = {
  documentKey: "application_form::신청서::::0",
  sourceAttachment: null,
  surface: null,
};
const hwpReady = {
  documentKey: "business_plan::사업계획서::양식.hwp::1",
  sourceAttachment: "양식.hwp",
  surface: { pageCount: 0, extractionStatus: "fields_ready" },
};

assert.equal(
  selectActiveWorkspaceDocumentKey({ documents: [syntheticFirst, hwpReady] }),
  hwpReady.documentKey,
  "페이지 이미지가 없어도 HWP/HWPX 원본 문서를 첨부 없는 합성 문서보다 먼저 연다",
);

assert.equal(
  selectActiveWorkspaceDocumentKey({
    documents: [syntheticFirst, hwpReady],
    requestedDocumentKey: syntheticFirst.documentKey,
  }),
  syntheticFirst.documentKey,
  "사용자가 명시한 문서 선택은 자동 우선순위보다 앞선다",
);

assert.equal(
  selectActiveWorkspaceDocumentKey({
    documents: [
      hwpReady,
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

const baseSurface = {
  type: "file_template" as const,
  format: "hwp",
  extractionStatus: "preview_ready" as const,
  extractionVersion: null,
  confidence: null,
  pageCount: 0,
};

assert.deepEqual(classifyWorkspace({
  document: { sourceAttachment: "양식.hwp", hwpxTemplateAvailable: false },
  surface: baseSurface,
  connectedFieldsCount: 0,
  fieldMapNeedsRefresh: false,
}), { ladder: "b", honestNotice: null }, "필드 선분석 없이도 HWP 원본은 RHWP 직접 편집으로 연다");

assert.equal(classifyWorkspace({
  document: { sourceAttachment: "양식.hwp", hwpxTemplateAvailable: false },
  surface: null,
  connectedFieldsCount: 0,
  fieldMapNeedsRefresh: false,
}).ladder, "b", "surface가 없어도 보관 HWP 원본은 RHWP 직접 편집으로 연다");

assert.equal(classifyWorkspace({
  document: { sourceAttachment: "양식.hwpx", hwpxTemplateAvailable: true },
  surface: { ...baseSurface, format: "hwpx", extractionStatus: "failed" },
  connectedFieldsCount: 0,
  fieldMapNeedsRefresh: false,
}).ladder, "b", "프리뷰 변환 실패는 RHWP 원본 편집을 차단하지 않는다");

assert.equal(classifyWorkspace({
  document: { sourceAttachment: "양식.hwp", hwpxTemplateAvailable: false },
  surface: { ...baseSurface, extractionStatus: "fields_ready", confidence: 1 },
  connectedFieldsCount: 3,
  fieldMapNeedsRefresh: false,
}).ladder, "a", "현재 원본에 결속된 legacy 필드 연결은 field-aware 호환 화면을 유지한다");

assert.equal(classifyWorkspace({
  document: { sourceAttachment: "양식.pdf", hwpxTemplateAvailable: false },
  surface: { ...baseSurface, format: "pdf", pageCount: 2 },
  connectedFieldsCount: 0,
  fieldMapNeedsRefresh: false,
}).ladder, "c", "RHWP 비지원 형식은 채팅 폴백을 유지한다");

console.log("workspace default document selection tests: ok");
