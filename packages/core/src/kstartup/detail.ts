export const KSTARTUP_DETAIL_PARSER_VERSION = "kstartup-detail-v1";

const KSTARTUP_ORIGIN = "https://www.k-startup.go.kr";
const DEFAULT_DETAIL_TIMEOUT_MS = 15_000;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface KStartupDetailAttachment {
  filename: string;
  url: string;
}

export interface KStartupDetailContent {
  parser_version: string;
  fetched_at: string;
  apply_method_text: string | null;
  submit_documents_text: string | null;
  attachments: KStartupDetailAttachment[];
}

export interface ParseKStartupDetailOptions {
  baseUrl?: string;
  fetchedAt?: string | Date;
}

export interface FetchKStartupDetailOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  fetchedAt?: string | Date;
  userAgent?: string;
  signal?: AbortSignal;
}

export interface FetchKStartupDetailResult {
  content: KStartupDetailContent;
  html: string;
  status: number;
}

export function parseKStartupDetailHtml(
  html: string,
  options: ParseKStartupDetailOptions = {},
): { content: KStartupDetailContent } {
  const baseUrl = options.baseUrl ?? KSTARTUP_ORIGIN;
  const fetchedAt = normalizeFetchedAt(options.fetchedAt);
  const content: KStartupDetailContent = {
    parser_version: KSTARTUP_DETAIL_PARSER_VERSION,
    fetched_at: fetchedAt,
    apply_method_text: extractSectionText(html, "신청방법"),
    submit_documents_text: extractSectionText(html, "제출서류"),
    attachments: extractAttachments(html, baseUrl),
  };
  return { content };
}

export async function fetchKStartupDetail(
  url: string,
  options: FetchKStartupDetailOptions = {},
): Promise<FetchKStartupDetailResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DETAIL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "user-agent": options.userAgent ?? BROWSER_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`K-Startup detail request failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const baseUrl = safeOrigin(url) ?? KSTARTUP_ORIGIN;
    const { content } = parseKStartupDetailHtml(html, {
      baseUrl,
      fetchedAt: normalizeFetchedAt(options.fetchedAt),
    });
    return { content, html, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

function extractSectionText(html: string, label: string): string | null {
  const headings = collectSectionHeadings(html);
  const target = headings.find((heading) => heading.text.includes(label));
  if (!target) return null;

  const nextHeading = headings.find((heading) => heading.start > target.contentStart);
  const boundary = nextHeading
    ? nextHeading.start
    : nextSectionBoundary(html, target.contentStart);
  const slice = html.slice(target.contentStart, boundary);
  const text = htmlToText(slice);
  return text.length > 0 ? text : null;
}

interface SectionHeading {
  start: number;
  contentStart: number;
  text: string;
}

function collectSectionHeadings(html: string): SectionHeading[] {
  const headingRe = /<p\b[^>]*class="title"[^>]*>([\s\S]*?)<\/p>/g;
  const headings: SectionHeading[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(html)) !== null) {
    headings.push({
      start: match.index,
      contentStart: match.index + match[0].length,
      text: htmlToText(match[1] ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  return headings;
}

function nextSectionBoundary(html: string, from: number): number {
  const markers = ['class="guide_wrap"', 'class="board_file"', "margin-top:100px"];
  let boundary = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const index = html.indexOf(marker, from);
    if (index !== -1 && index < boundary) boundary = index;
  }
  if (boundary === Number.POSITIVE_INFINITY) return Math.min(html.length, from + 8000);
  return boundary;
}

function extractAttachments(html: string, baseUrl: string): KStartupDetailAttachment[] {
  const fileLabels = collectFileLabels(html);
  const attachments: KStartupDetailAttachment[] = [];
  const seen = new Set<string>();

  const downloadRe = /href="([^"]*\/afile\/fileDownload\/[^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = downloadRe.exec(html)) !== null) {
    const absoluteUrl = toAbsoluteUrl(decodeHtmlEntities(match[1] ?? ""), baseUrl);
    if (!absoluteUrl || seen.has(absoluteUrl)) continue;
    const filename = nearestPrecedingLabel(fileLabels, match.index);
    attachments.push({ filename, url: absoluteUrl });
    seen.add(absoluteUrl);
  }
  return attachments;
}

interface FileLabel {
  index: number;
  filename: string;
}

function collectFileLabels(html: string): FileLabel[] {
  const labelRe = /<a\b([^>]*class="file_bg"[^>]*)>([\s\S]*?)<\/a>/g;
  const labels: FileLabel[] = [];
  let match: RegExpExecArray | null;
  while ((match = labelRe.exec(html)) !== null) {
    const inner = htmlToText(match[2] ?? "").replace(/\s+/g, " ").trim();
    const filename = inner.length > 0 ? inner : titleAttrFilename(match[1] ?? "");
    if (filename.length > 0) labels.push({ index: match.index, filename });
  }
  return labels;
}

function titleAttrFilename(attrs: string): string {
  const titleMatch = /title="([^"]*)"/.exec(attrs);
  if (!titleMatch) return "";
  return decodeHtmlEntities(titleMatch[1] ?? "")
    .replace(/^\s*\[첨부파일\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nearestPrecedingLabel(labels: FileLabel[], downloadIndex: number): string {
  let filename = "";
  for (const label of labels) {
    if (label.index < downloadIndex) filename = label.filename;
    else break;
  }
  return filename;
}

function toAbsoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function normalizeFetchedAt(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim().length > 0) return value;
  return new Date().toISOString();
}

function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(br|BR)\s*\/?>/g, "\n")
    .replace(/<\/\s*(p|li|div|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(withBreaks)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePointToString(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePointToString(parseInt(dec, 10)));
}

function codePointToString(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
