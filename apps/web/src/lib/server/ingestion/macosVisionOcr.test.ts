import assert from "node:assert/strict";
import { parseMacosVisionOcrResponse } from "./macosVisionOcr";

const parsed = parseMacosVisionOcrResponse(JSON.stringify({
  text: "지원대상\n중소기업",
  averageConfidence: 0.91,
  lineCount: 2,
  lines: [
    { text: "지원대상", confidence: 0.9 },
    { text: "중소기업", confidence: 0.92 },
  ],
}));
assert.equal(parsed.provider, "macos_vision");
assert.equal(parsed.averageConfidence, 0.91);
assert.equal(parsed.lines.length, 2);
assert.throws(() => parseMacosVisionOcrResponse(JSON.stringify({ text: "", lines: [] })), /no text/);

console.log("macos-vision-ocr: ok");
