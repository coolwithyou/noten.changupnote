import assert from "node:assert/strict";
import { applyRhwpEditFields, buildRhwpEditFields, type RhwpEditableDocument } from "./editPlan";

const plan = buildRhwpEditFields({
  answers: {
    기업명: { value: "큐노트", status: "accepted", source: "profile", updatedAt: "now" },
    사업개요: { value: "설명", status: "edited", source: "user", updatedAt: "now" },
    대표자: { value: "홍길동", status: "suggested", source: "profile", updatedAt: "now" },
    연락처: { value: "010", status: "accepted", source: "profile", updatedAt: "now" },
  },
  duplicateLabels: new Set(["연락처"]),
});
assert.deepEqual(plan.fields.map((field) => field.label), ["기업명", "사업개요"]);
assert.equal(plan.skipped[0]?.label, "연락처");

let inserted: unknown[] | null = null;
const document: RhwpEditableDocument = {
  searchAllText: () => JSON.stringify([{
    sec: 0,
    length: 3,
    cellContext: { parentPara: 2, ctrlIdx: 1, cellIdx: 0 },
  }]),
  getCellInfo: (_section: number, _para: number, _control: number, cell: number) => JSON.stringify({ row: 0, col: cell }),
  getCellParagraphLength: () => 0,
  insertTextInCell: (...args: unknown[]) => {
    inserted = args;
    return JSON.stringify({ ok: true });
  },
};
const applied = applyRhwpEditFields(document, [{ label: "기업명", value: "큐노트" }]);
assert.deepEqual(applied.filled, [{ label: "기업명", value: "큐노트" }]);
assert.deepEqual(inserted, [0, 2, 1, 1, 0, 0, "큐노트"]);

let ambiguousInsert = false;
const ambiguous: RhwpEditableDocument = {
  searchAllText: () => JSON.stringify([
    { sec: 0, length: 3, cellContext: { parentPara: 2, ctrlIdx: 1, cellIdx: 0 } },
    { sec: 0, length: 3, cellContext: { parentPara: 3, ctrlIdx: 1, cellIdx: 0 } },
  ]),
  getCellInfo: () => JSON.stringify({ row: 0 }),
  getCellParagraphLength: () => 0,
  insertTextInCell: () => {
    ambiguousInsert = true;
    return JSON.stringify({ ok: true });
  },
};
const ambiguousResult = applyRhwpEditFields(ambiguous, [{ label: "기업명", value: "큐노트" }]);
assert.equal(ambiguousResult.filled.length, 0);
assert.match(ambiguousResult.skipped[0]?.reason ?? "", /여러 곳/);
assert.equal(ambiguousInsert, false);

let namedValue = "";
const namedFieldDocument: RhwpEditableDocument = {
  getFieldList: () => JSON.stringify([{ name: "사업 개요", value: "작성 예시", guide: "작성 예시" }]),
  setFieldValueByName: (_name, value) => {
    namedValue = value;
    return JSON.stringify({ ok: true });
  },
  searchAllText: () => "[]",
  getCellInfo: () => "{}",
  getCellParagraphLength: () => 0,
  insertTextInCell: () => JSON.stringify({ ok: false }),
};
const namedResult = applyRhwpEditFields(namedFieldDocument, [{ label: "사업 개요", value: "완성 문장" }]);
assert.deepEqual(namedResult.filled, [{ label: "사업 개요", value: "완성 문장" }]);
assert.equal(namedValue, "완성 문장");

// 구조 앵커와 같은 입력 셀을 사용하고, 단위 텍스트는 보존한 채 앞에 값을 넣는다.
let unitInsert: unknown[] | null = null;
const unitDocument: RhwpEditableDocument = {
  pageCount: () => 1,
  getPageInfo: () => JSON.stringify({ width: 1_000, height: 1_000 }),
  searchAllText: (query) => query === "매출액" ? JSON.stringify([{
    sec: 0,
    length: 3,
    cellContext: { parentPara: 2, ctrlIdx: 0, cellIdx: 0, cellPara: 0 },
  }]) : "[]",
  getTableCellBboxes: () => JSON.stringify([
    { cellIdx: 0, row: 0, col: 0, pageIndex: 0, x: 100, y: 100, w: 200, h: 50 },
    { cellIdx: 1, row: 0, col: 1, pageIndex: 0, x: 300, y: 100, w: 600, h: 50 },
  ]),
  getCellInfo: () => JSON.stringify({ row: 0 }),
  getCellParagraphLength: () => 4,
  getTextInCell: () => "(천원)",
  insertTextInCell: (...args: unknown[]) => {
    unitInsert = args;
    return JSON.stringify({ ok: true });
  },
};
const unitResult = applyRhwpEditFields(unitDocument, [{
  fieldId: "revenue",
  label: "매출액",
  value: "320000",
  fieldType: "text",
  position: { page: 1 },
}]);
assert.deepEqual(unitResult.filled, [{ label: "매출액", value: "320000" }]);
assert.deepEqual(unitInsert, [0, 2, 0, 1, 0, 0, "320000"]);

// source span으로 확인된 안내문만 삭제 후 교체한다.
const guideOperations: Array<{ kind: string; offset: number; value: number | string }> = [];
const guideText = "※해당시 주소 기재";
const guideDocument: RhwpEditableDocument = {
  ...unitDocument,
  searchAllText: (query) => query === "사업장 주소" ? JSON.stringify([{
    sec: 0,
    length: 6,
    cellContext: { parentPara: 2, ctrlIdx: 0, cellIdx: 0, cellPara: 0 },
  }]) : "[]",
  getCellParagraphLength: () => guideText.length,
  getTextInCell: () => guideText,
  deleteTextInCell: (_sec, _para, _ctrl, _cell, _cellPara, offset, count) => {
    guideOperations.push({ kind: "delete", offset, value: count });
    return JSON.stringify({ ok: true });
  },
  insertTextInCell: (_sec, _para, _ctrl, _cell, _cellPara, offset, value) => {
    guideOperations.push({ kind: "insert", offset, value });
    return JSON.stringify({ ok: true });
  },
};
const guideResult = applyRhwpEditFields(guideDocument, [{
  fieldId: "address",
  label: "사업장 주소",
  value: "강원특별자치도 철원군",
  fieldType: "text",
  sourceSpan: guideText,
  position: { page: 1 },
}]);
assert.equal(guideResult.filled.length, 1);
assert.deepEqual(guideOperations, [
  { kind: "delete", offset: 0, value: guideText.length },
  { kind: "insert", offset: 0, value: "강원특별자치도 철원군" },
]);

// 체크박스는 선택지 텍스트 앞의 glyph만 바꾸고 일반 텍스트로 값을 삽입하지 않는다.
let checkboxText = "□ 예비창업자 □ 폐업 후 재창업자";
const checkboxDocument: RhwpEditableDocument = {
  ...unitDocument,
  searchAllText: (query) => {
    if (query === "창업자 유형") return JSON.stringify([{
      sec: 0,
      length: query.length,
      cellContext: { parentPara: 2, ctrlIdx: 0, cellIdx: 0, cellPara: 0 },
    }]);
    const offset = checkboxText.indexOf(query);
    return offset >= 0 ? JSON.stringify([{
      sec: 0,
      length: query.length,
      charOffset: offset,
      cellContext: { parentPara: 2, ctrlIdx: 0, cellIdx: 1, cellPara: 0 },
    }]) : "[]";
  },
  getCellParagraphLength: () => checkboxText.length,
  getTextInCell: () => checkboxText,
  deleteTextInCell: (_sec, _para, _ctrl, _cell, _cellPara, offset, count) => {
    checkboxText = checkboxText.slice(0, offset) + checkboxText.slice(offset + count);
    return JSON.stringify({ ok: true });
  },
  insertTextInCell: (_sec, _para, _ctrl, _cell, _cellPara, offset, value) => {
    checkboxText = checkboxText.slice(0, offset) + value + checkboxText.slice(offset);
    return JSON.stringify({ ok: true });
  },
};
const checkboxResult = applyRhwpEditFields(checkboxDocument, [{
  fieldId: "founder-type",
  label: "창업자 유형",
  value: "폐업 후 재창업자",
  fieldType: "checkbox",
  options: ["예비창업자", "폐업 후 재창업자"],
  position: { page: 1 },
}]);
assert.equal(checkboxResult.filled.length, 1);
assert.equal(checkboxText, "□ 예비창업자 ■ 폐업 후 재창업자");

let manualTargetCell = -1;
const manualResult = applyRhwpEditFields({
  searchAllText: () => "[]",
  getCellInfo: () => "{}",
  getCellParagraphLength: () => 0,
  insertTextInCell: (_sec, _para, _ctrl, cell) => {
    manualTargetCell = cell;
    return JSON.stringify({ ok: true });
  },
}, [{ fieldId: "unresolved", label: "자동 탐색 불가", value: "직접 지정 값" }], [{
  fieldId: "unresolved",
  label: "자동 탐색 불가",
  page: 1,
  box: { x: 0.3, y: 0.4, width: 0.5, height: 0.06 },
  source: "rhwp_table_cell",
  confidence: "exact",
  target: { kind: "cell", section: 0, parentPara: 4, controlIndex: 1, cellIndex: 7, cellParagraph: 0 },
  choices: [],
}]);
assert.equal(manualResult.filled.length, 1);
assert.equal(manualTargetCell, 7);

console.log("rhwp edit plan tests passed");
