import assert from "node:assert/strict";
import type { RhwpModule } from "./client";
import { sha256Hex } from "./documentAgentContract";
import type {
  StudioApplyTextCommandV1,
  StudioDocumentAgentProtocol,
  StudioApplyFieldCommandV1,
  StudioFieldAgentProtocol,
  StudioFieldCommandReceiptV1,
  StudioRevertFieldCommandV1,
  StudioRevertTextCommandV1,
  StudioTableCellRegionTargetV1,
  StudioTableCellTextTargetV1,
  StudioTextCommandReceiptV1,
} from "./studioDocumentAgentProtocol";
import {
  collectStudioFieldEvidence,
  createStudioFieldAgentTransaction,
} from "./studioFieldAgentTransaction";

const target: StudioTableCellTextTargetV1 = {
  kind: "table_cell_text",
  section: 0,
  parentPara: 0,
  controlIndex: 0,
  cellIndex: 1,
  cellParagraph: 0,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type FlatFixture = { cells: string[]; charShapeIds: number[] };

function encode(cells: string[], charShapeId = 7): Uint8Array {
  return encoder.encode(JSON.stringify({ cells, charShapeIds: cells.map(() => charShapeId) } satisfies FlatFixture));
}

class FakeDocument {
  private readonly fixture: FlatFixture;
  constructor(bytes: Uint8Array) { this.fixture = JSON.parse(decoder.decode(bytes)) as FlatFixture; }
  getTableDimensions() { return JSON.stringify({ rowCount: 1, colCount: 2, cellCount: 2 }); }
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
const original = encode(["항목", "기존값"]);
let current = original;
let changeSeq = 0;
const journal = new Map<string, { before: Uint8Array; after: Uint8Array }>();

async function receipt(input: {
  commandId: string;
  operation: "apply" | "revert";
  before: Uint8Array;
  after: Uint8Array;
}): Promise<StudioFieldCommandReceiptV1> {
  const beforeEvidence = await collectStudioFieldEvidence(rhwp, input.before, target);
  const afterEvidence = await collectStudioFieldEvidence(rhwp, input.after, target);
  const beforeChangeSeq = changeSeq;
  changeSeq += 1;
  return {
    schemaVersion: 1,
    commandId: input.commandId,
    operation: input.operation,
    documentEpoch: 1,
    beforeChangeSeq,
    afterChangeSeq: changeSeq,
    beforeDocumentSha256: await sha256Hex(input.before),
    afterDocumentSha256: await sha256Hex(input.after),
    beforeTextSha256: beforeEvidence.textSha256,
    afterTextSha256: afterEvidence.textSha256,
    formatSha256: afterEvidence.formatSha256,
    adjacentContextSha256: afterEvidence.adjacentContextSha256,
    pageCountBefore: 1,
    pageCountAfter: 1,
    target,
  };
}

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
    const fixture = JSON.parse(decoder.decode(before)) as FlatFixture;
    fixture.cells[target.cellIndex] = command.replacement;
    const restoredCharShapeId = command.replacementFormat?.kind === "table_cell_text"
      ? command.replacementFormat.charShapeIds[0]
      : undefined;
    fixture.charShapeIds[target.cellIndex] = command.replacementStyle === "actual-input"
      ? 8
      : restoredCharShapeId ?? fixture.charShapeIds[target.cellIndex]!;
    current = encoder.encode(JSON.stringify(fixture));
    journal.set(command.commandId, { before, after: current });
    return receipt({ commandId: command.commandId, operation: "apply", before, after: current });
  },
  async revertFieldCommand(command: StudioRevertFieldCommandV1) {
    const entry = journal.get(command.commandId)!;
    const before = current;
    current = entry.before;
    return receipt({ commandId: command.commandId, operation: "revert", before, after: current });
  },
  async focusFieldTarget() { return { focused: true, page: 1 }; },
  onDocumentChanged() { return () => undefined; },
};

const beforeEvidence = await collectStudioFieldEvidence(rhwp, original, target);
assert.deepEqual(await collectStudioFieldEvidence(rhwp, original, target), beforeEvidence);
const transaction = createStudioFieldAgentTransaction({
  rhwp,
  protocol,
  exportCurrentBytes: async () => current,
});
const applied = await transaction.apply({
  bytes: original,
  format: "hwp",
  commandId: "field:test",
  binding: {
    target,
    beforeText: beforeEvidence.text,
    beforeTextSha256: beforeEvidence.textSha256,
    formatSha256: beforeEvidence.formatSha256,
    adjacentContextSha256: beforeEvidence.adjacentContextSha256,
  },
  replacement: "주식회사 노튼",
});
assert.equal((JSON.parse(decoder.decode(applied.bytes)) as FlatFixture).cells[1], "주식회사 노튼");
assert.notEqual(applied.receipt.formatSha256, beforeEvidence.formatSha256);
const reverted = await transaction.revert({
  bytes: applied.bytes,
  format: "hwp",
  commandId: "field:test",
  expectedAfterTextSha256: applied.receipt.afterTextSha256,
});
assert.deepEqual(reverted.bytes, original);
assert.equal(changeSeq, 2);

// 새로고침된 Studio에는 이전 native command journal이 없다. 서버에 봉인된 applied SHA와
// exact binding이 모두 맞을 때만 inverse field command로 같은 값을 되돌린다.
current = applied.bytes;
changeSeq = 0;
journal.clear();
const reloadedTransaction = createStudioFieldAgentTransaction({
  rhwp,
  protocol,
  exportCurrentBytes: async () => current,
});
const recovered = await reloadedTransaction.revert({
  bytes: applied.bytes,
  format: "hwp",
  commandId: "field:test",
  expectedAfterTextSha256: applied.receipt.afterTextSha256,
  recovery: {
    appliedDocumentSha256: applied.afterDocumentSha256,
    appliedText: "주식회사 노튼",
    binding: {
      target,
      beforeText: beforeEvidence.text,
      beforeTextSha256: beforeEvidence.textSha256,
      formatSha256: beforeEvidence.formatSha256,
      adjacentContextSha256: beforeEvidence.adjacentContextSha256,
    },
    restoreFormat: beforeEvidence.restoreFormat,
  },
});
assert.deepEqual(recovered.bytes, original);
assert.equal(recovered.receipt.commandId, "field:test:undo");
assert.equal(changeSeq, 1);

await assert.rejects(
  () => reloadedTransaction.revert({
    bytes: applied.bytes,
    format: "hwp",
    commandId: "field:other",
    expectedAfterTextSha256: applied.receipt.afterTextSha256,
    recovery: {
      appliedDocumentSha256: "0".repeat(64),
      appliedText: "주식회사 노튼",
      binding: {
        target,
        beforeText: beforeEvidence.text,
        beforeTextSha256: beforeEvidence.textSha256,
        formatSha256: beforeEvidence.formatSha256,
        adjacentContextSha256: beforeEvidence.adjacentContextSha256,
      },
    },
  }),
  /적용 revision과 현재 Studio 문서가 달라/,
);

type ParagraphFixture = { paragraphs: string[] };
class FakeParagraphDocument {
  private readonly fixture: ParagraphFixture;
  constructor(bytes: Uint8Array) { this.fixture = JSON.parse(decoder.decode(bytes)) as ParagraphFixture; }
  getSectionCount() { return 1; }
  getParagraphCount() { return this.fixture.paragraphs.length; }
  getParagraphLength(_section: number, paragraph: number) { return this.fixture.paragraphs[paragraph]!.length; }
  getTextRange(_section: number, paragraph: number, offset: number, count: number) {
    return this.fixture.paragraphs[paragraph]!.slice(offset, offset + count);
  }
  getControlTextPositions() { return "[]"; }
  getFieldInfoAt() { return JSON.stringify({ inField: false }); }
  getCharPropertiesAt() { return JSON.stringify({ charShapeId: 7 }); }
  getParaPropertiesAt() { return JSON.stringify({ paraShapeId: 9 }); }
  getStyleAt() { return JSON.stringify({ id: 3 }); }
  free() {}
}

const paragraphRhwp = { HwpDocument: FakeParagraphDocument } as unknown as RhwpModule;
const paragraphPrefix = "가. 기업체명 :";
const paragraphTarget = {
  kind: "body_paragraph_text" as const,
  section: 0,
  paragraph: 1,
  length: paragraphPrefix.length,
  valueStart: paragraphPrefix.length,
  valueEnd: paragraphPrefix.length,
};
const paragraphOriginal = encoder.encode(JSON.stringify({ paragraphs: ["사업계획서", paragraphPrefix, "다. 대표자 :"] }));
let paragraphCurrent = paragraphOriginal;
let paragraphChangeSeq = 0;
let paragraphApplyReceipt: StudioTextCommandReceiptV1 | null = null;
const paragraphState = async () => ({
  schemaVersion: 1 as const,
  format: "hwp" as const,
  documentEpoch: 1,
  changeSeq: paragraphChangeSeq,
  dirty: paragraphChangeSeq > 0,
  pageCount: 1,
  documentSha256: await sha256Hex(paragraphCurrent),
});
const paragraphProtocol: StudioDocumentAgentProtocol = {
  getDocumentState: paragraphState,
  getSelectionContext: async () => ({
    schemaVersion: 1,
    documentEpoch: 1,
    changeSeq: paragraphChangeSeq,
    page: 1,
    editable: true,
    collapsed: true,
    target: { kind: "body_paragraph", section: 0, paragraph: 1, charOffset: 0, length: paragraphPrefix.length },
    selectedTextSha256: null,
  }),
  applyTextCommand: async (command: StudioApplyTextCommandV1) => {
    const before = paragraphCurrent;
    const beforeState = await paragraphState();
    const beforeEvidence = await collectStudioFieldEvidence(paragraphRhwp, before, paragraphTarget);
    const fixture = JSON.parse(decoder.decode(before)) as ParagraphFixture;
    fixture.paragraphs[1] = command.replacement;
    paragraphCurrent = encoder.encode(JSON.stringify(fixture));
    const afterTarget = { ...paragraphTarget, length: command.replacement.length, valueEnd: command.replacement.length };
    const afterEvidence = await collectStudioFieldEvidence(paragraphRhwp, paragraphCurrent, afterTarget);
    const beforeChangeSeq = paragraphChangeSeq++;
    paragraphApplyReceipt = {
      schemaVersion: 1,
      commandId: command.commandId,
      operation: "apply",
      documentEpoch: 1,
      beforeChangeSeq,
      afterChangeSeq: paragraphChangeSeq,
      beforeDocumentSha256: beforeState.documentSha256,
      afterDocumentSha256: await sha256Hex(paragraphCurrent),
      beforeTextSha256: beforeEvidence.textSha256,
      afterTextSha256: afterEvidence.textSha256,
      formatSha256: afterEvidence.formatSha256,
      adjacentContextSha256: afterEvidence.adjacentContextSha256,
      pageCountBefore: 1,
      pageCountAfter: 1,
      target: command.target,
    };
    return paragraphApplyReceipt;
  },
  revertTextCommand: async (command: StudioRevertTextCommandV1) => {
    assert.ok(paragraphApplyReceipt);
    const beforeState = await paragraphState();
    const beforeEvidence = await collectStudioFieldEvidence(paragraphRhwp, paragraphCurrent, {
      ...paragraphTarget,
      length: "가. 기업체명 : 주식회사 노튼".length,
      valueEnd: "가. 기업체명 : 주식회사 노튼".length,
    });
    paragraphCurrent = paragraphOriginal;
    const afterEvidence = await collectStudioFieldEvidence(paragraphRhwp, paragraphCurrent, paragraphTarget);
    const beforeChangeSeq = paragraphChangeSeq++;
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      operation: "revert",
      documentEpoch: 1,
      beforeChangeSeq,
      afterChangeSeq: paragraphChangeSeq,
      beforeDocumentSha256: beforeState.documentSha256,
      afterDocumentSha256: await sha256Hex(paragraphCurrent),
      beforeTextSha256: beforeEvidence.textSha256,
      afterTextSha256: afterEvidence.textSha256,
      formatSha256: afterEvidence.formatSha256,
      adjacentContextSha256: afterEvidence.adjacentContextSha256,
      pageCountBefore: 1,
      pageCountAfter: 1,
      target: paragraphApplyReceipt.target,
    };
  },
  focusTarget: async () => ({ focused: true, page: 1 }),
  onDocumentChanged: () => () => undefined,
};
const paragraphEvidence = await collectStudioFieldEvidence(paragraphRhwp, paragraphOriginal, paragraphTarget);
const paragraphTransaction = createStudioFieldAgentTransaction({
  rhwp: paragraphRhwp,
  documentProtocol: paragraphProtocol,
  exportCurrentBytes: async () => paragraphCurrent,
});
const paragraphReplacement = "가. 기업체명 : 주식회사 노튼";
const paragraphApplied = await paragraphTransaction.apply({
  bytes: paragraphOriginal,
  format: "hwp",
  commandId: "paragraph:test",
  binding: {
    target: paragraphTarget,
    beforeText: paragraphEvidence.text,
    beforeTextSha256: paragraphEvidence.textSha256,
    formatSha256: paragraphEvidence.formatSha256,
    adjacentContextSha256: paragraphEvidence.adjacentContextSha256,
  },
  replacement: paragraphReplacement,
});
assert.equal((JSON.parse(decoder.decode(paragraphApplied.bytes)) as ParagraphFixture).paragraphs[1], paragraphReplacement);
const paragraphReverted = await paragraphTransaction.revert({
  bytes: paragraphApplied.bytes,
  format: "hwp",
  commandId: "paragraph:test",
  expectedAfterTextSha256: paragraphApplied.receipt.afterTextSha256,
});
assert.deepEqual(paragraphReverted.bytes, paragraphOriginal);
assert.equal(paragraphChangeSeq, 2);

type RegionParagraphFixture = { text: string; charShapeIds: number[]; paraShapeId: number };
type RegionFixture = { cells: RegionParagraphFixture[][] };

class FakeRegionDocument {
  private readonly fixture: RegionFixture;
  constructor(bytes: Uint8Array) { this.fixture = JSON.parse(decoder.decode(bytes)) as RegionFixture; }
  getTableDimensions() { return JSON.stringify({ rowCount: 1, colCount: 2, cellCount: 2 }); }
  getCellParagraphCount(_s: number, _p: number, _c: number, cell: number) {
    return this.fixture.cells[cell]!.length;
  }
  getCellParagraphLength(_s: number, _p: number, _c: number, cell: number, paragraph: number) {
    return Array.from(this.fixture.cells[cell]![paragraph]!.text).length;
  }
  getTextInCell(
    _s: number,
    _p: number,
    _c: number,
    cell: number,
    paragraph: number,
    offset: number,
    count: number,
  ) {
    return Array.from(this.fixture.cells[cell]![paragraph]!.text).slice(offset, offset + count).join("");
  }
  getCellCharPropertiesAt(
    _s: number,
    _p: number,
    _c: number,
    cell: number,
    paragraph: number,
    offset: number,
  ) {
    const ids = this.fixture.cells[cell]![paragraph]!.charShapeIds;
    return JSON.stringify({ charShapeId: ids[Math.min(offset, ids.length - 1)] ?? 1 });
  }
  getCellParaPropertiesAt(_s: number, _p: number, _c: number, cell: number, paragraph: number) {
    return JSON.stringify({ paraShapeId: this.fixture.cells[cell]![paragraph]!.paraShapeId });
  }
  getCellOwnProperties(_s: number, _p: number, _c: number, cell: number) {
    return JSON.stringify({ cell, borderFillId: 2 });
  }
  free() {}
}

const regionTarget: StudioTableCellRegionTargetV1 = {
  kind: "table_cell_region",
  section: 0,
  parentPara: 0,
  controlIndex: 0,
  cellIndex: 1,
};
const mixedRegionBytes = encoder.encode(JSON.stringify({ cells: [
  [{ text: "항목", charShapeIds: [7, 7], paraShapeId: 9 }],
  [
    { text: "※ 안내", charShapeIds: [37, 37, 40, 40], paraShapeId: 0 },
    { text: "본문 계획", charShapeIds: [40, 40, 40, 40, 40], paraShapeId: 35 },
  ],
] } satisfies RegionFixture));
const canonicalRegionBytes = encoder.encode(JSON.stringify({ cells: [
  [{ text: "항목", charShapeIds: [7, 7], paraShapeId: 9 }],
  [{ text: "검증된 사업계획", charShapeIds: Array(8).fill(40), paraShapeId: 0 }],
] } satisfies RegionFixture));
const regionRhwp = { HwpDocument: FakeRegionDocument } as unknown as RhwpModule;
const mixedRegionEvidence = await collectStudioFieldEvidence(regionRhwp, mixedRegionBytes, regionTarget);
const canonicalRegionEvidence = await collectStudioFieldEvidence(regionRhwp, canonicalRegionBytes, regionTarget);
assert.equal(mixedRegionEvidence.text, "※ 안내\n본문 계획");
assert.equal(mixedRegionEvidence.formatSha256, canonicalRegionEvidence.formatSha256,
  "혼합 안내문과 적용 본문은 같은 canonical replacement 서식 계약을 공유한다");
assert.equal(mixedRegionEvidence.adjacentContextSha256, canonicalRegionEvidence.adjacentContextSha256);

console.log("rhwp Studio field command transaction tests passed");
