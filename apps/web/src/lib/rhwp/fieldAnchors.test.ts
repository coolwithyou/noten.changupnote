import assert from "node:assert/strict";
import {
  buildChoiceCellReplacement,
  extractFieldOptions,
  parseChoiceCellOptions,
} from "@/lib/documents/fieldOptions";
import {
  resolveRhwpCellAtPoint,
  resolveRhwpFieldAnchors,
  resolveRhwpFieldAnchorsExact,
  type RhwpAnchorDocument,
} from "./fieldAnchors";
import { resolveStudioFieldBindings } from "./studioFieldBindings";

assert.deepEqual(
  extractFieldOptions("checkbox", "□ 예비창업자 □ 폐업 후 재창업자"),
  ["예비창업자", "폐업 후 재창업자"],
);
assert.deepEqual(
  extractFieldOptions("checkbox", "수신동의여부 동의( ) 미동의( )"),
  ["동의", "미동의"],
);
assert.deepEqual(extractFieldOptions("text", "□ 예 □ 아니오"), ["예", "아니오"]);
assert.deepEqual(
  parseChoiceCellOptions("□ 예비창업자 □ 폐업 후 재창업자").map(({ value, markerOffset }) => ({ value, markerOffset })),
  [{ value: "예비창업자", markerOffset: 0 }, { value: "폐업 후 재창업자", markerOffset: 8 }],
);
assert.equal(
  buildChoiceCellReplacement("□ 예비창업자 □ 폐업 후 재창업자", "폐업 후 재창업자"),
  "□ 예비창업자 ■ 폐업 후 재창업자",
);
assert.equal(
  buildChoiceCellReplacement("☑ 남 ☐ 여", "여"),
  "☐ 남 ☑ 여",
);
assert.throws(
  () => buildChoiceCellReplacement("□ 예비창업자 □ 폐업 후 재창업자", "학생"),
  /exact 선택지/u,
);

const label = "창업자 유형";
const options = ["예비창업자", "폐업 후 재창업자"];
const document: RhwpAnchorDocument = {
  pageCount: () => 2,
  getPageInfo: () => JSON.stringify({ width: 1_000, height: 1_000 }),
  searchAllText: (query) => {
    if (query === label) {
      return JSON.stringify([{
        sec: 0,
        length: label.length,
        charOffset: 0,
        cellContext: { parentPara: 2, ctrlIdx: 0, cellIdx: 12, cellPara: 0 },
      }]);
    }
    const index = options.indexOf(query);
    if (index >= 0) {
      return JSON.stringify([{
        sec: 0,
        length: query.length,
        charOffset: index === 0 ? 2 : 11,
        cellContext: { parentPara: 2, ctrlIdx: 0, cellIdx: 13, cellPara: 0 },
      }]);
    }
    return "[]";
  },
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 12, row: 4, col: 0, rowSpan: 1, colSpan: 1, pageIndex: 0, x: 100, y: 300, w: 200, h: 50 },
    { cellIdx: 13, row: 4, col: 1, rowSpan: 1, colSpan: 3, pageIndex: 0, x: 300, y: 300, w: 600, h: 50 },
  ]),
  getSelectionRectsInCell: (_sec, _para, _ctrl, _cell, _cellPara, start) => JSON.stringify([{
    pageIndex: 0,
    x: start < 10 ? 340 : 580,
    y: 315,
    width: start < 10 ? 100 : 180,
    height: 20,
  }]),
};

const [anchor] = resolveRhwpFieldAnchors(document, [{
  fieldId: "founder-type",
  label,
  fieldType: "checkbox",
  sourceSpan: "□ 예비창업자 □ 폐업 후 재창업자",
  position: { page: 1, bbox: [0.1, 0.29, 0.8, 0.07] },
  options,
}]);

assert.ok(anchor);
assert.equal(anchor.page, 1);
assert.deepEqual(anchor.box, { x: 0.3, y: 0.3, width: 0.6, height: 0.05 });
assert.deepEqual(anchor.target, {
  kind: "cell",
  section: 0,
  parentPara: 2,
  controlIndex: 0,
  cellIndex: 13,
  cellParagraph: 0,
  labelCellIndex: 12,
});
assert.deepEqual(anchor.choices.map((choice) => choice.value), options);
assert.equal(anchor.choices[0]?.box.x, 0.326);

const ambiguous: RhwpAnchorDocument = {
  ...document,
  searchAllText: (query) => query === "주소" ? JSON.stringify([
    { sec: 0, length: 2, cellContext: { parentPara: 2, ctrlIdx: 0, cellIdx: 0 } },
    { sec: 0, length: 2, cellContext: { parentPara: 3, ctrlIdx: 0, cellIdx: 0 } },
  ]) : "[]",
  getTableCellBboxes: (_sec, para) => JSON.stringify([
    { cellIdx: 0, row: 0, col: 0, pageIndex: para === 2 ? 0 : 1, x: 100, y: 100, w: 200, h: 50 },
    { cellIdx: 1, row: 0, col: 1, pageIndex: para === 2 ? 0 : 1, x: 300, y: 100, w: 600, h: 50 },
  ]),
};
assert.equal(resolveRhwpFieldAnchors(ambiguous, [{ fieldId: "address", label: "주소", fieldType: "text" }]).length, 0);
assert.deepEqual(
  resolveRhwpFieldAnchorsExact(ambiguous, [{ fieldId: "address", label: "주소", fieldType: "text" }]),
  [{ fieldId: "address", status: "ambiguous", candidateCount: 2 }],
);

const exactUnique = resolveRhwpFieldAnchorsExact(document, [{
  fieldId: "founder-type",
  label,
  fieldType: "checkbox",
  sourceSpan: "□ 예비창업자 □ 폐업 후 재창업자",
  position: { page: 1, bbox: [0.1, 0.29, 0.8, 0.07] },
  options,
}]);
assert.equal(exactUnique[0]?.status, "unique");
assert.equal(exactUnique[0]?.candidateCount, 1);
assert.deepEqual(resolveStudioFieldBindings(
  { ...document, getFieldList: () => "[]" },
  [{
    fieldId: "introduction",
    label,
    fieldType: "long_text",
    sourceSpan: "□ 예비창업자 □ 폐업 후 재창업자",
    position: { page: 1, bbox: [0.1, 0.29, 0.8, 0.07] },
    options,
  }],
), [{
  fieldId: "introduction",
  status: "unique",
  target: {
    kind: "table_cell_region",
    section: 0,
    parentPara: 2,
    controlIndex: 0,
    cellIndex: 13,
  },
  candidateCount: 1,
}]);
assert.deepEqual(
  resolveRhwpFieldAnchorsExact(document, [{ fieldId: "missing", label: "없는 라벨", fieldType: "text" }]),
  [{ fieldId: "missing", status: "missing", candidateCount: 0 }],
);

// 원문 셀의 시각적 자간 공백은 무시하고, 위치 힌트가 가리키는 페이지의 같은 라벨을 찾는다.
const spacedLabelDocument: RhwpAnchorDocument = {
  ...document,
  searchAllText: (query) => query === "성명(대표자)" ? JSON.stringify([{
    sec: 0,
    length: query.length,
    cellContext: { parentPara: 38, ctrlIdx: 0, cellIdx: 13, cellPara: 0 },
  }]) : "[]",
  getPageTextLayout: () => JSON.stringify({ runs: [{
    text: "성 명(대표자)",
    secIdx: 0,
    parentParaIdx: 3,
    controlIdx: 0,
    cellIdx: 1,
    cellParaIdx: 0,
    charStart: 0,
  }] }),
  getTableCellBboxes: (_sec, para) => para === 3 ? JSON.stringify([
    { cellIdx: 1, row: 0, col: 1, colSpan: 2, pageIndex: 0, x: 100, y: 380, w: 120, h: 28 },
    { cellIdx: 2, row: 0, col: 3, colSpan: 2, pageIndex: 0, x: 220, y: 380, w: 200, h: 28 },
  ]) : "[]",
};
const [spacedLabelAnchor] = resolveRhwpFieldAnchors(spacedLabelDocument, [{
  fieldId: "representative-name",
  label: "성명(대표자)",
  fieldType: "text",
  position: { page: 1, bbox: [0.22, 0.38, 0.2, 0.028] },
}]);
assert.equal(spacedLabelAnchor?.target.cellIndex, 2);
assert.equal(spacedLabelAnchor?.target.labelCellIndex, 1);
assert.deepEqual(spacedLabelAnchor?.box, { x: 0.22, y: 0.38, width: 0.2, height: 0.028 });

// 한 셀의 여러 문단에 나뉜 라벨도 셀 전체 문자열로 exact 비교한다.
const multilineLabelDocument: RhwpAnchorDocument = {
  ...document,
  pageCount: () => 1,
  searchAllText: () => "[]",
  getPageTextLayout: () => JSON.stringify({ runs: [
    { text: "창업 및", secIdx: 0, parentParaIdx: 9, controlIdx: 0, cellIdx: 8, cellParaIdx: 0, charStart: 0 },
    { text: "사업운영계획", secIdx: 0, parentParaIdx: 9, controlIdx: 0, cellIdx: 8, cellParaIdx: 1, charStart: 0 },
    { text: "요약", secIdx: 0, parentParaIdx: 9, controlIdx: 0, cellIdx: 8, cellParaIdx: 2, charStart: 0 },
  ] }),
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 8, row: 5, col: 0, pageIndex: 0, x: 100, y: 500, w: 220, h: 120 },
    { cellIdx: 9, row: 5, col: 1, pageIndex: 0, x: 320, y: 500, w: 580, h: 120 },
  ]),
};
const [multilineResolution] = resolveRhwpFieldAnchorsExact(multilineLabelDocument, [{
  fieldId: "business-plan-summary",
  label: "창업 및\n사업운영계획\n요약",
  fieldType: "long_text",
}]);
assert.equal(multilineResolution?.status, "unique");
assert.equal(multilineResolution?.status === "unique" ? multilineResolution.anchor.target.cellIndex : null, 9);

// 동일 라벨은 source SHA에 결속해 저장한 문서 순번으로만 exact tie-break한다.
const repeatedLabelDocument: RhwpAnchorDocument = {
  ...document,
  pageCount: () => 1,
  searchAllText: () => "[]",
  getPageTextLayout: () => JSON.stringify({ runs: [
    { text: "연락처", secIdx: 0, parentParaIdx: 3, controlIdx: 0, cellIdx: 10, cellParaIdx: 0, charStart: 0 },
    { text: "연락처", secIdx: 0, parentParaIdx: 3, controlIdx: 0, cellIdx: 12, cellParaIdx: 0, charStart: 0 },
  ] }),
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 10, row: 1, col: 0, pageIndex: 0, x: 100, y: 200, w: 150, h: 40 },
    { cellIdx: 11, row: 1, col: 1, pageIndex: 0, x: 250, y: 200, w: 250, h: 40 },
    { cellIdx: 12, row: 2, col: 0, pageIndex: 0, x: 100, y: 240, w: 150, h: 40 },
    { cellIdx: 13, row: 2, col: 1, pageIndex: 0, x: 250, y: 240, w: 250, h: 40 },
  ]),
};
const [repeatedResolution] = resolveRhwpFieldAnchorsExact(repeatedLabelDocument, [{
  fieldId: "second-phone",
  label: "두 번째 담당자 연락처",
  anchorLabel: "연락처",
  fieldType: "text",
  position: { occurrence: 1, normalizedLabel: "연락처" },
}]);
assert.equal(repeatedResolution?.status, "unique");
assert.equal(repeatedResolution?.status === "unique" ? repeatedResolution.anchor.target.cellIndex : null, 13);

// 오른쪽 셀이 없는 세로형 표는 같은 열 범위의 바로 아래 셀까지만 입력 대상으로 허용한다.
const stackedLabelDocument: RhwpAnchorDocument = {
  ...document,
  searchAllText: (query) => query === "창업 계획" ? JSON.stringify([{
    sec: 0,
    length: query.length,
    cellContext: { parentPara: 15, ctrlIdx: 0, cellIdx: 0, cellPara: 0 },
  }]) : "[]",
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 0, row: 0, col: 0, pageIndex: 0, x: 100, y: 100, w: 800, h: 40 },
    { cellIdx: 1, row: 1, col: 0, pageIndex: 0, x: 100, y: 140, w: 800, h: 160 },
  ]),
  getCellParagraphCount: () => 1,
  getCellParagraphLength: () => 0,
  getTextInCell: () => "",
};
const [stackedResolution] = resolveRhwpFieldAnchorsExact(stackedLabelDocument, [{
  fieldId: "startup-plan",
  label: "창업 계획",
  fieldType: "long_text",
}]);
assert.equal(stackedResolution?.status, "unique");
assert.equal(stackedResolution?.status === "unique" ? stackedResolution.anchor.target.cellIndex : null, 1);

// 좌표 없는 page-only 메타는 모든 필드를 1쪽으로 접는 KorDoc 값일 수 있어 탐색 범위를 제한하지 않는다.
const foldedPageDocument: RhwpAnchorDocument = {
  ...multilineLabelDocument,
  pageCount: () => 3,
  getPageTextLayout: (pageIndex) => pageIndex === 2
    ? multilineLabelDocument.getPageTextLayout!(0)
    : JSON.stringify({ runs: [] }),
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 8, row: 5, col: 0, pageIndex: 2, x: 100, y: 500, w: 220, h: 120 },
    { cellIdx: 9, row: 5, col: 1, pageIndex: 2, x: 320, y: 500, w: 580, h: 120 },
  ]),
};
const [foldedPageResolution] = resolveRhwpFieldAnchorsExact(foldedPageDocument, [{
  fieldId: "folded-page-summary",
  label: "창업 및 사업운영계획 요약",
  fieldType: "long_text",
  position: { page: 1, bbox: null },
}]);
assert.equal(foldedPageResolution?.status, "unique");
assert.equal(foldedPageResolution?.status === "unique" ? foldedPageResolution.anchor.page : null, 3);

// 값 셀 자체의 괄호형 안내는 인접 셀로 이동하지 않고 같은 셀에 결속한다.
const placeholderDocument: RhwpAnchorDocument = {
  ...document,
  searchAllText: (query) => query.includes("예정지") ? JSON.stringify([{
    sec: 0,
    length: query.length,
    cellContext: { parentPara: 2, ctrlIdx: 0, cellIdx: 12, cellPara: 0 },
  }]) : "[]",
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 12, row: 4, col: 1, pageIndex: 0, x: 250, y: 320, w: 650, h: 40 },
    { cellIdx: 13, row: 5, col: 1, pageIndex: 0, x: 250, y: 360, w: 650, h: 40 },
  ]),
};
const [placeholderResolution] = resolveRhwpFieldAnchorsExact(placeholderDocument, [{
  fieldId: "business-address",
  label: "(예정지)※해당시 주소 기재",
  fieldType: "text",
}]);
assert.equal(placeholderResolution?.status, "unique");
assert.equal(placeholderResolution?.status === "unique" ? placeholderResolution.anchor.target.cellIndex : null, 12);

// source-bound 장문 라벨이 한 행 전체 셀을 차지하면 시각적 입력 여백도 같은 셀이다.
// 바로 아래의 선언문/날짜/서명 셀로 이동하지 않고, 증명된 첫 문단을 보호한다.
const sameCellTextareaLabel = "※ 기타 현재 상황, 개선하고자 하는 점 등 자유롭게 기술해주세요.";
const sameCellTextareaDocument: RhwpAnchorDocument = {
  ...document,
  pageCount: () => 1,
  searchAllText: () => "[]",
  getPageTextLayout: () => JSON.stringify({ runs: [{
    text: sameCellTextareaLabel,
    secIdx: 0,
    parentParaIdx: 0,
    controlIdx: 3,
    cellIdx: 39,
    cellParaIdx: 0,
    charStart: 0,
  }] }),
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 39, row: 14, col: 0, colSpan: 9, pageIndex: 0, x: 100, y: 600, w: 800, h: 120 },
    { cellIdx: 40, row: 15, col: 0, colSpan: 9, pageIndex: 0, x: 100, y: 720, w: 800, h: 220 },
  ]),
  getCellParagraphCount: (_section, _parentPara, _controlIndex, cellIndex) => cellIndex === 39 ? 1 : 8,
  getCellParagraphLength: (_section, _parentPara, _controlIndex, cellIndex, paragraph) => (
    cellIndex === 39 && paragraph === 0 ? Array.from(sameCellTextareaLabel).length : 0
  ),
  getTextInCell: (_section, _parentPara, _controlIndex, cellIndex, paragraph) => (
    cellIndex === 39 && paragraph === 0 ? sameCellTextareaLabel : ""
  ),
  getCellCharPropertiesAt: () => JSON.stringify({ charShapeId: 23 }),
  getCellParaPropertiesAt: () => JSON.stringify({ paraShapeId: 2 }),
};
const sameCellTextareaField = {
  fieldId: "current-situation",
  label: sameCellTextareaLabel,
  fieldType: "long_text",
  position: {
    page: 1,
    bbox: null,
    row: 14,
    col: 0,
    occurrence: 0,
    normalizedLabel: "기타현재상황,개선하고자하는점등자유롭게기술해주세요",
    targetKind: "table_cell_region",
    targetRow: 14,
    targetCol: 0,
    protectedPrefixText: sameCellTextareaLabel,
  },
};
const [sameCellTextareaResolution] = resolveRhwpFieldAnchorsExact(
  sameCellTextareaDocument,
  [sameCellTextareaField],
);
assert.equal(sameCellTextareaResolution?.status, "unique");
assert.equal(
  sameCellTextareaResolution?.status === "unique"
    ? sameCellTextareaResolution.anchor.target.cellIndex
    : null,
  39,
);
assert.deepEqual(resolveStudioFieldBindings(
  { ...sameCellTextareaDocument, getFieldList: () => "[]" },
  [sameCellTextareaField],
), [{
  fieldId: "current-situation",
  status: "unique",
  target: {
    kind: "table_cell_region",
    section: 0,
    parentPara: 0,
    controlIndex: 3,
    cellIndex: 39,
    protectedPrefixChars: 37,
  },
  candidateCount: 1,
}]);

// 저장 후 셀 전체 텍스트가 라벨과 같지 않아도 첫 문단 exact prefix로 같은 cell39를 다시 찾는다.
const appliedTextareaValue = "검증 가능한 현재 상황과 개선 계획";
const appliedSameCellTextareaDocument: RhwpAnchorDocument = {
  ...sameCellTextareaDocument,
  searchAllText: (query) => query === sameCellTextareaLabel ? JSON.stringify([{
    sec: 0,
    length: 37,
    charOffset: 0,
    cellContext: { parentPara: 0, ctrlIdx: 3, cellIdx: 39, cellPara: 0 },
  }]) : "[]",
  getPageTextLayout: () => JSON.stringify({ runs: [
    {
      text: sameCellTextareaLabel,
      secIdx: 0,
      parentParaIdx: 0,
      controlIdx: 3,
      cellIdx: 39,
      cellParaIdx: 0,
      charStart: 0,
    },
    {
      text: appliedTextareaValue,
      secIdx: 0,
      parentParaIdx: 0,
      controlIdx: 3,
      cellIdx: 39,
      cellParaIdx: 1,
      charStart: 0,
    },
  ] }),
  getCellParagraphCount: () => 2,
  getCellParagraphLength: (_section, _parentPara, _controlIndex, _cellIndex, paragraph) => (
    paragraph === 0 ? 37 : Array.from(appliedTextareaValue).length
  ),
  getTextInCell: (_section, _parentPara, _controlIndex, _cellIndex, paragraph) => (
    paragraph === 0 ? sameCellTextareaLabel : appliedTextareaValue
  ),
};
assert.deepEqual(resolveStudioFieldBindings(
  { ...appliedSameCellTextareaDocument, getFieldList: () => "[]" },
  [sameCellTextareaField],
), [{
  fieldId: "current-situation",
  status: "unique",
  target: {
    kind: "table_cell_region",
    section: 0,
    parentPara: 0,
    controlIndex: 3,
    cellIndex: 39,
    protectedPrefixChars: 37,
  },
  candidateCount: 1,
}]);

const mixedPrefixTextareaDocument: RhwpAnchorDocument = {
  ...sameCellTextareaDocument,
  getCellCharPropertiesAt: (_section, _parentPara, _controlIndex, _cellIndex, _paragraph, offset) => (
    JSON.stringify({ charShapeId: offset === 36 ? 24 : 23 })
  ),
};
assert.deepEqual(resolveStudioFieldBindings(
  { ...mixedPrefixTextareaDocument, getFieldList: () => "[]" },
  [sameCellTextareaField],
), [{ fieldId: "current-situation", status: "missing", candidateCount: 0 }]);
assert.deepEqual(resolveStudioFieldBindings(
  { ...sameCellTextareaDocument, getFieldList: () => "[]" },
  [{
    ...sameCellTextareaField,
    position: { ...sameCellTextareaField.position, targetRow: 13 },
  }],
), [{ fieldId: "current-situation", status: "missing", candidateCount: 0 }]);

// v10처럼 same-cell 명시 계약이 없으면 8문단 선언/날짜/서명 셀을 아래 입력칸으로 쓰지 않는다.
const v10TextareaField = {
  ...sameCellTextareaField,
  position: {
    ...sameCellTextareaField.position,
    targetKind: undefined,
    targetRow: undefined,
    targetCol: undefined,
    protectedPrefixText: undefined,
  },
};
assert.deepEqual(resolveStudioFieldBindings(
  { ...sameCellTextareaDocument, getFieldList: () => "[]" },
  [v10TextareaField],
), [{ fieldId: "current-situation", status: "missing", candidateCount: 0 }]);

const separateLongTextLabel = "사업 추진 계획";
function separateLongTextDocument(direction: "right" | "below"): RhwpAnchorDocument {
  const labelCell = { cellIdx: 1, row: 0, col: 0, colSpan: direction === "right" ? 1 : 2, pageIndex: 0, x: 100, y: 100, w: direction === "right" ? 300 : 600, h: 80 };
  const valueCell = { cellIdx: 2, row: direction === "right" ? 0 : 1, col: direction === "right" ? 1 : 0, colSpan: direction === "right" ? 1 : 2, pageIndex: 0, x: direction === "right" ? 400 : 100, y: direction === "right" ? 100 : 180, w: direction === "right" ? 300 : 600, h: 120 };
  return {
    ...document,
    pageCount: () => 1,
    searchAllText: () => "[]",
    getPageTextLayout: () => JSON.stringify({ runs: [{
      text: separateLongTextLabel,
      secIdx: 0,
      parentParaIdx: 0,
      controlIdx: 0,
      cellIdx: 1,
      cellParaIdx: 0,
      charStart: 0,
    }] }),
    getTableCellBboxes: () => JSON.stringify([labelCell, valueCell]),
    getCellParagraphCount: () => 1,
    getCellParagraphLength: (_section, _parentPara, _controlIndex, cellIndex) => (
      cellIndex === 1 ? Array.from(separateLongTextLabel).length : 0
    ),
    getTextInCell: (_section, _parentPara, _controlIndex, cellIndex) => (
      cellIndex === 1 ? separateLongTextLabel : ""
    ),
    getCellCharPropertiesAt: () => JSON.stringify({ charShapeId: 7 }),
    getCellParaPropertiesAt: () => JSON.stringify({ paraShapeId: 9 }),
  };
}
const separateLongTextField = {
  fieldId: "business-plan",
  label: separateLongTextLabel,
  fieldType: "long_text",
  position: { row: 0, col: 0, occurrence: 0, normalizedLabel: "사업추진계획" },
};
for (const direction of ["right", "below"] as const) {
  assert.deepEqual(resolveStudioFieldBindings(
    { ...separateLongTextDocument(direction), getFieldList: () => "[]" },
    [separateLongTextField],
  ), [{
    fieldId: "business-plan",
    status: "unique",
    target: { kind: "table_cell_region", section: 0, parentPara: 0, controlIndex: 0, cellIndex: 2 },
    candidateCount: 1,
  }]);
}

// 실제 입력 셀의 파란 이탤릭 안내문과 셀 배경을 프리뷰 마스킹 정보로 전달한다.
const guideAppearanceDocument: RhwpAnchorDocument = {
  ...document,
  searchAllText: (query) => query === "연락전화번호" ? JSON.stringify([{
    sec: 0,
    length: query.length,
    cellContext: { parentPara: 3, ctrlIdx: 0, cellIdx: 7, cellPara: 0 },
  }]) : "[]",
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 7, row: 1, col: 5, pageIndex: 0, x: 410, y: 408, w: 99, h: 27.4 },
    { cellIdx: 8, row: 1, col: 6, pageIndex: 0, x: 509, y: 408, w: 196, h: 27.4 },
  ]),
  getCellParagraphLength: () => 15,
  getTextInCell: () => " 핸드폰번호 기재시 선택기입",
  getCellCharPropertiesAt: () => JSON.stringify({ fontSize: 900, italic: true, textColor: "#0000ff" }),
  getCellOwnProperties: () => JSON.stringify({ fillColor: "#ffffff" }),
};
const [guideAppearanceAnchor] = resolveRhwpFieldAnchors(guideAppearanceDocument, [{
  fieldId: "phone",
  label: "연락전화번호",
  fieldType: "text",
  position: { page: 1 },
}]);
assert.deepEqual(guideAppearanceAnchor?.appearance, {
  fillColor: "#ffffff",
  maskTemplateText: true,
});

const picked = resolveRhwpCellAtPoint({
  document: {
    getPageInfo: () => JSON.stringify({ width: 1_000, height: 1_000 }),
    getPageControlLayout: () => JSON.stringify({ controls: [{
      type: "table",
      secIdx: 0,
      paraIdx: 4,
      controlIdx: 1,
      cells: [{ cellIdx: 7, x: 300, y: 400, w: 500, h: 60 }],
    }] }),
  },
  field: { fieldId: "manual", label: "직접 지정", fieldType: "text" },
  pageIndex: 0,
  x: 450,
  y: 430,
});
assert.deepEqual(picked?.box, { x: 0.3, y: 0.4, width: 0.5, height: 0.06 });
assert.equal(picked?.target.cellIndex, 7);

console.log("rhwp field anchor tests passed");
