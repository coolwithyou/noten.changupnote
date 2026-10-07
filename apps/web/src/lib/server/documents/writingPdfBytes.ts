import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WritingContextError } from "./writingContext";
import { WRITING_PDF_MAX_BYTES } from "@/lib/documents/writingContext";
export { WRITING_PDF_MAX_BYTES } from "@/lib/documents/writingContext";

const magic = Buffer.from("CUNOTE-PDF-1\n");
let activeExtractions = 0;
export function writingPdfEncryptionKey(env: Readonly<Record<string, string | undefined>> = process.env): Buffer {
  const value = env.CUNOTE_WRITING_SOURCE_KEY_BASE64?.trim() ?? "";
  const key = Buffer.from(value, "base64");
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value) || key.length !== 32 || key.toString("base64") !== value) {
    throw new WritingContextError("writing_pdf_unavailable", "PDF 자료 보관 기능을 사용할 수 없습니다.", 503);
  }
  return key;
}
export const writingPdfSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function encryptWritingPdf(bytes: Buffer, key: Buffer, context: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([magic, iv, cipher.getAuthTag(), ciphertext]);
}
export function decryptWritingPdf(bytes: Buffer, key: Buffer, context: string): Buffer {
  if (bytes.length < magic.length + 28 || !bytes.subarray(0, magic.length).equals(magic)) throw new Error("invalid encrypted PDF");
  const offset = magic.length;
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(offset, offset + 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(offset + 12, offset + 28));
  return Buffer.concat([decipher.update(bytes.subarray(offset + 28)), decipher.final()]);
}

// PDF를 별도 Node 프로세스에서 파싱해 요청 프로세스의 이벤트 루프를 막지 않는다.
// 사용자 바이트는 stdin으로만 전달하며 서비스 credentials/NODE_OPTIONS를 상속하지 않는다.
const workerBody = String.raw`
const { getDocument } = await import(process.argv[1]);
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > ${WRITING_PDF_MAX_BYTES}) throw Error('size'); chunks.push(chunk); }
  const doc = await getDocument({ data: new Uint8Array(Buffer.concat(chunks)), verbosity: 0,
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: true, maxImageSize: 0 }).promise;
  try {
    if (doc.numPages > 30) throw Error('pages');
    const texts = []; let length = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p); const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      if (!text) throw Error('no_text');
      const marked = '[page ' + p + ']\n' + text;
      length += marked.length + 2;
      if (length > 30000) throw Error('text_size');
      texts.push(marked); page.cleanup();
    }
    process.stdout.write(JSON.stringify({ text: texts.join('\n\n'), pages: doc.numPages }));
  } finally { await doc.destroy(); }
} catch (error) {
  process.stdout.write(JSON.stringify({ error: ['size','pages','no_text','text_size'].includes(error.message) ? error.message : 'invalid_pdf' }));
  process.exitCode = 1;
}
`;

export async function extractWritingPdf(bytes: Buffer): Promise<{ text: string; pages: number }> {
  if (bytes.length > WRITING_PDF_MAX_BYTES) throw new WritingContextError("writing_pdf_too_large", "PDF는 4MB 이내로 올려 주세요.", 413);
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new WritingContextError("writing_pdf_invalid", "PDF 파일을 확인해 주세요.");
  const rootApp = join(process.cwd(), "apps/web/package.json");
  const require = createRequire(existsSync(rootApp) ? rootApp : join(process.cwd(), "package.json"));
  const moduleUrl = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href;
  if (activeExtractions >= 2) throw new WritingContextError("writing_pdf_busy", "PDF 자료를 처리 중이에요. 잠시 뒤 다시 올려 주세요.", 429);
  activeExtractions++;
  return new Promise<{ text: string; pages: number }>((resolve, reject) => {
    const child = execFile(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", workerBody, moduleUrl],
      { env: { NODE_ENV: "production" }, timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 200_000 }, (error, stdout) => {
        let data: { text?: string; pages?: number; error?: string } = {};
        try { data = JSON.parse(stdout); } catch { /* 시간·메모리 상한에서 결과가 없으면 실패다. */ }
        if (error || !data.text || !Number.isSafeInteger(data.pages)) {
          const message = data.error === "no_text" ? "텍스트가 없는 페이지가 있어요. 스캔 PDF는 필요한 내용을 직접 붙여 넣어 주세요."
            : data.error === "pages" || data.error === "text_size" ? "PDF는 30쪽·추출 텍스트 30,000자 이내로 나누어 주세요."
              : "PDF 내용을 읽지 못했어요. 암호·손상 여부를 확인하거나 필요한 내용을 직접 붙여 넣어 주세요.";
          reject(new WritingContextError("writing_pdf_extraction_failed", message)); return;
        }
        resolve({ text: data.text, pages: data.pages! });
      });
    child.stdin?.on("error", () => { /* 자식의 조기 종료 결과는 execFile callback에서 처리한다. */ });
    child.stdin?.end(bytes);
  }).finally(() => { activeExtractions--; });
}
