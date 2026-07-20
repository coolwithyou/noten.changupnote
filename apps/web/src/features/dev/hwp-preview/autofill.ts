import type * as Rhwp from "@rhwp/core";

/**
 * HWP 서식 자동 채움 (기술검증용).
 * searchAllText로 라벨 셀을 찾아 같은 행의 오른쪽 인접 빈 셀에 값을 삽입한다.
 */

export interface AutofillField {
  key: string;
  value: string;
  /** 우선순위 순 라벨 표기 변형. 먼저 매칭되는 것을 사용 */
  labels: string[];
}

export interface AutofillResult {
  bytes: Uint8Array;
  filled: Array<{ key: string; label: string; value: string }>;
  skipped: Array<{ key: string; value: string; reason: string }>;
}

/** 데모 회사 프로필 — 실험용 고정값 */
export const DEMO_FIELDS: AutofillField[] = [
  {
    key: "companyName",
    value: "주식회사 큐노트",
    labels: ["기업명", "업체명", "회사명", "기업체명", "신청기업명"],
  },
  {
    key: "bizNo",
    value: "123-45-67890",
    labels: ["사업자등록번호", "사업자 등록번호", "사업자번호"],
  },
  {
    key: "ceoName",
    value: "홍길동",
    labels: ["대표자 성명", "대표자명", "대표자"],
  },
];

interface SearchHit {
  sec: number;
  para: number;
  charOffset: number;
  length: number;
  cellContext?: {
    parentPara: number;
    ctrlIdx: number;
    cellIdx: number;
    cellPara: number;
  };
}

interface CellInfo {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

export function prefillHwpFields(
  rhwp: typeof Rhwp,
  buffer: ArrayBuffer,
  fields: AutofillField[],
): AutofillResult {
  const doc = new rhwp.HwpDocument(new Uint8Array(buffer));
  try {
    const filled: AutofillResult["filled"] = [];
    const skipped: AutofillResult["skipped"] = [];

    for (const field of fields) {
      let done = false;
      let reason = "라벨 셀을 찾지 못함";
      for (const label of field.labels) {
        const hits = JSON.parse(doc.searchAllText(label, false, true)) as SearchHit[];
        for (const hit of hits) {
          if (!hit.cellContext) continue;
          const { parentPara, ctrlIdx, cellIdx } = hit.cellContext;
          const target = cellIdx + 1;
          try {
            const labelInfo = JSON.parse(
              doc.getCellInfo(hit.sec, parentPara, ctrlIdx, cellIdx),
            ) as CellInfo;
            const targetInfo = JSON.parse(
              doc.getCellInfo(hit.sec, parentPara, ctrlIdx, target),
            ) as CellInfo;
            if (targetInfo.row !== labelInfo.row) {
              reason = "라벨 오른쪽 셀이 같은 행이 아님";
              continue;
            }
            if (doc.getCellParagraphLength(hit.sec, parentPara, ctrlIdx, target, 0) > 0) {
              reason = "대상 셀에 기존 내용이 있어 건너뜀";
              continue;
            }
            const res = JSON.parse(
              doc.insertTextInCell(hit.sec, parentPara, ctrlIdx, target, 0, 0, field.value),
            ) as { ok?: boolean };
            if (res.ok) {
              filled.push({ key: field.key, label, value: field.value });
              done = true;
              break;
            }
            reason = "insertTextInCell 실패";
          } catch {
            reason = "셀 정보 조회/삽입 중 오류";
          }
        }
        if (done) break;
      }
      if (!done) skipped.push({ key: field.key, value: field.value, reason });
    }

    return { bytes: doc.exportHwp(), filled, skipped };
  } finally {
    doc.free();
  }
}
