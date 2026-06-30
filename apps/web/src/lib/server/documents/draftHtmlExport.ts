import type { DocumentDraft } from "@cunote/contracts";
import { documentExportTokens } from "./documentExportTokens";

export interface DocumentDraftHtmlExportInput {
  draft: Pick<DocumentDraft, "documentName" | "draftMarkdown" | "filledFields" | "missingFields" | "status" | "updatedAt">;
  generatedAt?: Date;
}

export function renderDocumentDraftMarkdown(input: DocumentDraftHtmlExportInput): string {
  return [
    input.draft.draftMarkdown.trim(),
    "",
    "## 자동채움 값",
    "",
    renderAutofillMarkdown(input.draft),
    "",
  ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function renderDocumentDraftHtml(input: DocumentDraftHtmlExportInput): string {
  const generatedAt = input.generatedAt ?? new Date();
  const title = `${input.draft.documentName} 초안`;
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    documentCss(),
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    "<header>",
    "<p>창업노트 인쇄용 초안</p>",
    `<h1>${escapeHtml(input.draft.documentName)}</h1>`,
    `<dl><div><dt>상태</dt><dd>${escapeHtml(draftStatusLabel(input.draft.status))}</dd></div><div><dt>마지막 수정</dt><dd>${escapeHtml(formatDateTime(input.draft.updatedAt))}</dd></div><div><dt>내보낸 시각</dt><dd>${escapeHtml(formatDateTime(generatedAt.toISOString()))}</dd></div></dl>`,
    "</header>",
    renderAutofillHtml(input.draft),
    '<article class="document-body">',
    renderMarkdownBody(input.draft.draftMarkdown),
    "</article>",
    '<footer>본 문서는 제출 전 사용자가 공고 원문과 기관 양식을 최종 확인해야 하는 작업용 초안입니다.</footer>',
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderAutofillMarkdown(
  draft: Pick<DocumentDraft, "filledFields" | "missingFields">,
): string {
  const rows = [
    ...Object.entries(draft.filledFields).map(([label, value]) => [label, "값 준비", value]),
    ...draft.missingFields.map((field) => [field.label, "입력 필요", field.reason]),
  ];
  if (rows.length === 0) return "_저장된 자동채움 값이 없습니다._";
  return markdownTable(["문항", "상태", "값/사유"], rows);
}

function renderAutofillHtml(
  draft: Pick<DocumentDraft, "filledFields" | "missingFields">,
): string {
  const rows = [
    ...Object.entries(draft.filledFields).map(([label, value]) => [label, "값 준비", value]),
    ...draft.missingFields.map((field) => [field.label, "입력 필요", field.reason]),
  ];
  if (rows.length === 0) return "";
  return [
    '<section class="autofill-fields">',
    "<h2>자동채움 값</h2>",
    "<table>",
    "<thead><tr><th>문항</th><th>상태</th><th>값/사유</th></tr></thead>",
    "<tbody>",
    ...rows.map((row) =>
      `<tr><td>${escapeHtml(row[0] ?? "")}</td><td>${escapeHtml(row[1] ?? "")}</td><td>${escapeHtml(row[2] ?? "")}</td></tr>`
    ),
    "</tbody>",
    "</table>",
    "</section>",
  ].join("\n");
}

function renderMarkdownBody(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${escapeHtml(paragraph.join(" ").trim())}</p>`);
    paragraph = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (code) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        flushParagraph();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const heading = parseHeading(trimmed);
    if (heading) {
      flushParagraph();
      html.push(`<h${heading.level}>${escapeHtml(heading.text)}</h${heading.level}>`);
      continue;
    }

    if (isTableStart(lines, index)) {
      flushParagraph();
      const parsed = parseTable(lines, index);
      html.push(parsed.html);
      index = parsed.nextIndex - 1;
      continue;
    }

    if (isListItem(trimmed)) {
      flushParagraph();
      const parsed = parseList(lines, index);
      html.push(parsed.html);
      index = parsed.nextIndex - 1;
      continue;
    }

    paragraph.push(trimmed);
  }

  if (code) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  return html.join("\n");
}

function parseHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,4})\s+(.+)$/.exec(line);
  if (!match) return null;
  return { level: match[1]!.length, text: match[2]!.trim() };
}

function parseList(lines: string[], startIndex: number): { html: string; nextIndex: number } {
  const items: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!isListItem(line)) break;
    items.push(`<li>${escapeHtml(line.replace(/^[-*]\s+/, "").trim())}</li>`);
    index += 1;
  }
  return { html: `<ul>\n${items.join("\n")}\n</ul>`, nextIndex: index };
}

function isListItem(line: string): boolean {
  return /^[-*]\s+\S/.test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]?.trim() ?? "";
  const separator = lines[index + 1]?.trim() ?? "";
  return isTableRow(header) && isTableSeparator(separator);
}

function parseTable(lines: string[], startIndex: number): { html: string; nextIndex: number } {
  const headers = parseTableCells(lines[startIndex] ?? "");
  let index = startIndex + 2;
  const rows: string[][] = [];
  while (index < lines.length && isTableRow(lines[index]?.trim() ?? "")) {
    rows.push(parseTableCells(lines[index] ?? ""));
    index += 1;
  }
  const headerHtml = headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
  const bodyHtml = rows.map((row) =>
    `<tr>${headers.map((_, cellIndex) => `<td>${escapeHtml(row[cellIndex] ?? "")}</td>`).join("")}</tr>`
  ).join("\n");
  return {
    html: `<table>\n<thead><tr>${headerHtml}</tr></thead>\n<tbody>\n${bodyHtml}\n</tbody>\n</table>`,
    nextIndex: index,
  };
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

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
  ].join("\n");
}

function escapeMarkdownCell(value: string | null | undefined): string {
  const cleaned = (value ?? "-").trim();
  return (cleaned || "-").replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

function escapeHtml(value: string): string {
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

function documentCss(): string {
  const tokens = documentExportTokens;
  return `
    :root {
      color-scheme: light;
      font-family: ${tokens.fontFamily};
      line-height: ${tokens.lineHeight};
      color: ${tokens.textPrimary};
      background: ${tokens.canvas};
    }
    body {
      margin: 0;
      background: ${tokens.canvas};
    }
    main {
      width: min(860px, calc(100% - 40px));
      margin: 0 auto;
      padding: 44px 0 56px;
    }
    header {
      border-bottom: 1px solid ${tokens.borderDefault};
      padding-bottom: 22px;
      margin-bottom: 28px;
    }
    header p,
    footer {
      color: ${tokens.textTertiary};
      font-size: ${tokens.captionSize};
      font-weight: 700;
    }
    h1 {
      color: ${tokens.textStrong};
      margin: 8px 0 16px;
      font-size: 30px;
      line-height: 1.25;
    }
    h2 {
      margin: 30px 0 10px;
      font-size: 22px;
      line-height: 1.35;
    }
    h3 {
      margin: 24px 0 8px;
      font-size: 18px;
      line-height: 1.4;
    }
    h4 {
      margin: 20px 0 8px;
      font-size: 16px;
      line-height: 1.4;
    }
    p,
    li,
    td,
    th,
    dd {
      font-size: 15px;
    }
    dl {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin: 0;
    }
    dl div {
      border: 1px solid ${tokens.borderDefault};
      border-radius: ${tokens.radiusSm};
      background: ${tokens.surface};
      padding: 10px 12px;
    }
    dt {
      color: ${tokens.textTertiary};
      font-size: 12px;
      font-weight: 800;
    }
    dd {
      margin: 2px 0 0;
      font-weight: 800;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0 22px;
    }
    th,
    td {
      border: 1px solid ${tokens.borderDefault};
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: ${tokens.fillNeutralWeak};
      font-weight: 800;
    }
    pre {
      overflow-x: auto;
      border: 1px solid ${tokens.borderDefault};
      border-radius: ${tokens.radiusTextField};
      padding: 14px;
    }
    code {
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 13px;
    }
    footer {
      border-top: 1px solid ${tokens.borderDefault};
      margin-top: 36px;
      padding-top: 18px;
    }
    @media print {
      main {
        width: auto;
        padding: 0;
      }
      a {
        color: currentColor;
      }
    }
  `.trim();
}
