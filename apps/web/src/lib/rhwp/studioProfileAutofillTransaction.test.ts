import assert from "node:assert/strict";
import type { RhwpModule } from "./client";
import { sha256Hex } from "./documentAgentContract";
import type {
  StudioApplyFieldCommandV1,
  StudioFieldAgentProtocol,
  StudioFieldCommandReceiptV1,
  StudioFieldTargetV1,
  StudioRevertFieldCommandV1,
  StudioTableCellTextTargetV1,
} from "./studioDocumentAgentProtocol";
import { collectStudioFieldEvidence } from "./studioFieldAgentTransaction";
import {
  createStudioProfileAutofillTransaction,
  StudioProfileAutofillTransactionError,
} from "./studioProfileAutofillTransaction";

type Fixture = { cells: string[]; charShapeIds: number[] };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const firstTarget = target(1);
const secondTarget = target(3);

class FakeDocument {
  private readonly fixture: Fixture;
  constructor(bytes: Uint8Array) { this.fixture = JSON.parse(decoder.decode(bytes)) as Fixture; }
  getTableDimensions() { return JSON.stringify({ rowCount: 2, colCount: 2, cellCount: 4 }); }
  getCellParagraphCount() { return 1; }
  getCellParagraphLength(_s: number, _p: number, _c: number, cell: number) { return this.fixture.cells[cell]!.length; }
  getTextInCell(_s: number, _p: number, _c: number, cell: number) { return this.fixture.cells[cell]!; }
  getCellCharPropertiesAt(_s: number, _p: number, _c: number, cell: number) {
    return JSON.stringify({ charShapeId: this.fixture.charShapeIds[cell] });
  }
  getCellParaPropertiesAt() { return JSON.stringify({ paraShapeId: 9 }); }
  getCellOwnProperties(_s: number, _p: number, _c: number, cell: number) {
    return JSON.stringify({ cell, borderFillId: 2 });
  }
  free() {}
}

const rhwp = { HwpDocument: FakeDocument } as unknown as RhwpModule;
const original = encode(["회사명", "", "대표자명", "※ 대표자명을 기재하세요"], [7, 7, 7, 31]);
let current = original;
let changeSeq = 0;

const protocol: StudioFieldAgentProtocol = {
  async getDocumentState() {
    return {
      schemaVersion: 1,
      format: "hwp",
      documentEpoch: 1,
      changeSeq,
      dirty: changeSeq > 0,
      pageCount: 1,
      documentSha256: await sha256Hex(current),
    };
  },
  async applyFieldCommand(command: StudioApplyFieldCommandV1) {
    const before = current;
    const fixture = JSON.parse(decoder.decode(before)) as Fixture;
    const cell = command.target.kind === "table_cell_text" ? command.target.cellIndex : -1;
    assert.ok(cell >= 0);
    fixture.cells[cell] = command.replacement;
    fixture.charShapeIds[cell] = command.replacementStyle === "actual-input"
      ? 8
      : command.replacementFormat?.kind === "table_cell_text"
        ? command.replacementFormat.charShapeIds[0]!
        : fixture.charShapeIds[cell]!;
    current = encoder.encode(JSON.stringify(fixture));
    return receipt(command.commandId, "apply", before, current, command.target);
  },
  async revertFieldCommand(_command: StudioRevertFieldCommandV1) {
    throw new Error("recovery apply 경로만 사용해야 합니다.");
  },
  async focusFieldTarget() { return { focused: true, page: 1 }; },
  onDocumentChanged() { return () => undefined; },
};

const transaction = createStudioProfileAutofillTransaction({
  rhwp,
  protocol,
  exportCurrentBytes: async () => current,
});
const batch = await transaction.apply({
  bytes: original,
  format: "hwp",
  entries: [
    { fieldId: "company", label: "회사명", sourceSpan: null, target: firstTarget, value: "창업노트 주식회사" },
    { fieldId: "ceo", label: "대표자명", sourceSpan: "※ 대표자명을 기재하세요", target: secondTarget, value: "홍길동" },
  ],
});
const appliedFixture = decode(batch.bytes);
assert.deepEqual(appliedFixture.cells, ["회사명", "창업노트 주식회사", "대표자명", "홍길동"]);
assert.equal(appliedFixture.charShapeIds[1], 8);
assert.equal(appliedFixture.charShapeIds[3], 8, "placeholder 서식이 아니라 실제 입력 서식을 사용한다");
assert.deepEqual(await transaction.revert(batch), original, "역순 복구 후 원본 바이트와 같아야 한다");

current = original;
changeSeq = 0;
const blockedOriginal = encode(["회사명", "", "대표자명", "이미 입력됨"], [7, 7, 7, 7]);
current = blockedOriginal;
const blockedTransaction = createStudioProfileAutofillTransaction({
  rhwp,
  protocol,
  exportCurrentBytes: async () => current,
});
let blocked: StudioProfileAutofillTransactionError | null = null;
try {
  await blockedTransaction.apply({
    bytes: blockedOriginal,
    format: "hwp",
    entries: [
      { fieldId: "company", label: "회사명", sourceSpan: null, target: firstTarget, value: "창업노트 주식회사" },
      { fieldId: "ceo", label: "대표자명", sourceSpan: null, target: secondTarget, value: "홍길동" },
    ],
  });
} catch (error) {
  if (error instanceof StudioProfileAutofillTransactionError) blocked = error;
}
assert.ok(blocked);
assert.equal(blocked.partial?.applied.length, 1);
assert.deepEqual(await blockedTransaction.revert(blocked.partial!), blockedOriginal);

function encode(cells: string[], charShapeIds: number[]): Uint8Array {
  return encoder.encode(JSON.stringify({ cells, charShapeIds } satisfies Fixture));
}

function decode(bytes: Uint8Array): Fixture {
  return JSON.parse(decoder.decode(bytes)) as Fixture;
}

function target(cellIndex: number): StudioTableCellTextTargetV1 {
  return {
    kind: "table_cell_text",
    section: 0,
    parentPara: 0,
    controlIndex: 0,
    cellIndex,
    cellParagraph: 0,
  };
}

async function receipt(
  commandId: string,
  operation: "apply" | "revert",
  before: Uint8Array,
  after: Uint8Array,
  commandTarget: StudioFieldTargetV1,
): Promise<StudioFieldCommandReceiptV1> {
  const beforeEvidence = await collectStudioFieldEvidence(rhwp, before, commandTarget);
  const afterEvidence = await collectStudioFieldEvidence(rhwp, after, commandTarget);
  const beforeChangeSeq = changeSeq;
  changeSeq += 1;
  return {
    schemaVersion: 1,
    commandId,
    operation,
    documentEpoch: 1,
    beforeChangeSeq,
    afterChangeSeq: changeSeq,
    beforeDocumentSha256: await sha256Hex(before),
    afterDocumentSha256: await sha256Hex(after),
    beforeTextSha256: beforeEvidence.textSha256,
    afterTextSha256: afterEvidence.textSha256,
    formatSha256: afterEvidence.formatSha256,
    adjacentContextSha256: afterEvidence.adjacentContextSha256,
    pageCountBefore: 1,
    pageCountAfter: 1,
    target: commandTarget,
  };
}

console.log("studio profile autofill transaction tests passed");
