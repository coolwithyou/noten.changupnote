import type { GrantImageOcrAdapter } from "./grantAttachmentArchive";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MARKDOWN_CHARS = 200_000;

export interface PaddleStructureImageOcrResult {
  markdown: string;
  confidence: number;
  provider: "paddleocr_ppstructurev3";
  converter: string;
  lineCount: number;
}

export function paddleOcrServerUrl(): string {
  return process.env.PADDLEOCR_SERVER_URL?.trim() ?? "";
}

export function paddleOcrEngineVersion(): string {
  const value = process.env.PADDLEOCR_ENGINE_VERSION?.trim();
  return value && /^[A-Za-z0-9._:+/-]{1,80}$/.test(value) ? value : "unspecified";
}

export async function recognizeImageWithPaddleOcr(input: {
  filename: string;
  body: Buffer;
  contentType?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  serverUrl?: string;
}): Promise<PaddleStructureImageOcrResult> {
  if (input.body.length === 0) throw new Error("PaddleOCR image is empty");
  if (input.body.length > MAX_IMAGE_BYTES) throw new Error("PaddleOCR image exceeds 20 MiB");
  const url = input.serverUrl?.trim() || paddleOcrServerUrl();
  if (!url) throw new Error("paddleocr: PADDLEOCR_SERVER_URL is not configured");
  assertHttpUrl(url);
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 90_000),
    body: JSON.stringify({
      file: input.body.toString("base64"),
      fileType: 1,
      returnMarkdownImages: false,
      visualize: false,
      formatBlockContent: false,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`paddleocr: ${response.status} ${response.statusText} ${detail.slice(0, 300)}`.trim());
  }
  return parsePaddleStructureImageOcrResponse(await response.json(), paddleOcrEngineVersion());
}

export const paddleOcrGrantImageOcr: GrantImageOcrAdapter = async (input) => {
  const result = await recognizeImageWithPaddleOcr(input);
  return {
    markdown: result.markdown,
    confidence: result.confidence,
    provider: result.provider,
    converter: result.converter,
  };
};

export function parsePaddleStructureImageOcrResponse(
  raw: unknown,
  engineVersion = "unspecified",
): PaddleStructureImageOcrResult {
  const root = record(raw);
  const result = record(root.result ?? root);
  const pagesValue = result.layoutParsingResults ?? result.layout_parsing_results;
  if (!Array.isArray(pagesValue) || pagesValue.length === 0) {
    throw new Error("paddleocr: response is missing layoutParsingResults");
  }
  const markdownParts: string[] = [];
  const preferredScores: number[] = [];
  const fallbackScores: number[] = [];
  let recognizedLineCount = 0;
  for (const pageValue of pagesValue) {
    const page = record(pageValue);
    const markdown = record(page.markdown).text;
    if (typeof markdown === "string" && markdown.trim()) markdownParts.push(sanitizeMarkdown(markdown));
    const pruned = record(page.prunedResult ?? page.pruned_result);
    const overall = record(pruned.overall_ocr_res ?? pruned.overallOcrRes);
    const pageScores = finiteScores(overall.rec_scores ?? overall.recScores);
    if (pageScores.length > 0) preferredScores.push(...pageScores);
    const recTexts = overall.rec_texts ?? overall.recTexts;
    if (Array.isArray(recTexts)) recognizedLineCount += recTexts.filter((value) => typeof value === "string" && value.trim()).length;
    if (pageScores.length === 0) fallbackScores.push(...collectRecognitionScores(pruned));
  }
  const markdown = markdownParts.filter(Boolean).join("\n\n").trim().slice(0, MAX_MARKDOWN_CHARS);
  if (!markdown) throw new Error("paddleocr: response contains no markdown text");
  const scores = preferredScores.length > 0 ? preferredScores : fallbackScores;
  return {
    markdown,
    confidence: scores.length > 0 ? average(scores) : 0,
    provider: "paddleocr_ppstructurev3",
    converter: `paddleocr-ppstructurev3-http-v1/${engineVersion}`,
    lineCount: recognizedLineCount || markdown.split(/\r?\n/).filter((line) => line.trim()).length,
  };
}

function collectRecognitionScores(value: unknown): number[] {
  const scores: number[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 12 || !candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate.slice(0, 5_000)) visit(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === "rec_scores" || key === "recScores") scores.push(...finiteScores(entry));
      else visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return scores.slice(0, 20_000);
}

function finiteScores(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "number" && Number.isFinite(entry)
    ? [Math.min(1, Math.max(0, entry))]
    : []);
}

function sanitizeMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^\n)]*\)/g, "")
    .replace(/<img\b[^>]*>/gi, "")
    .trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("paddleocr: PADDLEOCR_SERVER_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("paddleocr: PADDLEOCR_SERVER_URL must use http or https");
  }
}
