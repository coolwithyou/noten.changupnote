import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptWritingPdf, encryptWritingPdf, extractWritingPdf, writingPdfEncryptionKey, WRITING_PDF_MAX_BYTES } from "./writingPdfBytes";
import { syntheticWritingPdf } from "./writingPdf.test-fixture";

async function main() {
  const key = randomBytes(32), bytes = syntheticWritingPdf();
  assert.throws(() => writingPdfEncryptionKey({}));
  assert.throws(() => writingPdfEncryptionKey({ CUNOTE_WRITING_SOURCE_KEY_BASE64: "test" }));
  assert.deepEqual(writingPdfEncryptionKey({ CUNOTE_WRITING_SOURCE_KEY_BASE64: key.toString("base64") }), key);
  const encrypted = encryptWritingPdf(bytes, key, "company-a:draft-a");
  assert.equal(encrypted.includes(Buffer.from("Company planning")), false);
  assert.deepEqual(decryptWritingPdf(encrypted, key, "company-a:draft-a"), bytes);
  assert.throws(() => decryptWritingPdf(encrypted, key, "company-b:draft-a"));
  assert.throws(() => decryptWritingPdf(encrypted, randomBytes(32), "company-a:draft-a"));
  const damaged = Buffer.from(encrypted); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
  assert.throws(() => decryptWritingPdf(damaged, key, "company-a:draft-a"));
  const extracted = await extractWritingPdf(bytes);
  assert.equal(extracted.pages, 1); assert.match(extracted.text, /\[page 1\]\nCompany planning fixture/u);
  await assert.rejects(() => extractWritingPdf(Buffer.alloc(WRITING_PDF_MAX_BYTES + 1)), { code: "writing_pdf_too_large" });
  await assert.rejects(() => extractWritingPdf(Buffer.from("not PDF")), { code: "writing_pdf_invalid" });
  await assert.rejects(() => extractWritingPdf(Buffer.from("%PDF-1.4\ninvalid")), { code: "writing_pdf_extraction_failed" });
  await assert.rejects(() => extractWritingPdf(syntheticWritingPdf(31)), /30쪽/u);
  await assert.rejects(() => extractWritingPdf(syntheticWritingPdf(1, "")), /텍스트가 없는/u);
  const active = [extractWritingPdf(bytes), extractWritingPdf(bytes)];
  await assert.rejects(() => extractWritingPdf(bytes), { code: "writing_pdf_busy" });
  await Promise.all(active);
  console.log("PASS: encrypted PDF original authentication/tamper/context isolation and real PDF.js child-process extraction, byte/page/textless/invalid limits (synthetic PDFs, no provider)");
}
void main();
