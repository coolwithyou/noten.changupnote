import assert from "node:assert/strict";
import {
  parsePaddleStructureImageOcrResponse,
  recognizeImageWithPaddleOcr,
} from "./paddleOcrImage";
import { parseGrantImageOcrProvider, resolveGrantImageOcrAdapter } from "./grantImageOcrProviders";

const parsed = parsePaddleStructureImageOcrResponse({
  result: {
    layoutParsingResults: [{
      markdown: { text: "# 지원대상\n중소기업\n![ignored](images/1.png)" },
      prunedResult: {
        overall_ocr_res: {
          rec_texts: ["지원대상", "중소기업"],
          rec_scores: [0.91, 0.87],
        },
      },
    }],
  },
});
assert.equal(parsed.provider, "paddleocr_ppstructurev3");
assert.equal(parsed.converter, "paddleocr-ppstructurev3-http-v1/unspecified");
assert.equal(parsed.confidence, 0.89);
assert.equal(parsed.lineCount, 2);
assert.doesNotMatch(parsed.markdown, /ignored/);

const fallback = parsePaddleStructureImageOcrResponse({
  result: {
    layoutParsingResults: [{
      markdown: { text: "신청기간 7월" },
      prunedResult: { table_res_list: [{ table_ocr_pred: { rec_scores: [0.7, 0.9] } }] },
    }],
  },
});
assert.equal(fallback.confidence, 0.8);

const unscored = parsePaddleStructureImageOcrResponse({
  result: { layoutParsingResults: [{ markdown: { text: "점수 없는 텍스트" }, prunedResult: {} }] },
});
assert.equal(unscored.confidence, 0, "confidence가 없으면 만들어내지 않고 archive gate에서 실패시킨다");
assert.throws(() => parsePaddleStructureImageOcrResponse({ result: {} }), /layoutParsingResults/);
assert.throws(() => parsePaddleStructureImageOcrResponse({
  result: { layoutParsingResults: [{ markdown: { text: "" } }] },
}), /no markdown text/);

let requestBody: Record<string, unknown> = {};
const response = await recognizeImageWithPaddleOcr({
  filename: "poster.png",
  body: Buffer.from("image"),
  serverUrl: "http://127.0.0.1:8080/layout-parsing",
  fetchImpl: async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      result: {
        layoutParsingResults: [{
          markdown: { text: "지원금 1억원" },
          prunedResult: { overall_ocr_res: { rec_scores: [0.95], rec_texts: ["지원금 1억원"] } },
        }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  },
});
assert.equal(response.confidence, 0.95);
assert.equal(requestBody?.returnMarkdownImages, false);
assert.equal(requestBody?.visualize, false);
assert.equal(requestBody?.fileType, 1);

await assert.rejects(() => recognizeImageWithPaddleOcr({
  filename: "poster.png",
  body: Buffer.from("image"),
  serverUrl: "file:///tmp/paddle",
  fetchImpl: fetch,
}), /http or https/);
await assert.rejects(() => recognizeImageWithPaddleOcr({
  filename: "poster.png",
  body: Buffer.alloc(20 * 1024 * 1024 + 1),
  serverUrl: "http://127.0.0.1:8080",
  fetchImpl: fetch,
}), /exceeds 20 MiB/);

assert.equal(parseGrantImageOcrProvider("paddleocr"), "paddleocr");
assert.throws(() => parseGrantImageOcrProvider("unknown"), /Invalid imageOcr/);
const previousServerUrl = process.env.PADDLEOCR_SERVER_URL;
delete process.env.PADDLEOCR_SERVER_URL;
assert.throws(() => resolveGrantImageOcrAdapter("paddleocr"), /requires PADDLEOCR_SERVER_URL/);
if (previousServerUrl === undefined) delete process.env.PADDLEOCR_SERVER_URL;
else process.env.PADDLEOCR_SERVER_URL = previousServerUrl;

console.log("paddleocr-image: ok");
