import { METRO_REGION_CODES, REGION_CODES } from "../kstartup/constants.js";

/**
 * region criterion 값의 단일 시도 코드 사전.
 *
 * 운영 DB 실측(2026-07-13)에서 regions 배열에 비코드 라벨('국내', 'domestic', '전남광주')과
 * 잘못된 코드 체계('37' — 경북 시군구 라벨을 시도 코드 자리에 저장)가 유입되어,
 * required IN 비교가 모든 회사를 소재지와 무관하게 확정 탈락시키는 사례가 확인됐다.
 * 이 모듈은 "시도 2자리 행정코드"라는 값 계약을 코드로 보증하는 단일 지점이다.
 */
export const VALID_SIDO_CODES: ReadonlySet<string> = new Set(Object.values(REGION_CODES));

/** 전국/무제한 의미 토큰 — regions 원소로 오면 nationwide=true 로 승격한다. */
const NATIONWIDE_TOKENS = new Set([
  "전국",
  "국내",
  "전지역",
  "전 지역",
  "전체",
  "제한없음",
  "제한 없음",
  "kr",
  "korea",
  "domestic",
  "all",
]);

/** 공식 명칭·특별자치 개편 표기 → 시도 코드. 짧은 표기는 REGION_CODES가 원천. */
const SIDO_LABEL_ALIASES: Record<string, string> = {
  "서울특별시": "11",
  "부산광역시": "26",
  "대구광역시": "27",
  "인천광역시": "28",
  "광주광역시": "29",
  "대전광역시": "30",
  "울산광역시": "31",
  "세종특별자치시": "36",
  "세종시": "36",
  "경기도": "41",
  "강원도": "42",
  "강원특별자치도": "42",
  "충청북도": "43",
  "충청남도": "44",
  "전라북도": "45",
  "전북특별자치도": "45",
  "전라남도": "46",
  "경상북도": "47",
  "경상남도": "48",
  "제주특별자치도": "50",
  "제주도": "50",
};

export function isValidSidoCode(token: string): boolean {
  return VALID_SIDO_CODES.has(token.trim());
}

export function isNationwideRegionToken(token: string): boolean {
  return NATIONWIDE_TOKENS.has(token.trim().toLowerCase());
}

/** 단일 토큰 → 시도 코드. 코드/짧은 표기/공식 명칭만 허용하고 그 외에는 null. */
export function sidoCodeForToken(token: string): string | null {
  const text = token.trim();
  if (!text) return null;
  if (VALID_SIDO_CODES.has(text)) return text;
  return REGION_CODES[text] ?? SIDO_LABEL_ALIASES[text] ?? null;
}

/**
 * regions 배열 원소 하나를 시도 코드 목록으로 확장한다.
 * '수도권'은 서울·인천·경기 묶음이라는 확립된 의미만 확장하고, 그 밖의
 * 복합·시군구 표기('전남광주', '포항')는 재해석하지 않고 null 을 돌려
 * 호출부가 unknown(원문 확인)으로 보존하게 한다.
 */
export function expandRegionToken(token: string): string[] | null {
  const text = token.trim();
  if (text === "수도권") return [...METRO_REGION_CODES];
  const code = sidoCodeForToken(text);
  return code ? [code] : null;
}
