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

console.log("rhwp edit plan tests passed");
