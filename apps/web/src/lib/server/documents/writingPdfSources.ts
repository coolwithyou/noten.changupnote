import { z } from "zod";
import { createWritingSourceSchema } from "@/lib/documents/writingContext";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "../db/client";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "../storage/r2ObjectStorage";
import { assertWritingDraftAccessInTransaction, createWritingSource, readWritingPdfReference, WritingContextError } from "./writingContext";
import { decryptWritingPdf, encryptWritingPdf, extractWritingPdf, writingPdfEncryptionKey, writingPdfSha256 } from "./writingPdfBytes";

const metadataSchema = createWritingSourceSchema.omit({ content: true, kind: true }).extend({
  filename: z.string().min(1).max(200).regex(/^[^/\\\u0000-\u001f\u007f]+\.pdf$/iu),
}).strict();
type Scope = { access: CompanyAccess; draftId: string };
type Dependencies = { storage?: R2ObjectStorage; encryptionKey?: Buffer; extract?: typeof extractWritingPdf };
function storageFor(deps: Dependencies) {
  const storage = deps.storage ?? createR2ObjectStorageFromEnv();
  if (!storage) throw new WritingContextError("writing_pdf_unavailable", "PDF 자료 보관 기능을 사용할 수 없습니다.", 503);
  return storage;
}
const encryptionContext = (companyId: string, draftId: string | null, requestId: string, sha: string) =>
  `cunote-writing-pdf-v1:${companyId}:${draftId ?? "company"}:${requestId}:${sha}`;

export async function createWritingPdfSource(input: Scope & { metadata: unknown; bytes: Buffer }, deps: Dependencies = {}) {
  const parsed = metadataSchema.safeParse(input.metadata);
  if (!parsed.success) throw new WritingContextError("invalid_writing_input", "PDF 파일명·자료 이름·기준일을 확인해 주세요.");
  const metadata = parsed.data;
  await withCunoteDbUser(getCunoteDb(), input.access.userId, tx => assertWritingDraftAccessInTransaction(tx, input.access, input.draftId, true));
  const key = deps.encryptionKey ?? writingPdfEncryptionKey();
  const storage = storageFor(deps);
  const extracted = await (deps.extract ?? extractWritingPdf)(input.bytes);
  const sha256 = writingPdfSha256(input.bytes);
  const context = encryptionContext(input.access.companyId, metadata.scope === "company" ? null : input.draftId, metadata.requestId, sha256);
  const keyId = writingPdfSha256(key);
  // 회사명·원본 파일명·평문을 public key/URL에 넣지 않는다. 암호문만 저장한다.
  const storageKey = `writing-private/v1/${input.access.companyId}/${keyId}/${writingPdfSha256(Buffer.from(context))}.bin`;
  const encrypted = encryptWritingPdf(input.bytes, key, context);
  await storage.putObject({ key: storageKey, body: encrypted, contentType: "application/octet-stream" });
  return createWritingSource({ access: input.access, draftId: input.draftId,
    body: { requestId: metadata.requestId, title: metadata.title, scope: metadata.scope, observedDate: metadata.observedDate,
      kind: "company_document", content: extracted.text },
    originalPdf: { storageKey, sha256, bytes: input.bytes.length, filename: metadata.filename, pages: extracted.pages, keyId },
  });
}

export async function readWritingPdfSource(input: Scope & { sourceId: string }, deps: Dependencies = {}) {
  const reference = await readWritingPdfReference(input);
  const key = deps.encryptionKey ?? writingPdfEncryptionKey();
  if (reference.original.keyId !== writingPdfSha256(key)) throw new WritingContextError("writing_pdf_key_unavailable", "이 원본 자료의 보관 키를 확인해야 합니다.", 503);
  const stored = await storageFor(deps).getObjectBytes(reference.original.storageKey);
  let bytes: Buffer;
  try {
    bytes = decryptWritingPdf(stored.body, key, encryptionContext(input.access.companyId, reference.draftId, reference.requestId, reference.original.sha256));
    if (bytes.length !== reference.original.bytes || writingPdfSha256(bytes) !== reference.original.sha256) throw new Error("original PDF mismatch");
  } catch { throw new WritingContextError("writing_pdf_integrity_failed", "원본 자료의 무결성을 확인하지 못했습니다.", 409); }
  // 저장소를 기다리는 동안 철회되거나 권한을 잃었으면 내용을 반환하지 않는다.
  await readWritingPdfReference(input);
  return { bytes, filename: reference.original.filename };
}
