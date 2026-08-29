import assert from "node:assert/strict";
import { loadDocumentAgentCore } from "@/lib/server/rhwp/documentAgentCore";
import type { RhwpDocument, RhwpDocumentFormat, RhwpModule } from "./client";
import type { RhwpFieldDescriptor } from "./fieldAnchors";
import {
  buildStudioParagraphFieldReplacement,
  resolveStudioParagraphFieldBindings,
} from "./studioParagraphFieldBindings";
import { resolveStudioFieldBindings } from "./studioFieldBindings";

const companyField: RhwpFieldDescriptor = {
  fieldId: "company-name",
  fieldKey: "company_name",
  label: "기업체명",
  fieldType: "text",
  position: {
    targetKind: "body_paragraph_text",
    paragraphPrefix: "가. 기업체명 :",
    paragraphSuffix: "",
    paragraphOccurrence: 0,
  },
};

const rhwp = await loadDocumentAgentCore();
for (const format of ["hwp", "hwpx"] as const) {
  const bytes = createFixture(rhwp, format);
  const document = new rhwp.HwpDocument(bytes);
  try {
    const [resolution] = resolveStudioFieldBindings(document, [companyField]);
    assert.deepEqual(resolution, {
      fieldId: companyField.fieldId,
      status: "unique",
      target: {
        kind: "body_paragraph_text",
        section: 0,
        paragraph: 1,
        length: "  가. 기업체명 :".length,
        valueStart: "  가. 기업체명 :".length,
        valueEnd: "  가. 기업체명 :".length,
      },
      candidateCount: 1,
    }, `${format} 본문 필드가 원문 prefix에 exact 결속되어야 합니다.`);
    assert.equal(resolution?.status, "unique");
    if (resolution?.status !== "unique") continue;
    assert.equal(resolution.target.kind, "body_paragraph_text");
    if (resolution.target.kind !== "body_paragraph_text") continue;
    assert.equal(
      buildStudioParagraphFieldReplacement("  가. 기업체명 :", resolution.target, "주식회사 노튼"),
      "  가. 기업체명 : 주식회사 노튼",
    );
  } finally {
    document.free();
  }
}

const paragraphs = ["가. 기업체명 : 첫 번째", "가. 기업체명 : 두 번째"];
const mock = {
  getSectionCount: () => 1,
  getParagraphCount: () => paragraphs.length,
  getParagraphLength: (_section: number, paragraph: number) => paragraphs[paragraph]!.length,
  getTextRange: (_section: number, paragraph: number, offset: number, count: number) =>
    paragraphs[paragraph]!.slice(offset, offset + count),
  getControlTextPositions: () => "[]",
  getFieldInfoAt: () => JSON.stringify({ inField: false }),
};
const [second] = resolveStudioParagraphFieldBindings(mock, [{
  ...companyField,
  fieldId: "second-company-name",
  position: {
    ...companyField.position,
    paragraphOccurrence: 1,
  },
}]);
assert.equal(second?.status, "unique");
if (second?.status === "unique") {
  assert.equal(second.target.paragraph, 1);
  assert.equal(second.target.valueStart, "가. 기업체명 :".length);
  assert.equal(second.target.valueEnd, paragraphs[1]!.length);
  assert.equal(
    buildStudioParagraphFieldReplacement(paragraphs[1]!, second.target, "변경 기업"),
    "가. 기업체명 : 변경 기업",
  );
}

const collisionDocument = {
  pageCount: () => 1,
  getPageInfo: () => JSON.stringify({ width: 1_000, height: 1_000 }),
  searchAllText: () => "[]",
  getTableCellBboxes: () => "[]",
  getFieldList: () => "[]",
  ...mock,
};
const collision = resolveStudioFieldBindings(collisionDocument, [
  companyField,
  { ...companyField, fieldId: "company-name-alias" },
]);
assert.deepEqual(collision, [
  { fieldId: "company-name", status: "ambiguous", candidateCount: 2 },
  { fieldId: "company-name-alias", status: "ambiguous", candidateCount: 2 },
]);

console.log("Studio paragraph field binding HWP/HWPX tests passed");

function createFixture(rhwpModule: RhwpModule, format: RhwpDocumentFormat): Uint8Array {
  const document = rhwpModule.HwpDocument.createEmpty();
  try {
    document.createBlankDocument();
    assertOk(document.insertText(0, 0, 0, "사업계획서"));
    appendParagraph(document, "  가. 기업체명 :");
    appendParagraph(document, "다. 대 표 자 :");
    appendParagraph(document, "카. 유동자산             원");
    return format === "hwp" ? document.exportHwp() : document.exportHwpx();
  } finally {
    document.free();
  }
}

function appendParagraph(document: RhwpDocument, text: string): void {
  const current = document.getParagraphCount(0) - 1;
  assertOk(document.splitParagraph(0, current, document.getParagraphLength(0, current)));
  assertOk(document.insertText(0, current + 1, 0, text));
}

function assertOk(value: string): void {
  assert.equal((JSON.parse(value) as { ok?: boolean }).ok, true);
}
