import assert from "node:assert/strict";
import type { IRBlock } from "kordoc";
import type { RhwpDocument, RhwpDocumentFormat, RhwpModule } from "@/lib/rhwp/client";
import { loadDocumentAgentCore } from "@/lib/server/rhwp/documentAgentCore";
import { extractContextualRoundtripFields } from "./editable-regions";
import { verifyRoundtripParagraphFieldBindings } from "./native-paragraph-bindings";

const sourceBlocks: IRBlock[] = [
  { type: "paragraph", text: "가. 기업체명 :", pageNumber: 1 },
  { type: "paragraph", text: "나. 존재하지 않는 항목 :", pageNumber: 1 },
];
const rhwp = await loadDocumentAgentCore();
for (const format of ["hwp", "hwpx"] as const) {
  const fields = extractContextualRoundtripFields(sourceBlocks, "a".repeat(64));
  assert.equal(fields.length, 2);
  const result = await verifyRoundtripParagraphFieldBindings({
    body: createFixture(rhwp, format),
    fields,
  });
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.rejectedCount, 1);
  assert.equal(fields[0]?.recommendedInput, true);
  assert.ok(fields[0]?.inputSignals.includes("RHWP native 문단 exact binding 확인"));
  assert.equal(fields[1]?.recommendedInput, false);
  assert.ok(fields[1]?.inputSignals.some(signal => signal.includes("안전 제외")));
}

console.log("application-roundtrip native paragraph binding tests: ok");

function createFixture(rhwpModule: RhwpModule, format: RhwpDocumentFormat): Uint8Array {
  const document = rhwpModule.HwpDocument.createEmpty();
  try {
    document.createBlankDocument();
    assertOk(document.insertText(0, 0, 0, "사업계획서"));
    appendParagraph(document, "  가. 기업체명 :");
    return format === "hwp" ? document.exportHwp() : document.exportHwpx();
  } finally {
    document.free();
  }
}

function appendParagraph(document: RhwpDocument, text: string): void {
  const current = document.getParagraphCount(0) - 1;
  assertOk(document.splitParagraph(0, current, document.getParagraphLength(0, current)));
  assertOk(document.insertText(0, current + 1, 0, text));
}

function assertOk(value: string): void {
  assert.equal((JSON.parse(value) as { ok?: boolean }).ok, true);
}
