import assert from "node:assert/strict";
import { loadDocumentAgentCore } from "@/lib/server/rhwp/documentAgentCore";
import { sha256Hex } from "./documentAgentContract";
import { extractDocumentEditCandidates } from "./documentAgentCandidates";
import { assertDocumentAgentManifestsEqual, buildDocumentAgentSemanticManifest } from "./documentAgentManifest";
import {
  applyDocumentAgentEdit,
  reloadVerifiedDocumentAgentBytes,
  undoDocumentAgentEdit,
} from "./documentAgentTransaction";
import type { RhwpDocument, RhwpDocumentFormat, RhwpModule } from "./client";

const rhwp = await loadDocumentAgentCore();
assert.equal(await loadDocumentAgentCore(), rhwp, "Node RHWP loader는 같은 initialized singleton을 반환해야 합니다.");

for (const format of ["hwp", "hwpx"] as const) {
  const fixture = createFixtureBytes(rhwp, format);
  const fixtureSha256 = await sha256Hex(fixture);
  const source = new rhwp.HwpDocument(fixture);
  const candidates = await extractDocumentEditCandidates({
    document: source,
    sourceKey: `fixture:${format}`,
    documentSha256: fixtureSha256,
    selectedPage: 1,
    reservedAnchors: [],
  });
  source.free();

  assert.ok(candidates.length >= 1, `${format} fixture에서 안전 본문 후보를 하나 이상 찾아야 합니다.`);
  assert.equal(candidates.some((candidate) => candidate.beforeText.includes("혼합 서식")), false);
  assert.equal(candidates.some((candidate) => candidate.beforeText.includes("필드 포함")), false);
  const candidate = candidates.find((entry) => entry.beforeText.includes("마지막 안전 문단"));
  assert.ok(candidate, `${format} fixture의 적용 target이 있어야 합니다.`);

  const replacement = "시장 진입 경로와 실행 일정을 근거 중심으로 제시합니다.";
  const applied = await applyDocumentAgentEdit({
    rhwp,
    bytes: fixture,
    format,
    reservedAnchors: [],
    command: { schemaVersion: "document-agent-v1", candidate, replacement },
  });
  assert.notEqual(applied.afterDocumentSha256, fixtureSha256);
  assert.equal(applied.beforeManifest.pageCount, applied.afterManifest.pageCount);

  const appliedDocument = new rhwp.HwpDocument(applied.bytes);
  try {
    assert.equal(
      appliedDocument.getTextRange(
        candidate.anchor.section,
        candidate.anchor.paragraph,
        0,
        appliedDocument.getParagraphLength(candidate.anchor.section, candidate.anchor.paragraph),
      ),
      replacement,
    );
  } finally {
    appliedDocument.free();
  }

  const withOutsideEdit = await addOutsideManualEdit(rhwp, applied.bytes, format, "검증 메모");
  const undone = await undoDocumentAgentEdit({
    rhwp,
    bytes: withOutsideEdit,
    format,
    reservedAnchors: [],
    command: { schemaVersion: "document-agent-v1", candidate, afterText: replacement },
  });
  const undoneDocument = new rhwp.HwpDocument(undone.bytes);
  try {
    assert.equal(
      undoneDocument.getTextRange(
        candidate.anchor.section,
        candidate.anchor.paragraph,
        0,
        undoneDocument.getParagraphLength(candidate.anchor.section, candidate.anchor.paragraph),
      ),
      candidate.beforeText,
    );
    assert.match(
      undoneDocument.getTextRange(0, 0, 0, undoneDocument.getParagraphLength(0, 0)),
      /검증 메모/u,
      "Undo는 target 밖 수동 편집을 보존해야 합니다.",
    );
  } finally {
    undoneDocument.free();
  }
}

const calls: string[] = [];
let committed = "before";
const after = new Uint8Array([2]);
const before = new Uint8Array([1]);
const committedResult = await reloadVerifiedDocumentAgentBytes({
  editor: { loadFile: async (bytes) => { calls.push(`load:${bytes[0]}`); } },
  beforeBytes: before,
  afterBytes: after,
  filename: "fixture.hwp",
  verifyLoadedBytes: async (bytes) => { calls.push(`verify:${bytes[0]}`); },
  commitWorkingRefs: (bytes) => { calls.push(`commit:${bytes[0]}`); committed = "after"; },
});
assert.deepEqual(committedResult, { kind: "committed" });
assert.deepEqual(calls, ["load:2", "verify:2", "commit:2"]);
assert.equal(committed, "after");

calls.length = 0;
committed = "before";
const rolledBack = await reloadVerifiedDocumentAgentBytes({
  editor: { loadFile: async (bytes) => { calls.push(`load:${bytes[0]}`); } },
  beforeBytes: before,
  afterBytes: after,
  filename: "fixture.hwp",
  verifyLoadedBytes: async (bytes) => {
    calls.push(`verify:${bytes[0]}`);
    if (bytes[0] === 2) throw new Error("after verification failed");
  },
  commitWorkingRefs: () => { committed = "after"; },
});
assert.equal(rolledBack.kind, "rolled_back");
assert.deepEqual(calls, ["load:2", "verify:2", "load:1", "verify:1"]);
assert.equal(committed, "before");

console.log("document agent HWP/HWPX transaction tests passed");

function createFixtureBytes(rhwpModule: RhwpModule, format: RhwpDocumentFormat): Uint8Array {
  const document = rhwpModule.HwpDocument.createEmpty();
  try {
    document.createBlankDocument();
    assertOk(document.insertText(0, 0, 0, "사업 계획의 시장성과 실행 전략을 구체적으로 작성합니다."));
    appendParagraph(document, "혼합 서식 문단은 후보에서 제외합니다.");
    assertOk(document.applyCharFormat(0, 1, 0, 2, JSON.stringify({ bold: true })));
    appendParagraph(document, "필드 포함 문단은 후보에서 제외합니다.");
    assertOk(document.insertClickHereField(0, 2, 1, "입력", "", "fixture-field", true));
    appendParagraph(document, "마지막 안전 문단은 target 밖 편집 보존을 검증합니다.");
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

async function addOutsideManualEdit(
  rhwpModule: RhwpModule,
  bytes: Uint8Array,
  format: RhwpDocumentFormat,
  suffix: string,
): Promise<Uint8Array> {
  const document = new rhwpModule.HwpDocument(bytes);
  try {
    const paragraph = 0;
    const length = document.getParagraphLength(0, paragraph);
    assertOk(document.insertText(0, paragraph, length, ` ${suffix}`));
    const exported = format === "hwp" ? document.exportHwp() : document.exportHwpx();
    const reopened = new rhwpModule.HwpDocument(exported);
    try {
      const [beforeManifest, afterManifest] = await Promise.all([
        buildDocumentAgentSemanticManifest(document),
        buildDocumentAgentSemanticManifest(reopened),
      ]);
      assertDocumentAgentManifestsEqual(beforeManifest, afterManifest);
    } finally {
      reopened.free();
    }
    return exported;
  } finally {
    document.free();
  }
}

function assertOk(value: string): void {
  const parsed = JSON.parse(value) as { ok?: unknown };
  assert.equal(parsed.ok, true);
}
