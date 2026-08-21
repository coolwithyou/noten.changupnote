import assert from "node:assert/strict";
import type { RhwpDocument } from "./client";
import {
  matchesStudioFieldDocumentPreimage,
  studioFieldDocumentSemanticSha256,
} from "./studioFieldDocumentManifest";

interface Fixture {
  serializationNonce: string;
  value: string;
  charShapeId: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeDocument {
  private readonly fixture: Fixture;
  constructor(bytes: Uint8Array) {
    this.fixture = JSON.parse(decoder.decode(bytes)) as Fixture;
  }
  pageCount() { return 1; }
  getSectionCount() { return 1; }
  getParagraphCount() { return 1; }
  getDocumentInfo() { return JSON.stringify({ format: "hwp", version: 1 }); }
  getParagraphLength() { return 1; }
  getTextRange() { return "\u0010"; }
  getControlTextPositions() { return "[0]"; }
  getParaPropertiesAt() { return JSON.stringify({ paraShapeId: 9 }); }
  getStyleAt() { return JSON.stringify({ id: 0 }); }
  getCharPropertiesAt() { return JSON.stringify({ charShapeId: 7 }); }
  getFieldList() { return "[]"; }
  getPageControlLayout() {
    return JSON.stringify({ controls: [{ type: "table", secIdx: 0, paraIdx: 0, controlIdx: 0 }] });
  }
  getTableDimensions() { return JSON.stringify({ rowCount: 1, colCount: 1, cellCount: 1 }); }
  getCellParagraphCount() { return 1; }
  getCellParagraphLength() { return Array.from(this.fixture.value).length; }
  getTextInCell() { return this.fixture.value; }
  getCellCharPropertiesAt() { return JSON.stringify({ charShapeId: this.fixture.charShapeId, textColor: "#000000" }); }
  getCellParaPropertiesAt() { return JSON.stringify({ paraShapeId: 9, align: "left" }); }
  getCellOwnProperties() { return JSON.stringify({ borderFillId: 2 }); }
  free() {}
}

function documentFor(fixture: Fixture): RhwpDocument {
  return new FakeDocument(encoder.encode(JSON.stringify(fixture))) as unknown as RhwpDocument;
}

const original = documentFor({ serializationNonce: "first", value: "같은 내용", charShapeId: 7 });
const reserialized = documentFor({ serializationNonce: "second", value: "같은 내용", charShapeId: 7 });
const edited = documentFor({ serializationNonce: "third", value: "바뀐 내용", charShapeId: 7 });
const restyled = documentFor({ serializationNonce: "fourth", value: "같은 내용", charShapeId: 8 });

const originalSha = await studioFieldDocumentSemanticSha256(original);
assert.equal(await studioFieldDocumentSemanticSha256(reserialized), originalSha,
  "컨테이너 재직렬화 메타데이터만 달라진 문서는 같은 의미 SHA를 가져야 한다");
assert.notEqual(await studioFieldDocumentSemanticSha256(edited), originalSha,
  "표 셀 값 변경은 의미 SHA에서 감지해야 한다");
assert.notEqual(await studioFieldDocumentSemanticSha256(restyled), originalSha,
  "표 셀 서식 변경은 의미 SHA에서 감지해야 한다");

assert.equal(matchesStudioFieldDocumentPreimage({
  currentDocumentSha256: "same-bytes",
  currentSemanticSha256: "changed-semantics",
  expectedDocumentSha256: "same-bytes",
  expectedSemanticSha256: "expected-semantics",
}), true, "동일한 원본 바이트는 그대로 허용해야 한다");
assert.equal(matchesStudioFieldDocumentPreimage({
  currentDocumentSha256: "reserialized-bytes",
  currentSemanticSha256: originalSha,
  expectedDocumentSha256: "server-bytes",
  expectedSemanticSha256: originalSha,
}), true, "바이트가 재직렬화됐어도 전체 문서 의미가 같으면 허용해야 한다");
assert.equal(matchesStudioFieldDocumentPreimage({
  currentDocumentSha256: "reserialized-bytes",
  currentSemanticSha256: "changed-semantics",
  expectedDocumentSha256: "server-bytes",
  expectedSemanticSha256: originalSha,
}), false, "문서 의미가 바뀌면 적용을 거부해야 한다");
assert.equal(matchesStudioFieldDocumentPreimage({
  currentDocumentSha256: "reserialized-bytes",
  currentSemanticSha256: originalSha,
  expectedDocumentSha256: "server-bytes",
  expectedSemanticSha256: null,
}), false, "의미 SHA가 없는 과거 제안은 바이트 불일치 시 fail-closed해야 한다");

console.log("Studio field document semantic manifest tests passed");
