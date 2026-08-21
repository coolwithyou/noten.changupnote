import assert from "node:assert/strict";
import type { RhwpModule } from "./client";
import { sha256Hex } from "./documentAgentContract";
import type {
  StudioApplyFieldCommandV1,
  StudioFieldAgentProtocol,
  StudioFieldCommandReceiptV1,
  StudioRevertFieldCommandV1,
  StudioTableCellRegionTargetV1,
  StudioTableCellTextTargetV1,
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

function encode(cells: string[]): Uint8Array {
  return encoder.encode(JSON.stringify(cells));
}

class FakeDocument {
  private readonly cells: string[];
  constructor(bytes: Uint8Array) { this.cells = JSON.parse(decoder.decode(bytes)) as string[]; }
  getTableDimensions() { return JSON.stringify({ rowCount: 1, colCount: 2, cellCount: 2 }); }
  getCellParagraphCount() { return 1; }
  getCellParagraphLength(_s: number, _p: number, _c: number, cell: number) { return this.cells[cell]!.length; }
  getTextInCell(_s: number, _p: number, _c: number, cell: number) { return this.cells[cell]!; }
  getCellCharPropertiesAt() { return JSON.stringify({ charShapeId: 7 }); }
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
    const cells = JSON.parse(decoder.decode(before)) as string[];
    cells[target.cellIndex] = command.replacement;
    current = encode(cells);
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
assert.equal((JSON.parse(decoder.decode(applied.bytes)) as string[])[1], "주식회사 노튼");
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
