import assert from "node:assert/strict";
import { loadDocumentAgentCore } from "@/lib/server/rhwp/documentAgentCore";
import type { RhwpDocumentFormat, RhwpModule } from "./client";
import { collectStudioFieldEvidence } from "./studioFieldAgentTransaction";
import { resolveStudioFieldBindings } from "./studioFieldBindings";

const rhwp = await loadDocumentAgentCore();

for (const format of ["hwp", "hwpx"] as const) {
  const original = createFormFixture(rhwp, format);
  const document = new rhwp.HwpDocument(original);
  const fields = JSON.parse(document.getFieldList()) as Array<{
    fieldId: number;
    name: string;
    location: { sectionIndex: number; paraIndex: number };
  }>;
  const field = fields.find(entry => entry.name === "회사명");
  assert.ok(field, `${format} fixture의 회사명 누름틀이 있어야 합니다.`);
  const [resolution] = resolveStudioFieldBindings(document, [{
    fieldId: "connected-company-name",
    fieldKey: "회사명",
    label: "상호명",
    fieldType: "text",
  }]);
  assert.deepEqual(resolution, {
    fieldId: "connected-company-name",
    status: "unique",
    target: {
      kind: "form_text",
      section: field.location.sectionIndex,
      paragraph: field.location.paraIndex,
      fieldId: field.fieldId,
    },
    candidateCount: 1,
  });
  assert.equal(document.pageCount(), 1);
  document.free();

  assert.equal(resolution?.status, "unique");
  if (resolution?.status !== "unique") continue;
  const before = await collectStudioFieldEvidence(rhwp, original, resolution.target);
  assert.equal(before.text, "");

  const appliedDocument = new rhwp.HwpDocument(original);
  const setResult = JSON.parse(appliedDocument.setFieldValue(field.fieldId, "주식회사 노튼")) as { ok: boolean };
  assert.equal(setResult.ok, true);
  const applied = format === "hwp" ? appliedDocument.exportHwp() : appliedDocument.exportHwpx();
  assert.equal(appliedDocument.pageCount(), 1);
  appliedDocument.free();

  const after = await collectStudioFieldEvidence(rhwp, applied, resolution.target);
  assert.equal(after.text, "주식회사 노튼");
  assert.equal(after.formatSha256, before.formatSha256);
  assert.equal(after.adjacentContextSha256, before.adjacentContextSha256);

  const revertedDocument = new rhwp.HwpDocument(applied);
  const revertResult = JSON.parse(revertedDocument.setFieldValue(field.fieldId, "")) as { ok: boolean };
  assert.equal(revertResult.ok, true);
  const reverted = format === "hwp" ? revertedDocument.exportHwp() : revertedDocument.exportHwpx();
  revertedDocument.free();
  assert.deepEqual(await collectStudioFieldEvidence(rhwp, reverted, resolution.target), before);
}

console.log("Studio form_text HWP/HWPX evidence tests passed");

function createFormFixture(rhwpModule: RhwpModule, format: RhwpDocumentFormat): Uint8Array {
  const document = rhwpModule.HwpDocument.createEmpty();
  try {
    document.createBlankDocument();
    assertOk(document.insertText(0, 0, 0, "회사명: "));
    assertOk(document.insertClickHereField(0, 0, 5, "회사명을 입력하세요", "", "회사명", true));
    return format === "hwp" ? document.exportHwp() : document.exportHwpx();
  } finally {
    document.free();
  }
}

function assertOk(value: string): void {
  assert.equal((JSON.parse(value) as { ok?: boolean }).ok, true);
}
