import { WritingContextError } from "./writingContext";

/** Content-Length가 없는 요청도 실제 읽은 바이트를 제한한다. */
export async function readWritingBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new WritingContextError("invalid_writing_input", "입력 내용이 필요합니다.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 150_000) {
        await reader.cancel();
        throw new WritingContextError("writing_input_too_large", "입력 자료가 너무 큽니다.", 413);
      }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new WritingContextError("invalid_writing_input", "입력 형식을 확인해 주세요."); }
  } finally { reader.releaseLock(); }
}
