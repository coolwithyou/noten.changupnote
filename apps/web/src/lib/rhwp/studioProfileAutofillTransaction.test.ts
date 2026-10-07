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
import { studioFieldDocumentSemanticSha256 } from "./studioFieldDocumentManifest";
import {
  createStudioProfileAutofillTransaction,
  StudioProfileAutofillTransactionError,
} from "./studioProfileAutofillTransaction";

type Fixture = {
  cells: string[];
  charShapeIds: number[];
  bodyText: string;
  serializationNonce: number;
  semanticInvalid: boolean;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const firstTarget = target(1);
const secondTarget = target(3);

class FakeDocument {
  private readonly fixture: Fixture;
  constructor(bytes: Uint8Array) { this.fixture = JSON.parse(decoder.decode(bytes)) as Fixture; }
  getTableDimensions() { return JSON.stringify({ rowCount: 2, colCount: 2, cellCount: 4 }); }
  getCellParagraphCount(_s: number, _p: number, _c: number, cell: number) {
    if (cell === throwEvidenceOnCell) throw new Error("injected field evidence failure");
    return 1;
  }
  getCellParagraphLength(_s: number, _p: number, _c: number, cell: number) { return this.fixture.cells[cell]!.length; }
  getTextInCell(_s: number, _p: number, _c: number, cell: number) { return this.fixture.cells[cell]!; }
  getCellCharPropertiesAt(_s: number, _p: number, _c: number, cell: number) {
    return JSON.stringify({ charShapeId: this.fixture.charShapeIds[cell] });
  }
  getCellParaPropertiesAt() { return JSON.stringify({ paraShapeId: 9 }); }
  getCellOwnProperties(_s: number, _p: number, _c: number, cell: number) {
    return JSON.stringify({ cell, borderFillId: 2 });
  }
  getSectionCount() { return this.fixture.semanticInvalid ? 0 : 1; }
  pageCount() { return 1; }
  getDocumentInfo() { return JSON.stringify({ sectionCount: 1, fixture: "profile-autofill" }); }
  getParagraphCount() { return 1; }
  getParagraphLength() { return this.fixture.bodyText.length; }
  getTextRange() { return this.fixture.bodyText; }
  getControlTextPositions() { return JSON.stringify([0]); }
  getParaPropertiesAt() { return JSON.stringify({ paraShapeId: 9 }); }
  getStyleAt() { return JSON.stringify({ id: 0 }); }
  getCharPropertiesAt() { return JSON.stringify({ charShapeId: 7 }); }
  getFieldList() { return JSON.stringify([]); }
  getPageControlLayout() {
    return JSON.stringify({
      controls: [{ type: "table", secIdx: 0, paraIdx: 0, controlIdx: 0, stableIndex: [0, 0, 0] }],
    });
  }
  getPageTextLayout() { return JSON.stringify({ runs: [] }); }
  exportControlHtml() {
    const html = JSON.stringify({ cells: this.fixture.cells, charShapeIds: this.fixture.charShapeIds });
    if (armEvidenceFailureCellAfterNextSemantic !== null) {
      throwEvidenceOnCell = armEvidenceFailureCellAfterNextSemantic;
      armEvidenceFailureCellAfterNextSemantic = null;
    }
    return html;
  }
  free() {}
}

const rhwp = { HwpDocument: FakeDocument } as unknown as RhwpModule;
const original = encode(["회사명", "", "대표자명", "※ 대표자명을 기재하세요"], [7, 7, 7, 31]);
let current = original;
let changeSeq = 0;
let serializationNonce = 0;
let injectBodyDriftOnNextInverse = false;
let breakSemanticOnNextApply = false;
let armEvidenceFailureCellAfterNextApply: number | null = null;
let armEvidenceFailureCellAfterNextSemantic: number | null = null;
let throwEvidenceOnCell: number | null = null;

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
    fixture.serializationNonce = ++serializationNonce;
    if (injectBodyDriftOnNextInverse && command.commandId.endsWith(":undo")) {
      fixture.bodyText = "승인되지 않은 본문 변경";
      injectBodyDriftOnNextInverse = false;
    }
    if (breakSemanticOnNextApply && !command.commandId.endsWith(":undo")) {
      fixture.semanticInvalid = true;
      breakSemanticOnNextApply = false;
    }
    current = encoder.encode(JSON.stringify(fixture));
    const commandReceipt = await receipt(command.commandId, "apply", before, current, command.target);
    if (armEvidenceFailureCellAfterNextApply !== null && !command.commandId.endsWith(":undo")) {
      armEvidenceFailureCellAfterNextSemantic = armEvidenceFailureCellAfterNextApply;
      armEvidenceFailureCellAfterNextApply = null;
    }
    return commandReceipt;
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
const reverted = await transaction.revert(batch);
assert.deepEqual(
  semanticFixture(decode(reverted)),
  semanticFixture(decode(original)),
  "역순 복구 후 원본 semantic/format 상태와 같아야 한다",
);
assert.notDeepEqual(reverted, original, "재직렬화 byte drift가 있는 fixture여야 한다");

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
assert.deepEqual(
  semanticFixture(decode(await blockedTransaction.revert(blocked.partial!))),
  semanticFixture(decode(blockedOriginal)),
);

current = original;
changeSeq = 0;
armEvidenceFailureCellAfterNextApply = secondTarget.cellIndex;
let preparationError: StudioProfileAutofillTransactionError | null = null;
try {
  await createStudioProfileAutofillTransaction({
    rhwp,
    protocol,
    exportCurrentBytes: async () => current,
  }).apply({
    bytes: original,
    format: "hwp",
    entries: [
      { fieldId: "company", label: "회사명", sourceSpan: null, target: firstTarget, value: "창업노트 주식회사" },
      { fieldId: "ceo", label: "대표자명", sourceSpan: null, target: secondTarget, value: "홍길동" },
    ],
  });
} catch (error) {
  if (error instanceof StudioProfileAutofillTransactionError) preparationError = error;
}
assert.ok(preparationError);
assert.equal(preparationError.mutationUncertain, false,
  "다음 entry 준비 실패는 아직 새 command를 실행하지 않았으므로 mutation uncertain이 아니어야 한다");
assert.equal(preparationError.partial?.applied.length, 1,
  "다음 entry 준비 실패는 앞서 적용한 entry를 partial rollback 대상으로 반환해야 한다");
throwEvidenceOnCell = null;
assert.deepEqual(
  semanticFixture(decode(await createStudioProfileAutofillTransaction({
    rhwp,
    protocol,
    exportCurrentBytes: async () => current,
  }).revert(preparationError.partial!))),
  semanticFixture(decode(original)),
  "entry 준비 실패 전 적용분은 원래 상태로 복구되어야 한다",
);

current = original;
changeSeq = 0;
const driftTransaction = createStudioProfileAutofillTransaction({
  rhwp,
  protocol,
  exportCurrentBytes: async () => current,
});
const driftBatch = await driftTransaction.apply({
  bytes: original,
  format: "hwp",
  entries: [
    { fieldId: "company", label: "회사명", sourceSpan: null, target: firstTarget, value: "창업노트 주식회사" },
    { fieldId: "ceo", label: "대표자명", sourceSpan: "※ 대표자명을 기재하세요", target: secondTarget, value: "홍길동" },
  ],
});
injectBodyDriftOnNextInverse = true;
await assert.rejects(
  () => driftTransaction.revert(driftBatch),
  /역변경 결과가 원래 문서 내용과 서식을 복원하지 못했습니다/,
  "첫 inverse가 비대상 본문을 바꾸면 다음 inverse 전에 차단해야 한다",
);
assert.equal(changeSeq, 3, "비대상 변경이 확인된 뒤 다음 inverse를 실행하면 안 된다");
assert.notEqual(
  await semanticSha(current),
  await semanticSha(driftBatch.bytes),
  "중간 실패는 caller가 applied snapshot으로 복구해야 하는 partial mutation이어야 한다",
);
current = driftBatch.bytes;
assert.equal(
  await semanticSha(current),
  driftBatch.applied.at(-1)!.afterSemanticSha256,
  "caller의 applied snapshot reload는 batch final semantic state를 복원한다",
);

current = original;
changeSeq = 0;
breakSemanticOnNextApply = true;
let postApplySealError: StudioProfileAutofillTransactionError | null = null;
try {
  await createStudioProfileAutofillTransaction({
    rhwp,
    protocol,
    exportCurrentBytes: async () => current,
  }).apply({
    bytes: original,
    format: "hwp",
    entries: [
      { fieldId: "company", label: "회사명", sourceSpan: null, target: firstTarget, value: "창업노트 주식회사" },
    ],
  });
} catch (error) {
  if (error instanceof StudioProfileAutofillTransactionError) postApplySealError = error;
}
assert.ok(postApplySealError);
assert.equal(postApplySealError.mutationUncertain, true,
  "native apply가 return한 뒤 semantic seal이 실패하면 mutation을 확정할 수 없어야 한다");
assert.equal(postApplySealError.partial?.applied.length, 0,
  "봉인되지 않은 current entry를 rollback 가능한 applied 목록에 넣으면 안 된다");

const callerOwnedBeforeBytes = original.slice();
current = callerOwnedBeforeBytes;
changeSeq = 0;
const immutableBaselineBatch = await createStudioProfileAutofillTransaction({
  rhwp,
  protocol,
  exportCurrentBytes: async () => current,
}).apply({
  bytes: callerOwnedBeforeBytes,
  format: "hwp",
  entries: [
    { fieldId: "company", label: "회사명", sourceSpan: null, target: firstTarget, value: "창업노트 주식회사" },
  ],
});
callerOwnedBeforeBytes.fill(0);
assert.deepEqual(immutableBaselineBatch.beforeBytes, original,
  "batch original baseline은 caller 소유 Uint8Array mutation과 독립적으로 봉인해야 한다");

function encode(cells: string[], charShapeIds: number[]): Uint8Array {
  return encoder.encode(JSON.stringify({
    cells,
    charShapeIds,
    bodyText: "fixture body",
    serializationNonce: 0,
    semanticInvalid: false,
  } satisfies Fixture));
}

function decode(bytes: Uint8Array): Fixture {
  return JSON.parse(decoder.decode(bytes)) as Fixture;
}

function semanticFixture(fixture: Fixture): Omit<Fixture, "serializationNonce"> {
  return {
    cells: fixture.cells,
    charShapeIds: fixture.charShapeIds,
    bodyText: fixture.bodyText,
    semanticInvalid: fixture.semanticInvalid,
  };
}

async function semanticSha(bytes: Uint8Array): Promise<string> {
  const document = new rhwp.HwpDocument(bytes);
  try {
    return await studioFieldDocumentSemanticSha256(document);
  } finally {
    document.free();
  }
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
