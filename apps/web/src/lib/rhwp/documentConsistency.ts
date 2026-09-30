import { checkWritingConsistency, type WritingConsistencyReport } from "@/lib/documents/writingConsistency";
import type { WritingBrief } from "@/lib/documents/writingContext";
import type { RhwpDocument } from "./client";

export interface DocumentConsistencyReport {
  report: WritingConsistencyReport;
  documentSha256: string;
  pageCount: number;
  skippedTables: number;
}

/** 본문/표에서 위치가 분명한 텍스트만 읽는다. 렌더된 그림·중첩 표·문장 의미는 추정하지 않는다. */
export function inspectDocumentConsistency(document: RhwpDocument, documentSha256: string,
  brief: Pick<WritingBrief, "projectName" | "budget">): DocumentConsistencyReport {
  const sections: Array<{ fieldId: string; label: string; text: string }> = [];
  for (let section = 0; section < document.getSectionCount(); section++) {
    const paragraphs: string[] = [];
    for (let paragraph = 0; paragraph < document.getParagraphCount(section); paragraph++) {
      const text = document.getTextRange(section, paragraph, 0, document.getParagraphLength(section, paragraph));
      if (text.trim()) paragraphs.push(text);
    }
    if (paragraphs.length) sections.push({ fieldId: `body:${section}`, label: `본문 ${section + 1}구역`, text: paragraphs.join("\n") });
  }
  const seen = new Set<string>(); let skippedTables = 0;
  for (let page = 0; page < document.pageCount(); page++) {
    const layout = JSON.parse(document.getPageControlLayout(page));
    for (const table of layout.controls ?? []) {
      if (table.type !== "table" || table.stableIndex?.length !== 3) continue;
      const args = [table.secIdx as number, table.paraIdx as number, table.controlIdx as number] as const;
      const key = args.join(":"); if (seen.has(key)) continue; seen.add(key);
      try {
        const dimensions = JSON.parse(document.getTableDimensions(...args));
        if (!Number.isSafeInteger(dimensions.cellCount) || dimensions.cellCount <= 0 || dimensions.cellCount > 10_000) throw new Error("지원하지 않는 표");
        const cells = Array.from({ length: dimensions.cellCount as number }, (_, cell) => ({
          index: cell, ...JSON.parse(document.getCellInfo(...args, cell)) as { row: number; col: number; rowSpan: number; colSpan: number },
          text: Array.from({ length: document.getCellParagraphCount(...args, cell) }, (_, paragraph) =>
            document.getTextInCell(...args, cell, paragraph, 0, document.getCellParagraphLength(...args, cell, paragraph))).join("\n"),
        }));
        const tableLabel = `${page + 1}쪽 표 (${args[0] + 1}구역 ${args[1] + 1}문단)`;
        for (const cell of cells) if (cell.text.trim()) sections.push({ fieldId: `cell:${key}:${cell.index}`,
          label: `${tableLabel} ${cell.row + 1}행 ${cell.col + 1}열`, text: cell.text });
        // 같은 행에 병합 없이 항목/값 두 칸만 있는 표를 연결한다. 여러 열/병합 셀은 임의 매핑하지 않는다.
        const pairs: string[] = [];
        const rows = new Map<number, typeof cells>();
        for (const cell of cells) {
          const row = rows.get(cell.row);
          if (row) row.push(cell); else rows.set(cell.row, [cell]);
        }
        for (const rowCells of rows.values()) {
          rowCells.sort((a, b) => a.col - b.col);
          if (rowCells.length !== 2 || !rowCells.every(cell => cell.rowSpan === 1 && cell.colSpan === 1)
            || rowCells[0]!.col !== 0 || rowCells[1]!.col !== 1) continue;
          const label = rowCells[0]!.text.trim(); const value = rowCells[1]!.text.trim();
          if (!label || label.length > 40 || /[:：\r\n]/u.test(label) || !value || value.length > 160 || /[\r\n]/u.test(value)) continue;
          pairs.push(`${label}: ${value}`);
        }
        if (pairs.length) sections.push({ fieldId: `table:${key}`, label: `${tableLabel} 항목/값`, text: pairs.join("\n") });
      } catch { skippedTables++; }
    }
  }
  return { report: checkWritingConsistency({ ...brief, sections }), documentSha256, pageCount: document.pageCount(), skippedTables };
}
