import assert from "node:assert/strict";
import type { RhwpEditableDocument, RhwpEditField } from "./editPlan";
import type { RhwpFieldAnchor } from "./fieldAnchors";
import { normalizeRhwpStudioCompatibility, prepareRhwpDeltaFields } from "./workingDocument";

let reflowCalls = 0;
const warningDocument = {
  getValidationWarnings: () => JSON.stringify({ count: 21, summary: {}, warnings: [] }),
  reflowLinesegs: () => {
    reflowCalls += 1;
    return 21;
  },
};
assert.equal(normalizeRhwpStudioCompatibility(warningDocument, "hwpx"), 21);
assert.equal(reflowCalls, 1, "경고가 있는 HWPX는 Studio 진입 전에 한 번 자동 보정해야 합니다.");

assert.equal(normalizeRhwpStudioCompatibility(warningDocument, "hwp"), 0);
assert.equal(reflowCalls, 1, "HWP에는 HWPX lineseg 보정을 적용하면 안 됩니다.");

assert.equal(normalizeRhwpStudioCompatibility({
  getValidationWarnings: () => JSON.stringify({ count: 0, summary: {}, warnings: [] }),
  reflowLinesegs: () => {
    reflowCalls += 1;
    return 0;
  },
}, "hwpx"), 0);
assert.equal(reflowCalls, 1, "경고가 없는 HWPX를 다시 쓰면 안 됩니다.");

assert.equal(normalizeRhwpStudioCompatibility({
  getValidationWarnings: () => JSON.stringify({ count: 21, summary: {}, warnings: [] }),
  // LinesegTextRunReflow처럼 페이지 수 보존을 위해 core가 보정하지 않는 경고가 있다.
  reflowLinesegs: () => 0,
}, "hwpx"), 0);

assert.doesNotThrow(() => normalizeRhwpStudioCompatibility({
  getValidationWarnings: () => "invalid-json",
  reflowLinesegs: () => {
    throw new Error("호출되면 안 됨");
  },
}, "hwpx"));

const anchor: RhwpFieldAnchor = {
  fieldId: "revenue",
  label: "매출액",
  page: 1,
  box: { x: 0.2, y: 0.3, width: 0.4, height: 0.05 },
  source: "rhwp_table_cell",
  confidence: "exact",
  target: { kind: "cell", section: 0, parentPara: 2, controlIndex: 0, cellIndex: 1, cellParagraph: 0 },
  choices: [],
};
const edit: RhwpEditField = {
  fieldId: "revenue",
  label: "매출액",
  value: "5000",
  fieldType: "currency",
};

function documentWithText(initial: string): { document: RhwpEditableDocument; deleted: number[] } {
  let text = initial;
  const deleted: number[] = [];
  return {
    deleted,
    document: {
      searchAllText: () => "[]",
      getCellInfo: () => "{}",
      getCellParagraphLength: () => text.length,
      getTextInCell: () => text,
      deleteTextInCell: (_sec, _para, _ctrl, _cell, _cellPara, offset, count) => {
        deleted.push(count);
        text = text.slice(0, offset) + text.slice(offset + count);
        return JSON.stringify({ ok: true });
      },
      insertTextInCell: () => JSON.stringify({ ok: true }),
    },
  };
}

const exact = documentWithText("3000(천원)");
const exactConflicts: Array<{ label: string; value: string; reason: string }> = [];
const exactPending = prepareRhwpDeltaFields({
  document: exact.document,
  fields: [edit],
  previous: { revenue: "3000" },
  manualAnchors: [anchor],
  conflicts: exactConflicts,
});
assert.deepEqual(exactPending, [edit]);
assert.deepEqual(exact.deleted, [4]);
assert.deepEqual(exactConflicts, []);

const studioEdited = documentWithText("Studio에서 직접 고친 값");
const conflicts: Array<{ label: string; value: string; reason: string }> = [];
const blocked = prepareRhwpDeltaFields({
  document: studioEdited.document,
  fields: [edit],
  previous: { revenue: "3000" },
  manualAnchors: [anchor],
  conflicts,
});
assert.deepEqual(blocked, []);
assert.equal(studioEdited.deleted.length, 0);
assert.match(conflicts[0]?.reason ?? "", /덮어쓰지 않았습니다/);

const unchanged = documentWithText("3000(천원)");
const unchangedPending = prepareRhwpDeltaFields({
  document: unchanged.document,
  fields: [{ ...edit, value: "3000" }],
  previous: { revenue: "3000" },
  manualAnchors: [anchor],
  conflicts: [],
});
assert.deepEqual(unchangedPending, []);
assert.equal(unchanged.deleted.length, 0);

console.log("rhwp working document delta safety passed");
