import assert from "node:assert/strict";
import { extractFieldOptions } from "@/lib/documents/fieldOptions";
import {
  resolveRhwpCellAtPoint,
  resolveRhwpFieldAnchors,
  type RhwpAnchorDocument,
} from "./fieldAnchors";

assert.deepEqual(
  extractFieldOptions("checkbox", "□ 예비창업자 □ 폐업 후 재창업자"),
  ["예비창업자", "폐업 후 재창업자"],
);
assert.deepEqual(
  extractFieldOptions("checkbox", "수신동의여부 동의( ) 미동의( )"),
  ["동의", "미동의"],
);
assert.deepEqual(extractFieldOptions("text", "□ 예 □ 아니오"), []);

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
