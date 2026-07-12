/**
 * 벤처확인기업 명단 어댑터 — data.go.kr 데이터셋 15084581 (A3 일부).
 *
 * 사업자등록번호가 없어 상호(업체명)+지역 퍼지로만 조인한다. 대표자명은 익명화되어
 * 제공되므로(원문 그대로 보존) 퍼지 보강 신호로는 약하다. 존재만 근거가 되므로
 * polarity present_only, confidence 0.55(상호 퍼지·사업자번호 없음).
 *
 * 벤처확인유형은 벤처투자/연구개발/혁신성장/예비벤처 등으로 나뉘지만, canonical
 * flagOrCert 는 어느 유형이든 "벤처기업"으로 고정한다(원문 유형은 detail 로 보존).
 *
 * 파서는 디코딩된 CSV 문자열을 받는다. 헤더 행에서 컬럼명→인덱스 맵을 만들어 순서에
 * 의존하지 않는다(BOM strip). 빈 행·헤더 불일치·필수값(업체명) 결측은 throw 없이 skip.
 *
 * 실측 헤더(13컬럼):
 *   연번,업체명,대표자명(익명),벤처확인유형,지역,주소,업종분류(기보),업종명(11차),
 *   주생산품,벤처유효시작일,벤처유효종료일,벤처확인기관,신규_재확인
 */

import type { RegistryAdapter, RegistryRecord } from "../types.js";
import { parseCsv } from "../csv.js";
import { normalizeCompanyName, parseKoreanDate } from "../normalize.js";

/** 데이터셋 식별자. */
export const VENTURE_CONFIRMATION_SOURCE = "data.go.kr:15084581";

/** canonical 인증명 — 유형 무관 고정. */
const VENTURE_FLAG = "벤처기업";

/** 사업자번호 없는 상호 퍼지 소스라 보수적. */
const VENTURE_CONFIRMATION_CONFIDENCE = 0.55;

/** 컬럼명 상수(헤더 원문). */
const COL = {
  업체명: "업체명",
  대표자명: "대표자명(익명)",
  벤처확인유형: "벤처확인유형",
  지역: "지역",
  주소: "주소",
  벤처유효시작일: "벤처유효시작일",
  벤처유효종료일: "벤처유효종료일",
  벤처확인기관: "벤처확인기관",
} as const;

/** 헤더 셀 정규화(BOM·공백 제거). */
function cleanHeader(cell: string): string {
  return cell.replace(/^\uFEFF/, "").trim();
}

/** detail 에 담을 값을 빈 문자열이 아닐 때만 추가. */
function putIfPresent(target: Record<string, unknown>, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed !== "") target[key] = trimmed;
}

/** 트림 후 빈 문자열이면 null. */
function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 벤처확인 명단 CSV(디코딩된 텍스트) → RegistryRecord[].
 * 업체명이 없는 행은 skip. 헤더에 업체명 컬럼이 없으면 전체 skip(빈 배열).
 */
export function parseVentureConfirmationCsv(
  csvText: string,
  opts?: { fetchedAt?: Date },
): RegistryRecord[] {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];

  const headerRow = rows[0]!;
  const colIndex = new Map<string, number>();
  headerRow.forEach((cell, idx) => {
    const name = cleanHeader(cell);
    if (name !== "" && !colIndex.has(name)) colIndex.set(name, idx);
  });

  // 업체명(상호) 컬럼이 없으면 이 어댑터로 해석 불가 → 전체 skip.
  if (!colIndex.has(COL.업체명)) return [];

  const fetchedAt = opts?.fetchedAt ?? new Date();
  const records: RegistryRecord[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    const get = (colName: string): string => {
      const idx = colIndex.get(colName);
      if (idx === undefined) return "";
      return row[idx] ?? "";
    };

    const nameNormalized = normalizeCompanyName(get(COL.업체명));
    if (nameNormalized === "") continue; // 필수값 결측 → skip.

    const detail: Record<string, unknown> = {};
    putIfPresent(detail, "벤처확인유형", get(COL.벤처확인유형));
    putIfPresent(detail, "벤처확인기관", get(COL.벤처확인기관));
    putIfPresent(detail, "주소", get(COL.주소));

    records.push({
      registryType: "certification",
      flagOrCert: VENTURE_FLAG, // 유형 무관 canonical.
      polarity: "present_only",
      bizNo: null, // CSV 에 사업자번호 없음.
      corpNo: null,
      nameNormalized,
      representative: trimOrNull(get(COL.대표자명)), // 익명화 원문 그대로.
      regionSido: trimOrNull(get(COL.지역)),
      validFrom: parseKoreanDate(get(COL.벤처유효시작일)),
      validUntil: parseKoreanDate(get(COL.벤처유효종료일)),
      detail: Object.keys(detail).length > 0 ? detail : null,
      source: VENTURE_CONFIRMATION_SOURCE,
      sourceFetchedAt: fetchedAt,
      confidence: VENTURE_CONFIRMATION_CONFIDENCE,
    });
  }

  return records;
}

/** RegistryAdapter 구현. */
export const ventureConfirmationAdapter: RegistryAdapter = {
  source: VENTURE_CONFIRMATION_SOURCE,
  registryType: "certification",
  parse: parseVentureConfirmationCsv,
};
