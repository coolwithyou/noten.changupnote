export async function downloadAttachmentWithLimit(url: string, maxBytes: number): Promise<{
  body: Buffer;
  contentType: string | null;
}> {
  const response = await fetch(url, { headers: { accept: "*/*" } });
  if (!response.ok) throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Attachment exceeds ${maxBytes} bytes`);
  if (!response.body) throw new Error("Attachment response body is empty");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Attachment exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new Error("Attachment download produced an empty file");
  return {
    body: Buffer.concat(chunks, total),
    contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || null,
  };
}
