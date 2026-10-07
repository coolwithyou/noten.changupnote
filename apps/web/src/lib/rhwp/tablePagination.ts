import { z } from "zod";
import { exportVerifiedRhwpDocument, type RhwpDocument, type RhwpDocumentFormat, type RhwpModule } from "./client";
import { canonicalSha256, sha256Hex } from "./documentAgentContract";
import { assertTableLayoutDoesNotOverflow } from "./tableLayoutGuard";

const targetSchema = z.object({
  section: z.number().int().min(0), parentPara: z.number().int().min(0), controlIndex: z.number().int().min(0),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/), tableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().max(160), page: z.number().int().min(1),
}).strict();
export type TablePaginationTarget = z.infer<typeof targetSchema>;

export async function inspectTablePagination(document: RhwpDocument, documentSha256: string): Promise<TablePaginationTarget[]> {
  const seen = new Set<string>(); const targets: TablePaginationTarget[] = [];
  for (let page = 0; page < document.pageCount(); page++) {
    const layout = JSON.parse(document.getPageControlLayout(page));
    for (const table of layout.controls ?? []) {
      if (table.type !== "table" || table.stableIndex?.length !== 3) continue;
      const position = { section: table.secIdx as number, parentPara: table.paraIdx as number, controlIndex: table.controlIdx as number };
      const key = `${position.section}:${position.parentPara}:${position.controlIndex}`;
      if (seen.has(key)) continue; seen.add(key);
      const snapshot = tableSnapshot(document, position);
      // 원래 셀 단위 쪽 나눔인 표만 다룬다. 나누지 않도록 지정한 양식은 바꾸지 않는다.
      if (snapshot.properties.treatAsChar !== true || snapshot.properties.pageBreak !== 2) continue;
      const label = snapshot.cells.map((cell) => cell.text.trim()).filter(Boolean).slice(0, 4).join(" · ").slice(0, 160);
      targets.push({ ...position, documentSha256, tableSha256: await canonicalSha256(snapshot), label: label || "내용 없는 표", page: page + 1 });
    }
  }
  return targets;
}

/** 명시적으로 선택한 표의 inline 배치만 해제한다. 문안 생성·자동 적용 경로에서 호출하지 않는다. */
export async function applyTablePagination(input: { rhwp: RhwpModule; bytes: Uint8Array; format: RhwpDocumentFormat; target: TablePaginationTarget }) {
  const target = targetSchema.parse(input.target);
  const beforeDocumentSha256 = await sha256Hex(input.bytes);
  if (beforeDocumentSha256 !== target.documentSha256) throw new Error("표를 확인한 뒤 문서가 변경됐습니다. 표 목록을 다시 확인해 주세요.");
  const document = new input.rhwp.HwpDocument(input.bytes);
  try {
    const before = tableSnapshot(document, target);
    if (await canonicalSha256(before) !== target.tableSha256 || before.properties.treatAsChar !== true || before.properties.pageBreak !== 2) {
      throw new Error("선택한 표의 현재 속성을 확인하지 못했습니다.");
    }
    const beforeText = document.getTextFileText();
    const result = JSON.parse(document.setTableProperties(target.section, target.parentPara, target.controlIndex, JSON.stringify({ treatAsChar: false })));
    if (result.ok !== true) throw new Error("표 배치를 변경하지 못했습니다.");
    const exported = exportVerifiedRhwpDocument({ rhwp: input.rhwp, document, format: input.format });
    const reopened = new input.rhwp.HwpDocument(exported.bytes);
    try {
      const after = tableSnapshot(reopened, target);
      if (after.properties.treatAsChar !== false || reopened.getTextFileText() !== beforeText
        || await canonicalSha256({ ...after, properties: { ...after.properties, treatAsChar: true } }) !== target.tableSha256) {
        throw new Error("표 배치 변경 후 문구·셀·서식 보존을 확인하지 못했습니다.");
      }
      assertTableLayoutDoesNotOverflow({ rhwp: input.rhwp, before: input.bytes, after: exported.bytes, target });
      return { bytes: exported.bytes, beforeDocumentSha256, afterDocumentSha256: await sha256Hex(exported.bytes), pageCount: reopened.pageCount() };
    } finally { reopened.free(); }
  } finally { document.free(); }
}

function tableSnapshot(document: RhwpDocument, target: Pick<TablePaginationTarget, "section" | "parentPara" | "controlIndex">) {
  const args = [target.section, target.parentPara, target.controlIndex] as const;
  const dimensions = JSON.parse(document.getTableDimensions(...args));
  if (!Number.isSafeInteger(dimensions.cellCount) || dimensions.cellCount <= 0 || dimensions.cellCount > 10_000) throw new Error("표 구조를 확인하지 못했습니다.");
  return { dimensions, properties: JSON.parse(document.getTableProperties(...args)) as Record<string, unknown>,
    cells: Array.from({ length: dimensions.cellCount as number }, (_, cell) => ({
      properties: JSON.parse(document.getCellOwnProperties(...args, cell)),
      text: Array.from({ length: document.getCellParagraphCount(...args, cell) }, (_, paragraph) =>
        document.getTextInCell(...args, cell, paragraph, 0, document.getCellParagraphLength(...args, cell, paragraph))).join("\n"),
    })),
  };
}
