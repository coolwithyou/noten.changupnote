import { Buffer } from "node:buffer";
import type { DocumentDraft } from "@cunote/contracts";
import { documentExportWordTokens } from "./documentExportTokens";

export interface DocumentDraftDocxExportInput {
  draft: Pick<DocumentDraft, "documentName" | "draftMarkdown" | "filledFields" | "missingFields" | "status" | "updatedAt">;
  generatedAt?: Date;
}

interface ZipEntry {
  name: string;
  body: Buffer;
}

const WORD_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function documentDraftDocxContentType(): string {
  return DOCX_MIME_TYPE;
}

export function renderDocumentDraftDocx(input: DocumentDraftDocxExportInput): Uint8Array {
  const generatedAt = input.generatedAt ?? new Date();
  return buildZip([
    xmlEntry("[Content_Types].xml", contentTypesXml()),
    xmlEntry("_rels/.rels", packageRelationshipsXml()),
    xmlEntry("docProps/core.xml", corePropertiesXml(input.draft, generatedAt)),
    xmlEntry("docProps/app.xml", appPropertiesXml()),
    xmlEntry("word/styles.xml", stylesXml()),
    xmlEntry("word/document.xml", documentXml(input.draft, generatedAt)),
  ]);
}

function documentXml(
  draft: DocumentDraftDocxExportInput["draft"],
  generatedAt: Date,
): string {
  const body = [
    paragraph("창업노트 지원서 초안", "Subtitle"),
    paragraph(draft.documentName, "Title"),
    metadataTable([
      ["상태", draftStatusLabel(draft.status)],
      ["마지막 수정", formatDateTime(draft.updatedAt)],
      ["내보낸 시각", formatDateTime(generatedAt.toISOString())],
    ]),
    paragraph("자동채움 값", "Heading1"),
    autofillTable(draft),
    paragraph("초안 본문", "Heading1"),
    ...markdownBlocks(draft.draftMarkdown),
    paragraph("본 문서는 제출 전 사용자가 공고 원문과 기관 양식을 최종 확인해야 하는 작업용 초안입니다.", "Caption"),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
  ].join("");

  return xmlDocument([
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="">',
    "<w:body>",
    body,
    "</w:body>",
    "</w:document>",
  ].join(""));
}

function autofillTable(draft: Pick<DocumentDraft, "filledFields" | "missingFields">): string {
  const rows = [
    ...Object.entries(draft.filledFields).map(([label, value]) => [label, "값 준비", value]),
    ...draft.missingFields.map((field) => [field.label, "입력 필요", field.reason]),
  ];
  if (rows.length === 0) return paragraph("저장된 자동채움 값이 없습니다.", "BodyText");
  return wordTable([
    ["문항", "상태", "값/사유"],
    ...rows,
  ]);
}

function metadataTable(rows: string[][]): string {
  return wordTable(rows);
}

function markdownBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  let codeLines: string[] | null = null;

  function flushParagraph() {
    if (paragraphLines.length === 0) return;
    blocks.push(paragraph(paragraphLines.join(" ").trim(), "BodyText"));
    paragraphLines = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (codeLines) {
        blocks.push(paragraph(codeLines.join("\n"), "Code"));
        codeLines = null;
      } else {
        flushParagraph();
        codeLines = [];
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const heading = parseHeading(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push(paragraph(heading.text, `Heading${Math.min(heading.level, 3)}`));
      continue;
    }

    if (isTableStart(lines, index)) {
      flushParagraph();
      const parsed = parseTable(lines, index);
      blocks.push(wordTable([parsed.headers, ...parsed.rows]));
      index = parsed.nextIndex - 1;
      continue;
    }

    if (isListItem(trimmed)) {
      flushParagraph();
      const parsed = parseList(lines, index);
      blocks.push(...parsed.items.map((item) => paragraph(`• ${item}`, "ListParagraph")));
      index = parsed.nextIndex - 1;
      continue;
    }

    paragraphLines.push(trimmed);
  }

  if (codeLines) blocks.push(paragraph(codeLines.join("\n"), "Code"));
  flushParagraph();
  return blocks.length > 0 ? blocks : [paragraph("초안 본문이 비어 있습니다.", "BodyText")];
}

function parseHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,4})\s+(.+)$/.exec(line);
  if (!match) return null;
  return { level: match[1]!.length, text: match[2]!.trim() };
}

function parseList(lines: string[], startIndex: number): { items: string[]; nextIndex: number } {
  const items: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!isListItem(line)) break;
    items.push(line.replace(/^[-*]\s+/, "").trim());
    index += 1;
  }
  return { items, nextIndex: index };
}

function isListItem(line: string): boolean {
  return /^[-*]\s+\S/.test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]?.trim() ?? "";
  const separator = lines[index + 1]?.trim() ?? "";
  return isTableRow(header) && isTableSeparator(separator);
}

function parseTable(lines: string[], startIndex: number): { headers: string[]; rows: string[][]; nextIndex: number } {
  const headers = parseTableCells(lines[startIndex] ?? "");
  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && isTableRow(lines[index]?.trim() ?? "")) {
    rows.push(parseTableCells(lines[index] ?? ""));
    index += 1;
  }
  return { headers, rows, nextIndex: index };
}

function isTableRow(line: string): boolean {
  return line.startsWith("|") && line.endsWith("|") && line.split("|").length >= 4;
}

function isTableSeparator(line: string): boolean {
  if (!isTableRow(line)) return false;
  return parseTableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function paragraph(text: string, style: string): string {
  const lines = text.split("\n");
  return [
    "<w:p>",
    `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`,
    "<w:r>",
    '<w:rPr><w:lang w:val="ko-KR"/></w:rPr>',
    lines.map((line, index) =>
      `${index > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`
    ).join(""),
    "</w:r>",
    "</w:p>",
  ].join("");
}

function wordTable(rows: string[][]): string {
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  return [
    "<w:tbl>",
    '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:firstRow="1" w:noHBand="0" w:noVBand="1"/></w:tblPr>',
    "<w:tblGrid>",
    Array.from({ length: columnCount }, () => '<w:gridCol w:w="2400"/>').join(""),
    "</w:tblGrid>",
    ...rows.map((row) => [
      "<w:tr>",
      ...Array.from({ length: columnCount }, (_, index) => tableCell(row[index] ?? "")),
      "</w:tr>",
    ].join("")),
    "</w:tbl>",
  ].join("");
}

function tableCell(value: string): string {
  return [
    "<w:tc>",
    '<w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>',
    paragraph(value || "-", "TableText"),
    "</w:tc>",
  ].join("");
}

function stylesXml(): string {
  const tokens = documentExportWordTokens;
  const font = escapeXml(tokens.fontFamily);
  return xmlDocument([
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:style w:type="paragraph" w:default="1" w:styleId="BodyText"><w:name w:val="Body Text"/><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="${tokens.textPrimary}"/><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/><w:sz w:val="22"/></w:rPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="${tokens.textPrimary}"/><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/><w:sz w:val="40"/></w:rPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:color w:val="${tokens.brandPrimary}"/><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/><w:sz w:val="20"/></w:rPr></w:style>`,
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="BodyText"/><w:next w:val="BodyText"/><w:pPr><w:spacing w:before="360" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="BodyText"/><w:next w:val="BodyText"/><w:pPr><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="BodyText"/><w:next w:val="BodyText"/><w:pPr><w:spacing w:before="220" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="BodyText"/><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="BodyText"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>',
    `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="BodyText"/><w:rPr><w:color w:val="${tokens.textTertiary}"/><w:sz w:val="18"/></w:rPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="BodyText"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:eastAsia="${font}"/><w:sz w:val="20"/></w:rPr></w:style>`,
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="${tokens.borderDefault}"/><w:left w:val="single" w:sz="4" w:space="0" w:color="${tokens.borderDefault}"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="${tokens.borderDefault}"/><w:right w:val="single" w:sz="4" w:space="0" w:color="${tokens.borderDefault}"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="${tokens.borderDefault}"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="${tokens.borderDefault}"/></w:tblBorders></w:tblPr></w:style>`,
    "</w:styles>",
  ].join(""));
}

function contentTypesXml(): string {
  return xmlDocument([
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    `<Override PartName="/word/document.xml" ContentType="${WORD_CONTENT_TYPE}"/>`,
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>",
  ].join(""));
}

function packageRelationshipsXml(): string {
  return xmlDocument([
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>",
  ].join(""));
}

function corePropertiesXml(draft: DocumentDraftDocxExportInput["draft"], generatedAt: Date): string {
  const timestamp = generatedAt.toISOString();
  return xmlDocument([
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapeXml(`${draft.documentName} 초안`)}</dc:title>`,
    "<dc:creator>창업노트</dc:creator>",
    "<cp:lastModifiedBy>창업노트</cp:lastModifiedBy>",
    `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>`,
    "</cp:coreProperties>",
  ].join(""));
}

function appPropertiesXml(): string {
  return xmlDocument([
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    "<Application>창업노트</Application>",
    "</Properties>",
  ].join(""));
}

function xmlEntry(name: string, xml: string): ZipEntry {
  return { name, body: Buffer.from(xml, "utf8") };
}

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.body.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.body.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + entry.body.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, end]));
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
