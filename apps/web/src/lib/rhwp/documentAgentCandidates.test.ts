import assert from "node:assert/strict";
import { sha256Hex } from "./documentAgentContract";
import {
  DocumentAgentCandidateScanError,
  extractDocumentEditCandidates,
  reservedAnchorsFromExactResolutions,
  type DocumentAgentCandidateDocument,
} from "./documentAgentCandidates";

const texts = [
  "안전한 사업 계획 문단입니다.",
  "혼합 서식 문단입니다.",
  "본문 컨트롤 문단입니다.",
  "대표자 서명 문단입니다.",
  "필드 포함 문단입니다.",
];

function fakeDocument(options: {
  pages?: number[];
  malformedRectsAt?: number;
  fieldAtParagraphEnd?: number;
} = {}): DocumentAgentCandidateDocument {
  const pages = options.pages ?? texts.map(() => 0);
  return {
    pageCount: () => 2,
    getSectionCount: () => 1,
    getParagraphCount: () => texts.length,
    getParagraphLength: (_section, paragraph) => texts[paragraph]!.length,
    getTextRange: (_section, paragraph, offset, count) => texts[paragraph]!.slice(offset, offset + count),
    getCursorRect: (_section, paragraph) => JSON.stringify({
      pageIndex: pages[paragraph], x: 10, y: 20 + paragraph * 10, height: 12,
    }),
    getSelectionRects: (_section, paragraph) => JSON.stringify([{
      pageIndex: pages[paragraph], x: 10, y: 20 + paragraph * 10, width: 120, height: 12,
      ...(options.malformedRectsAt === paragraph ? { unexpected: true } : {}),
    }]),
    getControlTextPositions: (_section, paragraph) => JSON.stringify(paragraph === 2 ? [1] : []),
    getFieldInfoAt: (_section, paragraph, offset) => JSON.stringify(paragraph === 4
      || (options.fieldAtParagraphEnd === paragraph && offset === texts[paragraph]!.length)
      ? { inField: true, fieldId: 1, startCharIdx: 0, endCharIdx: 1 }
      : { inField: false }),
    getCharPropertiesAt: (_section, paragraph, offset) => JSON.stringify({
      charShapeId: paragraph === 1 && offset > 0 ? 1 : 0,
      bold: paragraph === 1 && offset > 0,
    }),
    getParaPropertiesAt: () => JSON.stringify({ paraShapeId: 0, alignment: "justify" }),
    getStyleAt: () => JSON.stringify({ id: 0, name: "본문" }),
  };
}

const documentSha256 = await sha256Hex("fake-document");
const candidates = await extractDocumentEditCandidates({
  document: fakeDocument(),
  sourceKey: "fixture:fake",
  documentSha256,
  selectedPage: 1,
  reservedAnchors: [],
});
assert.deepEqual(candidates.map((candidate) => candidate.beforeText), [texts[0]]);

const reserved = await extractDocumentEditCandidates({
  document: fakeDocument(),
  sourceKey: "fixture:fake",
  documentSha256,
  selectedPage: 1,
  reservedAnchors: [{
    fieldId: "reserved",
    target: { kind: "cell", section: 0, parentPara: 0, controlIndex: 0, cellIndex: 1, cellParagraph: 0 },
  }],
});
assert.deepEqual(reserved, []);

const malformed = await extractDocumentEditCandidates({
  document: fakeDocument({ malformedRectsAt: 0 }),
  sourceKey: "fixture:fake",
  documentSha256,
  selectedPage: 1,
  reservedAnchors: [],
});
assert.deepEqual(malformed, []);

const endpointField = await extractDocumentEditCandidates({
  document: fakeDocument({ fieldAtParagraphEnd: 0 }),
  sourceKey: "fixture:fake",
  documentSha256,
  selectedPage: 1,
  reservedAnchors: [],
});
assert.deepEqual(endpointField, [], "문단 끝 field anchor도 Studio command와 같이 후보에서 제외해야 합니다.");

await assert.rejects(
  extractDocumentEditCandidates({
    document: fakeDocument({ pages: [1, 0, 0, 0, 0] }),
    sourceKey: "fixture:fake",
    documentSha256,
    selectedPage: 2,
    reservedAnchors: [],
  }),
  (error) => error instanceof DocumentAgentCandidateScanError && error.code === "non_monotonic_layout",
);

assert.throws(
  () => reservedAnchorsFromExactResolutions([{
    fieldId: "ambiguous",
    status: "ambiguous",
    candidateCount: 2,
  }]),
  (error) => error instanceof DocumentAgentCandidateScanError && error.code === "reserved_anchor_unresolved",
);

console.log("document agent candidate tests passed");
