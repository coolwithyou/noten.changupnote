import assert from "node:assert/strict";
import {
  buildStudioDocumentAgentCommandEvidence,
  resolveStudioDocumentAgentProtocol,
  resolveStudioFieldNavigationProtocol,
  resolveStudioFieldSelectionProtocol,
  studioDocumentStateSchema,
  studioTextCommandReceiptSchema,
  type StudioDocumentAgentEvidenceDocument,
} from "./studioDocumentAgentProtocol";

const paragraphs = ["앞문단", "대상문단", "뒷문단"];
const document: StudioDocumentAgentEvidenceDocument = {
  getParagraphCount: () => paragraphs.length,
  getParagraphLength: (_section, paragraph) => paragraphs[paragraph]!.length,
  getTextRange: (_section, paragraph, offset, count) => paragraphs[paragraph]!.slice(offset, offset + count),
  getControlTextPositions: (_section, paragraph) => JSON.stringify(paragraph === 2 ? [1] : []),
  getCharPropertiesAt: (_section, paragraph) => JSON.stringify({
    charShapeId: paragraph === 0 ? 1 : paragraph === 1 ? 7 : 4,
  }),
  getParaPropertiesAt: (_section, paragraph) => JSON.stringify({
    paraShapeId: paragraph === 0 ? 2 : paragraph === 1 ? 8 : 5,
  }),
  getStyleAt: (_section, paragraph) => JSON.stringify({
    id: paragraph === 0 ? 3 : paragraph === 1 ? 9 : 6,
  }),
};

const evidence = await buildStudioDocumentAgentCommandEvidence({
  document,
  target: { kind: "body_paragraph", section: 0, paragraph: 1, charOffset: 0, length: 4 },
  formatSnapshot: {
    charProperties: { charShapeId: 7, extra: "Cunote 전체 format hash에만 포함" },
    paragraphProperties: { paraShapeId: 8 },
    style: { id: 9 },
  },
});
assert.deepEqual(evidence, {
  formatSha256: "99ef250fa2fa13e3350a5ddc732718e854f9bbc0a644d304b25cc1b3b7a2e626",
  adjacentContextSha256: "ee46938498caa6a8c405e963d3354f0f85a81af9167669c8797377c95c26deae",
});

const state = {
  schemaVersion: 1 as const,
  format: "hwp" as const,
  documentEpoch: 1,
  changeSeq: 0,
  dirty: false,
  pageCount: 1,
  documentSha256: "a".repeat(64),
};
assert.deepEqual(studioDocumentStateSchema.parse(state), state);
assert.throws(() => studioDocumentStateSchema.parse({ ...state, extra: true }), /unrecognized_keys|Unrecognized key/u);
assert.throws(
  () => studioDocumentStateSchema.parse({ ...state, changeSeq: Number.MAX_SAFE_INTEGER + 1 }),
  /safe integer/u,
);

const receipt = {
  schemaVersion: 1 as const,
  commandId: "command-1",
  operation: "apply" as const,
  documentEpoch: 1,
  beforeChangeSeq: 0,
  afterChangeSeq: 1,
  beforeDocumentSha256: "a".repeat(64),
  afterDocumentSha256: "b".repeat(64),
  beforeTextSha256: "c".repeat(64),
  afterTextSha256: "d".repeat(64),
  formatSha256: "e".repeat(64),
  adjacentContextSha256: "f".repeat(64),
  pageCountBefore: 1,
  pageCountAfter: 1,
  target: { kind: "body_paragraph" as const, section: 0, paragraph: 0, charOffset: 0 as const, length: 3 },
};
assert.deepEqual(studioTextCommandReceiptSchema.parse(receipt), receipt);
assert.throws(
  () => studioTextCommandReceiptSchema.parse({ ...receipt, afterChangeSeq: 2 }),
  /연속되지/u,
);

let privateRequestCalls = 0;
assert.equal(resolveStudioDocumentAgentProtocol({
  _request: () => { privateRequestCalls += 1; },
}), null);
assert.equal(privateRequestCalls, 0, "private _request는 capability 탐색에도 사용하지 않아야 합니다.");

const calls: string[] = [];
const editor = {
  getDocumentState: async () => { calls.push("state"); return state; },
  getSelectionContext: async () => ({
    schemaVersion: 1,
    documentEpoch: 1,
    changeSeq: 0,
    page: 1,
    editable: true,
    collapsed: true,
    target: null,
    selectedTextSha256: null,
  }),
  applyTextCommand: async () => receipt,
  revertTextCommand: async () => ({ ...receipt, operation: "revert" }),
  focusTarget: async () => ({ focused: true, page: 1 }),
  onDocumentChanged: () => () => undefined,
};
assert.equal(resolveStudioDocumentAgentProtocol({ ...editor, onDocumentChanged: undefined }), null);
const protocol = resolveStudioDocumentAgentProtocol(editor);
assert.ok(protocol);
assert.deepEqual(await protocol.getDocumentState(), state);
assert.deepEqual(calls, ["state"]);

const fieldTarget = {
  kind: "table_cell_text" as const,
  section: 0,
  parentPara: 4,
  controlIndex: 1,
  cellIndex: 3,
  cellParagraph: 0,
};
const fieldCalls: unknown[] = [];
const fieldProtocol = resolveStudioFieldNavigationProtocol({
  focusFieldTarget: async (target: unknown) => {
    fieldCalls.push(target);
    return { focused: true, page: 2 };
  },
});
assert.ok(fieldProtocol);
assert.deepEqual(await fieldProtocol.focusFieldTarget(fieldTarget), { focused: true, page: 2 });
const formFieldTarget = {
  kind: "form_text" as const,
  section: 0,
  paragraph: 7,
  fieldId: 41,
};
assert.deepEqual(await fieldProtocol.focusFieldTarget(formFieldTarget), { focused: true, page: 2 });
assert.deepEqual(fieldCalls, [fieldTarget, formFieldTarget]);
assert.equal(resolveStudioFieldNavigationProtocol({ focusTarget: async () => ({ focused: true, page: 1 }) }), null);
await assert.rejects(
  () => fieldProtocol.focusFieldTarget({ ...fieldTarget, cellIndex: -1 }),
  /too_small|greater than or equal to 0/u,
);
await assert.rejects(
  () => fieldProtocol.focusFieldTarget({ ...formFieldTarget, fieldId: -1 }),
  /too_small|greater than or equal to 0/u,
);

const fieldSelection = {
  schemaVersion: 1 as const,
  documentEpoch: 1,
  changeSeq: 0,
  page: 2,
  editable: true,
  target: fieldTarget,
};
const fieldSelectionListener: { current: ((event: unknown) => void) | null } = { current: null };
const fieldSelectionProtocol = resolveStudioFieldSelectionProtocol({
  getFieldSelectionContext: async () => fieldSelection,
  onFieldSelectionChanged: (listener: (event: unknown) => void) => {
    fieldSelectionListener.current = listener;
    return () => { fieldSelectionListener.current = null; };
  },
});
assert.ok(fieldSelectionProtocol);
assert.deepEqual(await fieldSelectionProtocol.getFieldSelectionContext(), fieldSelection);
const selectedTargets: unknown[] = [];
const unsubscribeFieldSelection = fieldSelectionProtocol.onFieldSelectionChanged(
  (event) => selectedTargets.push(event.target),
);
fieldSelectionListener.current?.(fieldSelection);
assert.deepEqual(selectedTargets, [fieldTarget]);
unsubscribeFieldSelection();
assert.equal(fieldSelectionListener.current, null);
assert.equal(resolveStudioFieldSelectionProtocol({ getFieldSelectionContext: async () => fieldSelection }), null);

console.log("rhwp Studio document-agent protocol tests passed");
