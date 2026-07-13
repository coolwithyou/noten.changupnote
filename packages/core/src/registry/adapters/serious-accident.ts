/**
 * 중대재해 발생 사업장(현장) 명단 어댑터 — data.go.kr 데이터셋 15090150 (A4).
 *
 * 사업자등록번호·대표자가 없는 연도 스냅샷 명단이라 상호(사업장명)+지역 퍼지로만
 * 조인할 수 있다. 존재만 근거가 되고 부재는 무정보이므로 polarity 는 present_only,
 * 사업자번호 없는 상호 퍼지라 confidence 0.5(조달청 0.95 대비 보수적).
 *
 * 명단은 특정 연도의 스냅샷이라 개별 행에 유효기간이 없다 → validFrom·validUntil 모두 null.
 *
 * 파서는 디코딩된 CSV 문자열을 받는다(원본 인코딩 디코딩은 이 파서 범위 밖).
 * 헤더 행에서 컬럼명→인덱스 맵을 만들어 순서에 의존하지 않는다(BOM strip). 빈 행·
 * 헤더 불일치·필수값(사업장명) 결측은 throw 없이 관대하게 skip 한다.
 *
 * 실측 헤더(11컬럼):
 *   재해발생연도,지역,업종명(중분류),규모,사업장명(현장명),사업장 소재지,
 *   중대재해 재해자수(명),근로자수(명),재해자수(명),재해율(퍼센트),
 *   규모별 동종업종 평균재해율(퍼센트)
 */

import type { RegistryAdapter, RegistryRecord } from "../types.js";
import { parseCsv } from "../csv.js";
import { normalizeCompanyName } from "../normalize.js";

/** 데이터셋 식별자. */
export const SERIOUS_ACCIDENT_SOURCE = "data.go.kr:15090150";

/** 사업자번호 없는 상호 퍼지 소스라 보수적. */
const SERIOUS_ACCIDENT_CONFIDENCE = 0.5;

/** 컬럼명 상수(헤더 원문). */
const COL = {
  재해발생연도: "재해발생연도",
  지역: "지역",
  업종명중분류: "업종명(중분류)",
  규모: "규모",
  사업장명: "사업장명(현장명)",
  사업장소재지: "사업장 소재지",
  재해율: "재해율(퍼센트)",
} as const;

/** 헤더 셀 정규화(BOM·공백 제거). */
function cleanHeader(cell: string): string {
  return cell.replace(/^\uFEFF/, "").replace(/\s+/g, "").trim();
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
 * 중대재해 명단 CSV(디코딩된 텍스트) → RegistryRecord[].
 * 사업장명이 없는 행은 skip. 헤더에 사업장명 컬럼이 없으면 전체 skip(빈 배열).
 */
export function parseSeriousAccidentCsv(
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

  // 사업장명(상호) 컬럼이 없으면 이 어댑터로 해석 불가 → 전체 skip.
  if (!colIndex.has(cleanHeader(COL.사업장명))) return [];

  const fetchedAt = opts?.fetchedAt ?? new Date();
  const records: RegistryRecord[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    const get = (colName: string): string => {
      const idx = colIndex.get(cleanHeader(colName));
      if (idx === undefined) return "";
      return row[idx] ?? "";
    };

    const nameNormalized = normalizeCompanyName(get(COL.사업장명));
    if (nameNormalized === "") continue; // 필수값 결측 → skip.

    const detail: Record<string, unknown> = {};
    putIfPresent(detail, "재해발생연도", get(COL.재해발생연도));
    putIfPresent(detail, "업종명(중분류)", get(COL.업종명중분류));
    putIfPresent(detail, "규모", get(COL.규모));
    putIfPresent(detail, "사업장 소재지", get(COL.사업장소재지));
    putIfPresent(detail, "재해율(퍼센트)", get(COL.재해율));

    records.push({
      registryType: "sanction",
      flagOrCert: "serious_accident_listed",
      polarity: "present_only",
      bizNo: null, // CSV 에 사업자번호 없음.
      corpNo: null,
      nameNormalized,
      representative: null, // CSV 에 대표자 없음.
      regionSido: trimOrNull(get(COL.지역)),
      validFrom: null, // 연도 스냅샷 명단 — 개별 유효기간 없음.
      validUntil: null,
      detail: Object.keys(detail).length > 0 ? detail : null,
      source: SERIOUS_ACCIDENT_SOURCE,
      sourceFetchedAt: fetchedAt,
      confidence: SERIOUS_ACCIDENT_CONFIDENCE,
    });
  }

  return records;
}

/** RegistryAdapter 구현. */
export const seriousAccidentAdapter: RegistryAdapter = {
  source: SERIOUS_ACCIDENT_SOURCE,
  registryType: "sanction",
  parse: parseSeriousAccidentCsv,
};
