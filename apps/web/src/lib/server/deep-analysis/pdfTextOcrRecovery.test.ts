import assert from "node:assert/strict";
import {
  buildPdfPageOcrMarkdown,
  normalizePdfTextLayout,
} from "./pdfTextOcrRecovery";

assert.equal(
  normalizePdfTextLayout("첫 페이지  \n본문\f둘째 페이지\n"),
  "## Page 1\n\n첫 페이지\n본문\n\n## Page 2\n\n둘째 페이지",
);

const ocr = await buildPdfPageOcrMarkdown({
  title: "공고.pdf",
  images: [
    { page: 1, body: Buffer.from("one"), contentType: "image/png" },
    { page: 2, body: Buffer.from("two"), contentType: "image/png" },
  ],
  imageOcr: async ({ body }) => ({
    markdown: body.toString() === "one"
      ? "첫 페이지에서 충분히 추출한 공고 텍스트입니다."
      : "둘째 페이지에서 충분히 추출한 공고 텍스트입니다.",
    confidence: body.toString() === "one" ? 0.8 : 0.9,
    provider: "test",
    converter: "test",
  }),
});
assert.match(ocr.markdown, /## Page 1/);
assert.match(ocr.markdown, /## Page 2/);
assert(Math.abs(ocr.averageConfidence - 0.85) < Number.EPSILON);

await assert.rejects(
  buildPdfPageOcrMarkdown({
    title: "공고.pdf",
    images: [{ page: 1, body: Buffer.from("low"), contentType: "image/png" }],
    imageOcr: async () => ({
      markdown: "충분히 길지만 confidence가 낮은 OCR 결과입니다.",
      confidence: 0.59,
      provider: "test",
      converter: "test",
    }),
  }),
  /confidence 0.590 is below 0.600/,
);

console.log("deep-analysis PDF text/OCR recovery tests passed");
