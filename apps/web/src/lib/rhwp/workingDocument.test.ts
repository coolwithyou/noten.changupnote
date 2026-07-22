import assert from "node:assert/strict";
import type { RhwpEditableDocument, RhwpEditField } from "./editPlan";
import type { RhwpFieldAnchor } from "./fieldAnchors";
import { prepareRhwpDeltaFields } from "./workingDocument";

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
