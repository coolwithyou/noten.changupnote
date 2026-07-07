export function markdownDownloadResponse(input: {
  markdown: string;
  filename: string;
  fallbackFilename: string;
}): Response {
  return textDownloadResponse({
    body: input.markdown,
    filename: input.filename,
    fallbackFilename: input.fallbackFilename,
    contentType: "text/markdown; charset=utf-8",
  });
}

export function textDownloadResponse(input: {
  body: string;
  filename: string;
  fallbackFilename: string;
  contentType: string;
}): Response {
  return new Response(input.body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": contentDisposition(input.filename, input.fallbackFilename),
      "content-type": input.contentType,
    },
  });
}

export function binaryDownloadResponse(input: {
  body: Uint8Array;
  filename: string;
  fallbackFilename: string;
  contentType: string;
  extraHeaders?: Record<string, string>;
}): Response {
  const body = new ArrayBuffer(input.body.byteLength);
  new Uint8Array(body).set(input.body);
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-disposition": contentDisposition(input.filename, input.fallbackFilename),
      "content-type": input.contentType,
      ...(input.extraHeaders ?? {}),
    },
  });
}

export function sanitizeDownloadFilename(value: string, fallback: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || fallback;
}

function contentDisposition(filename: string, fallback: string): string {
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}
