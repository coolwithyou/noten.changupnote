import assert from "node:assert/strict";
import { readWritingBody } from "./writingRequest";
assert.deepEqual(await readWritingBody(new Request("http://localhost", { method: "POST", body: JSON.stringify({ text: "한글" }) })), { text: "한글" });
await assert.rejects(() => readWritingBody(new Request("http://localhost", { method: "POST", body: "{" })), { status: 422 });
await assert.rejects(() => readWritingBody(new Request("http://localhost", { method: "POST", body: "한".repeat(60000) })), { status: 413 });
console.log("PASS: writing request checks actual UTF-8 byte size and malformed JSON");
