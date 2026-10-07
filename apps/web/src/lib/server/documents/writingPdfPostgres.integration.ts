import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type postgres from "postgres";
import type { CompanyAccess } from "../auth/companyGuard";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import { createWritingPdfSource, readWritingPdfSource } from "./writingPdfSources";
import { readWritingSource, withdrawWritingSource } from "./writingContext";
import { syntheticWritingPdf } from "./writingPdf.test-fixture";
import { writingPdfSha256 } from "./writingPdfBytes";

export async function verifyWritingPdfPostgres(input: { admin: postgres.Sql; access: CompanyAccess; draftId: string; nextDraft: string }) {
  const objects = new Map<string, Buffer>();
  const storage: R2ObjectStorage = {
    async putObject(input) { objects.set(input.key, Buffer.from(input.body)); return { key: input.key, url: `https://invalid.test/${input.key}` }; },
    async getObjectBytes(key) { return { body: objects.get(key)!, contentType: "application/octet-stream" }; },
    async objectExists(key) { return objects.has(key); },
    async getObjectText() { throw new Error("plaintext access prohibited"); },
    publicUrl() { throw new Error("public URL prohibited"); },
    async presignGetUrl() { throw new Error("presigned URL prohibited"); },
  };
  const deps = { storage, encryptionKey: randomBytes(32) };
  const context = { access: input.access, draftId: input.draftId };
  const bytes = syntheticWritingPdf();
  const metadata = { requestId: crypto.randomUUID(), title: "합성 회사 PDF", filename: "fixture.pdf", scope: "application", observedDate: null };
  const source = await createWritingPdfSource({ ...context, metadata, bytes }, deps);
  assert.deepEqual(source.originalPdf, { filename: "fixture.pdf", pages: 1, sha256: writingPdfSha256(bytes) });
  assert.equal(JSON.stringify(source).includes("storageKey"), false);
  assert.equal([...objects.values()][0]!.includes(Buffer.from("Company planning")), false);
  assert.deepEqual((await readWritingPdfSource({ ...context, sourceId: source.id }, deps)).bytes, bytes);
  assert.match((await readWritingSource({ ...context, sourceId: source.id })).content, /Company planning/u);
  assert.equal((await createWritingPdfSource({ ...context, metadata, bytes }, deps)).id, source.id);
  assert.equal(objects.size, 1, "같은 파일 재시도는 별도 보관본을 만들지 않는다");
  await assert.rejects(() => createWritingPdfSource({ ...context, metadata: { ...metadata, filename: "different.pdf" }, bytes }, deps), { code: "writing_request_conflict" });
  await assert.rejects(() => readWritingPdfSource({ ...context, draftId: input.nextDraft, sourceId: source.id }, deps), { status: 404 });
  await assert.rejects(() => readWritingPdfSource({ ...context, sourceId: source.id }, { ...deps, encryptionKey: randomBytes(32) }), { code: "writing_pdf_key_unavailable" });
  const shared = await createWritingPdfSource({ ...context, metadata: { ...metadata, requestId: crypto.randomUUID(), scope: "company" }, bytes }, deps);
  assert.deepEqual((await readWritingPdfSource({ ...context, draftId: input.nextDraft, sourceId: shared.id }, deps)).bytes, bytes);
  await assert.rejects(() => input.admin`update company_writing_sources set original_pdf='{}' where id=${source.id}`);
  const firstKey = [...objects.keys()][0]!;
  const originalEncrypted = objects.get(firstKey)!;
  const corrupt = Buffer.from(originalEncrypted); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1; objects.set(firstKey, corrupt);
  await assert.rejects(() => readWritingPdfSource({ ...context, sourceId: source.id }, deps), { code: "writing_pdf_integrity_failed" });
  objects.set(firstKey, originalEncrypted);
  await assert.rejects(() => readWritingPdfSource({ ...context, sourceId: source.id }, { ...deps, storage: { ...storage,
    async getObjectBytes(key) { const result = await storage.getObjectBytes(key); await withdrawWritingSource({ ...context, sourceId: source.id }); return result; },
  } }), { status: 404 });
  await withdrawWritingSource({ ...context, sourceId: shared.id });
  await assert.rejects(() => readWritingPdfSource({ ...context, sourceId: shared.id }, deps), { status: 404 });
  console.log("PASS: PDF -> real extractor -> encrypted memory object -> immutable DB source -> authenticated exact original reopen; retry, per-application/shared scope, integrity and withdrawal (no R2/provider call)");
}
