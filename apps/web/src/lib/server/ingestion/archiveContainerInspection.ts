import { extname } from "node:path";
import { unzipSync, type UnzipFileInfo } from "fflate";

const SUPPORTED_DOCUMENT = /\.(?:hwp|hwpx|pdf|docx|txt)$/i;
const CONTAINER_EXTENSION = /\.(?:zip|xlsx|pptx)$/i;

export interface ArchiveContainerInspection {
  filename: string;
  format: "zip" | "xlsx" | "pptx";
  byteLength: number;
  entryCount: number;
  safeEntryCount: number;
  suspiciousEntries: string[];
  supportedDocumentEntries: string[];
  textPayloadEntries: string[];
  totalUncompressedBytes: number;
  truncated: boolean;
  actionable: boolean;
}

export interface ExtractedArchiveEntry {
  filename: string;
  body: Buffer;
  originalSize: number;
}

export async function inspectArchiveContainer(
  filename: string,
  body: Buffer,
  options: { maxEntries?: number; maxUncompressedBytes?: number } = {},
): Promise<ArchiveContainerInspection> {
  const format = containerFormat(filename);
  const maxEntries = boundedInteger(options.maxEntries ?? 500, 1, 5_000, "maxEntries");
  const maxUncompressedBytes = boundedInteger(
    options.maxUncompressedBytes ?? 100 * 1024 * 1024,
    1_024,
    500 * 1024 * 1024,
    "maxUncompressedBytes",
  );
  const entries = readEntryInfo(body);
  const selected = entries.slice(0, maxEntries);
  const suspiciousEntries = selected.filter((entry) => isSuspiciousArchivePath(entry.name));
  const safeEntries = selected.filter((entry) => !isSuspiciousArchivePath(entry.name));
  const supportedDocumentEntries = safeEntries.filter((entry) => SUPPORTED_DOCUMENT.test(entry.name));
  const textPayloadEntries = safeEntries.filter((entry) => isContainerTextPayload(format, entry.name));
  const totalUncompressedBytes = entries.reduce((sum, entry) => sum + entry.originalSize, 0);
  const truncated = entries.length > maxEntries || totalUncompressedBytes > maxUncompressedBytes;
  return {
    filename,
    format,
    byteLength: body.length,
    entryCount: entries.length,
    safeEntryCount: safeEntries.length,
    suspiciousEntries: suspiciousEntries.slice(0, 20).map((entry) => entry.name),
    supportedDocumentEntries: supportedDocumentEntries.slice(0, 100).map((entry) => entry.name),
    textPayloadEntries: textPayloadEntries.slice(0, 100).map((entry) => entry.name),
    totalUncompressedBytes,
    truncated,
    actionable: suspiciousEntries.length === 0 && !truncated &&
      (supportedDocumentEntries.length > 0 || textPayloadEntries.length > 0),
  };
}

export function extractSupportedArchiveEntries(
  filename: string,
  body: Buffer,
  options: { maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number } = {},
): ExtractedArchiveEntry[] {
  if (containerFormat(filename) !== "zip") return [];
  const maxEntries = boundedInteger(options.maxEntries ?? 10, 1, 100, "maxEntries");
  const maxEntryBytes = boundedInteger(options.maxEntryBytes ?? 20 * 1024 * 1024, 1_024, 100 * 1024 * 1024, "maxEntryBytes");
  const maxTotalBytes = boundedInteger(options.maxTotalBytes ?? 50 * 1024 * 1024, 1_024, 200 * 1024 * 1024, "maxTotalBytes");
  const infos = readEntryInfo(body);
  if (infos.length > 500) throw new Error("Archive contains more than 500 entries");
  if (infos.some((entry) => isSuspiciousArchivePath(entry.name))) {
    throw new Error("Archive contains a suspicious path");
  }
  const selected = infos
    .filter((entry) => SUPPORTED_DOCUMENT.test(entry.name) && entry.originalSize > 0)
    .sort((left, right) => entryScore(right.name) - entryScore(left.name) || left.name.localeCompare(right.name))
    .slice(0, maxEntries);
  if (selected.some((entry) => entry.originalSize > maxEntryBytes)) {
    throw new Error(`Archive entry exceeds ${maxEntryBytes} bytes`);
  }
  const total = selected.reduce((sum, entry) => sum + entry.originalSize, 0);
  if (total > maxTotalBytes) throw new Error(`Selected archive entries exceed ${maxTotalBytes} bytes`);
  const selectedNames = new Set(selected.map((entry) => entry.name));
  const extracted = unzipSync(body, { filter: (entry) => selectedNames.has(entry.name) });
  return selected.flatMap((entry) => {
    const value = extracted[entry.name];
    return value ? [{ filename: entry.name, body: Buffer.from(value), originalSize: entry.originalSize }] : [];
  });
}

export function extractOfficeContainerMarkdown(filename: string, body: Buffer): string | null {
  const format = containerFormat(filename);
  if (format !== "xlsx" && format !== "pptx") return null;
  const infos = readEntryInfo(body);
  if (infos.length > 500) throw new Error("Office container contains more than 500 entries");
  if (infos.some((entry) => isSuspiciousArchivePath(entry.name))) {
    throw new Error("Office container contains a suspicious path");
  }
  const textInfos = infos.filter((entry) => isContainerTextPayload(format, entry.name));
  if (textInfos.some((entry) => entry.originalSize > 10 * 1024 * 1024)) {
    throw new Error("Office XML entry exceeds 10 MiB");
  }
  if (textInfos.reduce((sum, entry) => sum + entry.originalSize, 0) > 50 * 1024 * 1024) {
    throw new Error("Office XML payload exceeds 50 MiB");
  }
  const files = unzipSync(body, {
    filter: (entry) => isContainerTextPayload(format, entry.name) && entry.originalSize <= 10 * 1024 * 1024,
  });
  if (format === "pptx") {
    const slides = Object.entries(files)
      .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort(([left], [right]) => numericSuffix(left) - numericSuffix(right))
      .map(([name, value]) => `## ${name}\n\n${xmlText(Buffer.from(value).toString("utf8"))}`)
      .filter((value) => value.trim().length > 0);
    return cleanMarkdown(slides.join("\n\n"));
  }
  const shared = parseSharedStrings(files["xl/sharedStrings.xml"]);
  const sheets = Object.entries(files)
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(([left], [right]) => numericSuffix(left) - numericSuffix(right))
    .map(([name, value]) => renderWorksheet(name, Buffer.from(value).toString("utf8"), shared))
    .filter(Boolean);
  return cleanMarkdown(sheets.join("\n\n"));
}

export function isArchiveContainerFilename(filename: string): boolean {
  return CONTAINER_EXTENSION.test(filename);
}

function readEntryInfo(body: Buffer): UnzipFileInfo[] {
  const entries: UnzipFileInfo[] = [];
  unzipSync(body, {
    filter(entry) {
      entries.push(entry);
      return false;
    },
  });
  return entries;
}

function containerFormat(filename: string): ArchiveContainerInspection["format"] {
  const extension = extname(filename).toLowerCase();
  if (!CONTAINER_EXTENSION.test(extension)) {
    throw new Error(`Unsupported archive container: ${extension || "(none)"}`);
  }
  return extension.slice(1) as ArchiveContainerInspection["format"];
}

function isContainerTextPayload(format: ArchiveContainerInspection["format"], entry: string): boolean {
  if (format === "xlsx") {
    return entry === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry);
  }
  if (format === "pptx") return /^ppt\/slides\/slide\d+\.xml$/i.test(entry);
  return /\.(?:csv|md|xml)$/i.test(entry);
}

function isSuspiciousArchivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").some((part) => part === "..");
}

function entryScore(filename: string): number {
  let score = 0;
  if (/(공\s*고|모집공고|모집요강|사업\s*안내|통합공고|공고문)/i.test(filename)) score += 5;
  if (/(신청서|지원서|사업\s*계획서|양식|서식|서약서|동의서|확약서|별지|증빙)/i.test(filename)) score -= 4;
  return score;
}

function parseSharedStrings(value: Uint8Array | undefined): string[] {
  if (!value) return [];
  const xml = Buffer.from(value).toString("utf8");
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => xmlText(match[1] ?? ""));
}

function renderWorksheet(name: string, xml: string, shared: string[]): string {
  const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)].slice(0, 500).map((rowMatch) => {
    const values = [...((rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi))].slice(0, 100).map((cell) => {
      const attributes = cell[1] ?? "";
      const body = cell[2] ?? "";
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? xmlText(body);
      if (/\bt=["']s["']/i.test(attributes)) return shared[Number(raw)] ?? raw;
      return decodeXml(raw);
    });
    return values.join(" | ").trim();
  }).filter(Boolean);
  return rows.length > 0 ? `## ${name}\n\n${rows.join("\n")}` : "";
}

function xmlText(xml: string): string {
  return decodeXml([...xml.matchAll(/<(?:(?:a:)?t)\b[^>]*>([\s\S]*?)<\/(?:(?:a:)?t)>/gi)]
    .map((match) => match[1] ?? "")
    .join(" "));
}

function decodeXml(value: string): string {
  return value.replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, " ").trim();
}

function cleanMarkdown(value: string): string | null {
  const cleaned = value.trim().slice(0, 200_000);
  return cleaned || null;
}

function numericSuffix(value: string): number {
  return Number(value.match(/(\d+)(?!.*\d)/)?.[1] ?? 0);
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be ${min}..${max}`);
  }
  return value;
}
