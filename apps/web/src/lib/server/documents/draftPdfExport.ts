import { Buffer } from "node:buffer";
import type { DocumentDraft } from "@cunote/contracts";
import { documentExportTokens } from "./documentExportTokens";

export interface DocumentDraftPdfExportInput {
  draft: Pick<DocumentDraft, "documentName" | "draftMarkdown" | "filledFields" | "missingFields" | "status" | "updatedAt">;
  generatedAt?: Date;
}

interface PdfObject {
  id: number;
  body: string | Buffer;
}

interface TextLine {
  text: string;
  size?: number;
  color?: string;
  gapBefore?: number;
}

const PDF_MIME_TYPE = "application/pdf";
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 52;
const MARGIN_TOP = 58;
const MARGIN_BOTTOM = 56;
const BODY_SIZE = 10.5;
const BODY_LINE_HEIGHT = 17;
const MAX_CHARS = 55;

export function documentDraftPdfContentType(): string {
  return PDF_MIME_TYPE;
}

export function renderDocumentDraftPdf(input: DocumentDraftPdfExportInput): Uint8Array {
  const generatedAt = input.generatedAt ?? new Date();
  const lines = buildLines(input.draft, generatedAt);
  const pages = paginate(lines);
  const objects: PdfObject[] = [];
  const pageObjectIds: number[] = [];
  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;
  const cidFontId = 4;

  objects.push(
    { id: fontId, body: "<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [4 0 R] >>" },
    {
      id: cidFontId,
      body: "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 2 >> /DW 1000 >>",
    },
  );

  let nextId = 5;
  for (const pageLines of pages) {
    const contentId = nextId;
    const pageId = nextId + 1;
    nextId += 2;
    pageObjectIds.push(pageId);
    const content = renderPageContent(pageLines);
    objects.push(
      {
        id: contentId,
        body: Buffer.from(`<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}\nendstream`, "binary"),
      },
      {
        id: pageId,
        body: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      },
    );
  }

  objects.push(
    {
      id: pagesId,
      body: `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`,
    },
    { id: catalogId, body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` },
  );

  return buildPdf(objects, catalogId);
}

function buildLines(draft: DocumentDraftPdfExportInput["draft"], generatedAt: Date): TextLine[] {
  return [
    { text: "창업노트 지원서 초안", size: 10, color: documentExportTokens.brandPrimary },
    { text: draft.documentName, size: 21, color: documentExportTokens.textStrong, gapBefore: 6 },
    { text: `상태: ${draftStatusLabel(draft.status)}`, color: documentExportTokens.textTertiary, gapBefore: 12 },
    { text: `마지막 수정: ${formatDateTime(draft.updatedAt)}`, color: documentExportTokens.textTertiary },
    { text: `내보낸 시각: ${formatDateTime(generatedAt.toISOString())}`, color: documentExportTokens.textTertiary },
    { text: "자동채움 값", size: 15, color: documentExportTokens.textStrong, gapBefore: 22 },
    ...autofillLines(draft),
    { text: "초안 본문", size: 15, color: documentExportTokens.textStrong, gapBefore: 22 },
    ...markdownLines(draft.draftMarkdown),
    {
      text: "본 문서는 제출 전 사용자가 공고 원문과 기관 양식을 최종 확인해야 하는 작업용 초안입니다.",
      size: 9,
      color: documentExportTokens.textTertiary,
      gapBefore: 20,
    },
  ];
}

function autofillLines(draft: Pick<DocumentDraft, "filledFields" | "missingFields">): TextLine[] {
  const rows = [
    ...Object.entries(draft.filledFields).map(([label, value]) => `${label}: ${value}`),
    ...draft.missingFields.map((field) => `${field.label}: 입력 필요 - ${field.reason}`),
  ];
  if (rows.length === 0) return [{ text: "저장된 자동채움 값이 없습니다.", color: documentExportTokens.textTertiary }];
  return rows.flatMap((row) => wrapText(`- ${row}`, MAX_CHARS).map((text) => ({ text })));
}

function markdownLines(markdown: string): TextLine[] {
  const result: TextLine[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      result.push({ text: "", size: BODY_SIZE });
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      result.push({ text: heading[2]!.trim(), size: heading[1]!.length === 1 ? 17 : 14, color: documentExportTokens.textStrong, gapBefore: 12 });
      continue;
    }
    if (/^\|.+\|$/.test(line)) {
      if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) continue;
      for (const text of wrapText(line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).join(" / "), MAX_CHARS)) {
        result.push({ text });
      }
      continue;
    }
    const normalized = line.replace(/^[-*]\s+/, "- ");
    for (const text of wrapText(normalized, MAX_CHARS)) result.push({ text });
  }
  return result.length > 0 ? result : [{ text: "초안 본문이 비어 있습니다.", color: documentExportTokens.textTertiary }];
}

function paginate(lines: TextLine[]): TextLine[][] {
  const pages: TextLine[][] = [[]];
  let y = PAGE_HEIGHT - MARGIN_TOP;
  for (const line of lines) {
    const size = line.size ?? BODY_SIZE;
    const height = lineHeight(size) + (line.gapBefore ?? 0);
    if (y - height < MARGIN_BOTTOM && pages[pages.length - 1]!.length > 0) {
      pages.push([]);
      y = PAGE_HEIGHT - MARGIN_TOP;
    }
    pages[pages.length - 1]!.push(line);
    y -= height;
  }
  return pages;
}

function renderPageContent(lines: TextLine[]): string {
  const commands: string[] = [];
  let y = PAGE_HEIGHT - MARGIN_TOP;
  for (const line of lines) {
    const size = line.size ?? BODY_SIZE;
    y -= line.gapBefore ?? 0;
    const [red, green, blue] = pdfRgb(line.color ?? documentExportTokens.textPrimary);
    commands.push(
      "BT",
      `/F1 ${size.toFixed(2)} Tf`,
      `${red} ${green} ${blue} rg`,
      `${MARGIN_X.toFixed(2)} ${y.toFixed(2)} Td`,
      `${utf16HexString(line.text)} Tj`,
      "ET",
    );
    y -= lineHeight(size);
  }
  return commands.join("\n");
}

function buildPdf(objects: PdfObject[], catalogId: number): Uint8Array {
  const sorted = [...objects].sort((a, b) => a.id - b.id);
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = new Map<number, number>();
  let offset = parts[0]!.length;
  for (const object of sorted) {
    offsets.set(object.id, offset);
    const body = Buffer.isBuffer(object.body) ? object.body : Buffer.from(object.body, "utf8");
    const part = Buffer.concat([
      Buffer.from(`${object.id} 0 obj\n`, "utf8"),
      body,
      Buffer.from("\nendobj\n", "utf8"),
    ]);
    parts.push(part);
    offset += part.length;
  }
  const xrefOffset = offset;
  const maxId = Math.max(...sorted.map((object) => object.id), 0);
  const xrefRows = ["xref", `0 ${maxId + 1}`, "0000000000 65535 f "];
  for (let id = 1; id <= maxId; id += 1) {
    xrefRows.push(`${String(offsets.get(id) ?? 0).padStart(10, "0")} 00000 n `);
  }
  const trailer = [
    ...xrefRows,
    "trailer",
    `<< /Size ${maxId + 1} /Root ${catalogId} 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
  ].join("\n");
  parts.push(Buffer.from(trailer, "utf8"));
  return new Uint8Array(Buffer.concat(parts));
}

function wrapText(value: string, maxChars: number): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return [normalized];
  const result: string[] = [];
  let current = "";
  for (const word of normalized.split(" ")) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current.length + word.length + 1) <= maxChars) {
      current = `${current} ${word}`;
      continue;
    }
    result.push(current);
    current = word;
  }
  if (current) result.push(current);
  return result.flatMap((line) => line.length <= maxChars ? [line] : splitLongLine(line, maxChars));
}

function splitLongLine(value: string, maxChars: number): string[] {
  const result: string[] = [];
  for (let index = 0; index < value.length; index += maxChars) {
    result.push(value.slice(index, index + maxChars));
  }
  return result;
}

function lineHeight(size: number): number {
  if (size >= 18) return 28;
  if (size >= 14) return 22;
  if (size <= 9) return 14;
  return BODY_LINE_HEIGHT;
}

function utf16HexString(value: string): string {
  return `<FEFF${Buffer.from(value, "utf16le").swap16().toString("hex").toUpperCase()}>`;
}

function pdfRgb(value: string): [string, string, string] {
  const hex = toOpaqueHex(value).replace("#", "");
  const channels = [0, 2, 4].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  return channels.map((channel) => channel.toFixed(4)) as [string, string, string];
}

function toOpaqueHex(value: string): string {
  const hex = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  if (/^#[0-9a-f]{8}$/i.test(hex)) {
    const red = Number.parseInt(hex.slice(1, 3), 16);
    const green = Number.parseInt(hex.slice(3, 5), 16);
    const blue = Number.parseInt(hex.slice(5, 7), 16);
    const alpha = Number.parseInt(hex.slice(7, 9), 16) / 255;
    return `#${[red, green, blue]
      .map((channel) => Math.round(channel * alpha + 255 * (1 - alpha)))
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return "#191f28";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function draftStatusLabel(status: DocumentDraft["status"]): string {
  if (status === "needs_input") return "입력 필요";
  if (status === "reviewed") return "검토 완료";
  if (status === "exported") return "내보냄";
  if (status === "archived") return "보관됨";
  return "초안";
}
