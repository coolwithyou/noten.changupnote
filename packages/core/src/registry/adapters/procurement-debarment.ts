/**
 * 조달청 부정당업자(참가자격 제한) 어댑터 — data.go.kr 데이터셋 15137996.
 *
 * 소진적 제재 명단이라 polarity 는 known_on_absence: 명단에 없으면 "제재 없음"을
 * 확신할 수 있다. 사업자등록번호가 붙어 정확 매칭이 가능하므로 confidence 0.95.
 *
 * 파서는 디코딩된 CSV 문자열을 받는다(원본 EUC-KR 디코딩은 이 파서 범위 밖).
 * 헤더 행에서 컬럼명→인덱스 맵을 만들어 순서에 의존하지 않는다. 빈 행·헤더 불일치·
 * 필수값(업체명) 결측은 throw 없이 관대하게 skip 한다.
 *
 * 실측 헤더(18컬럼):
 *   계약법구분,기관,법인등록번호,사업자등록번호,소관구분,시행규칙76조별표2,
 *   시행규칙76조별표2명,업체,제재근거법률,제재기간월수,제재기간일수,제재시작일자,
 *   제재입력일시,제재종료일자,조달업무영역,조문명,조항호,처분상태
 */

import type { RegistryAdapter, RegistryRecord } from "../types.js";
import { parseCsv } from "../csv.js";
import { normalizeCompanyName, parseKoreanDate, sanitizeBizNo, sanitizeCorpNo } from "../normalize.js";

/** 데이터셋 식별자. */
export const PROCUREMENT_DEBARMENT_SOURCE = "data.go.kr:15137996";

/** 사업자번호 정확·소진적 소스라 신뢰도 높음. */
const PROCUREMENT_DEBARMENT_CONFIDENCE = 0.95;

/** 컬럼명 상수(헤더 원문). */
const COL = {
  기관: "기관",
  법인등록번호: "법인등록번호",
  사업자등록번호: "사업자등록번호",
  시행규칙76조별표2명: "시행규칙76조별표2명",
  업체: "업체",
  제재근거법률: "제재근거법률",
  제재기간일수: "제재기간일수",
  제재시작일자: "제재시작일자",
  제재종료일자: "제재종료일자",
  조문명: "조문명",
  조항호: "조항호",
  처분상태: "처분상태",
} as const;

/** 헤더 셀 정규화(BOM·공백 제거). */
function cleanHeader(cell: string): string {
  return cell.replace(/^\uFEFF/, "").replace(/\s+/g, "").trim();
}

/** 나라장터 내보내기의 검색조건/출력일자 preamble 뒤 실제 헤더부터 자른다. */
function findTableStart(text: string): { table: string; delimiter: "," | "\t" } | null {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const compact = line.replace(/\s+/g, "");
    return compact.includes(COL.업체) && compact.includes(COL.사업자등록번호);
  });
  if (headerIndex < 0) return null;
  const header = lines[headerIndex] ?? "";
  return {
    table: lines.slice(headerIndex).join("\n"),
    delimiter: header.includes("\t") ? "\t" : ",",
  };
}

/** detail 에 담을 값을 빈 문자열이 아닐 때만 추가. */
function putIfPresent(target: Record<string, unknown>, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed !== "") target[key] = trimmed;
}

/**
 * 조달청 부정당 CSV(디코딩된 텍스트) → RegistryRecord[].
 * 업체명이 없는 행은 skip. 헤더에 업체 컬럼이 없으면 전체 skip(빈 배열).
 */
export function parseProcurementDebarmentCsv(
  csvText: string,
  opts?: { fetchedAt?: Date },
): RegistryRecord[] {
  const located = findTableStart(csvText);
  if (!located) return [];
  const rows = parseCsv(located.table, { delimiter: located.delimiter });
  if (rows.length < 2) return [];

  const headerRow = rows[0]!;
  const colIndex = new Map<string, number>();
  headerRow.forEach((cell, idx) => {
    const name = cleanHeader(cell);
    if (name !== "" && !colIndex.has(name)) colIndex.set(name, idx);
  });

  // 업체(상호) 컬럼이 없으면 이 어댑터로 해석 불가 → 전체 skip.
  if (!colIndex.has(cleanHeader(COL.업체))) return [];

  const fetchedAt = opts?.fetchedAt ?? new Date();
  const records: RegistryRecord[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    const get = (colName: string): string => {
      const idx = colIndex.get(cleanHeader(colName));
      if (idx === undefined) return "";
      return row[idx] ?? "";
    };

    const nameNormalized = normalizeCompanyName(get(COL.업체));
    if (nameNormalized === "") continue; // 필수값 결측 → skip.

    const detail: Record<string, unknown> = {};
    putIfPresent(detail, "처분상태", get(COL.처분상태));
    putIfPresent(detail, "제재근거법률", get(COL.제재근거법률));
    putIfPresent(detail, "시행규칙76조별표2명", get(COL.시행규칙76조별표2명));
    putIfPresent(detail, "조문명", get(COL.조문명));
    putIfPresent(detail, "조항호", get(COL.조항호));
    putIfPresent(detail, "기관", get(COL.기관));
    putIfPresent(detail, "제재기간일수", get(COL.제재기간일수));

    records.push({
      registryType: "sanction",
      flagOrCert: "participation_restricted",
      polarity: "known_on_absence",
      bizNo: sanitizeBizNo(get(COL.사업자등록번호)),
      corpNo: sanitizeCorpNo(get(COL.법인등록번호)),
      nameNormalized,
      representative: null, // CSV 에 대표자 없음.
      regionSido: null, // 기관은 제재기관이라 회사 소재지가 아님 → null.
      validFrom: parseKoreanDate(get(COL.제재시작일자)),
      validUntil: parseKoreanDate(get(COL.제재종료일자)),
      detail: Object.keys(detail).length > 0 ? detail : null,
      source: PROCUREMENT_DEBARMENT_SOURCE,
      sourceFetchedAt: fetchedAt,
      confidence: PROCUREMENT_DEBARMENT_CONFIDENCE,
    });
  }

  return records;
}

/** RegistryAdapter 구현. */
export const procurementDebarmentAdapter: RegistryAdapter = {
  source: PROCUREMENT_DEBARMENT_SOURCE,
  registryType: "sanction",
  parse: parseProcurementDebarmentCsv,
};
