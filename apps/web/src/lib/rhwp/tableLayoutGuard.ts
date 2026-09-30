import type { RhwpDocument, RhwpModule } from "./client";

interface TableTarget { section: number; parentPara: number; controlIndex: number }
interface Box { cellIdx: number; pageIndex: number; x: number; y: number; w: number; h: number }
const tolerance = 1; // 0.1px로 반올림되는 native layout의 오차 여유.

/** 용지 밖으로 새로 밀린 셀을 감지한다. 본문 영역/폰트 품질/한글 재열기 전체 검증은 아니다. */
export function assertTableLayoutDoesNotOverflow(input: {
  rhwp: RhwpModule; before: Uint8Array; after: Uint8Array; target: TableTarget;
}): void {
  const before = new input.rhwp.HwpDocument(input.before);
  let after: RhwpDocument | null = null;
  try {
    after = new input.rhwp.HwpDocument(input.after);
    const baseline = tableOverflow(before, input.target);
    const changed = tableOverflow(after, input.target);
    if (baseline.size !== changed.size) throw new Error("표 셀의 보존 여부를 확인하지 못했습니다.");
    for (const [cell, overflow] of changed) {
      const previous = baseline.get(cell);
      if (previous === undefined || overflow > previous + tolerance) {
        throw new Error("긴 문안을 넣은 뒤 표가 용지 밖으로 밀려 자동 반영을 저장하지 않았어요. 문항별 문안에 보관하거나 복사해 직접 편집해 주세요.");
      }
    }
  } finally { before.free(); after?.free(); }
}

function tableOverflow(document: RhwpDocument, target: TableTarget): Map<number, number> {
  const args = [target.section, target.parentPara, target.controlIndex] as const;
  const dimensions = JSON.parse(document.getTableDimensions(...args)) as { cellCount?: number };
  const boxes = JSON.parse(document.getTableCellBboxes(...args)) as Box[];
  if (!Number.isSafeInteger(dimensions.cellCount) || dimensions.cellCount! <= 0 || !Array.isArray(boxes)) throw new Error("표 레이아웃을 확인하지 못했습니다.");
  const result = new Map<number, number>();
  for (const box of boxes) {
    if (!Number.isSafeInteger(box.cellIdx) || box.cellIdx < 0 || box.cellIdx >= dimensions.cellCount!
      || !Number.isSafeInteger(box.pageIndex) || box.pageIndex < 0 || box.pageIndex >= document.pageCount()
      || ![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) throw new Error("표 셀의 표시 위치를 확인하지 못했습니다.");
    const page = JSON.parse(document.getPageInfo(box.pageIndex)) as { width: number; height: number };
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) throw new Error("용지 크기를 확인하지 못했습니다.");
    // 여러 쪽에 걸친 셀은 native가 반환한 모든 조각을 확인한다.
    const overflow = Math.max(0, -box.x, -box.y, box.x + box.w - page.width, box.y + box.h - page.height);
    result.set(box.cellIdx, Math.max(result.get(box.cellIdx) ?? 0, overflow));
  }
  if (result.size !== dimensions.cellCount) throw new Error("표의 일부 셀 표시 위치를 확인하지 못했습니다.");
  return result;
}
