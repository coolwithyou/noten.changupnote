/**
 * registry 적재/조회 공용 정규화 유틸.
 *
 * - sanitizeBizNo/sanitizeCorpNo: 숫자만 추출 후 자릿수 검증(10/13). 실패 시 null.
 * - normalizeCompanyName: 법인격 표기·특수문자·공백을 제거해 "㈜가나다"와
 *   "가나다 주식회사"가 같은 정규형으로 수렴하도록 한다(사업자번호 없는 행의 퍼지 조인 키).
 * - parseKoreanDate: YYYYMMDD/YYYY-MM-DD/YYYY.MM.DD/빈값을 관대하게 UTC Date 로.
 */

/** 숫자만 추출해 10자리면 반환, 아니면 null. */
export function sanitizeBizNo(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

/** 숫자만 추출해 13자리면 반환, 아니면 null. */
export function sanitizeCorpNo(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length === 13 ? digits : null;
}

// 법인격 표기 — 접두/접미 어디에 붙든 제거해 실체명만 남긴다. 괄호형은 특수문자 정리보다
// 먼저 걸러야 "(주)"가 "주"로 뭉개지는 걸 막으므로, 이 단계에서 통째로 제거한다.
const LEGAL_ENTITY_TOKENS = [
  "주식회사",
  "유한회사",
  "유한책임회사",
  "합자회사",
  "합명회사",
  "재단법인",
  "사단법인",
  "㈜",
  "㈔",
  "(주)",
  "(유)",
  "(재)",
  "(사)",
] as const;

/**
 * 상호를 정규화한다.
 *   1) 앞뒤 공백 제거
 *   2) 법인격 표기(주식회사/(주)/㈜/유한회사/… )를 접두·접미·중간 어디서든 제거
 *   3) 특수문자(`.` `,` `·` `-` 및 남은 괄호) 제거
 *   4) 모든 공백 제거(내부 공백 차이 무시)
 *   5) 영문 소문자화
 * 목적: "㈜가나다" == "가나다 주식회사" == "(주)가나다" 가 동일 정규형으로 수렴.
 */
export function normalizeCompanyName(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  let value = raw.trim();

  // 법인격 토큰 제거(등장 위치 무관, 전역).
  for (const token of LEGAL_ENTITY_TOKENS) {
    if (value.includes(token)) {
      value = value.split(token).join(" ");
    }
  }

  // 특수문자 정리 → 공백으로 치환(토큰 경계 보존용), 이후 전 공백 제거.
  value = value.replace(/[.,·\-()（）]/g, " ");
  value = value.replace(/\s+/g, "");

  return value.toLowerCase();
}

/**
 * 한국식 날짜 문자열을 UTC Date 로. 숫자만 뽑아 8자리(YYYYMMDD)면 파싱, 아니면 null.
 * 빈값/무효 = null(무기한·영구 제재의 빈 종료일자를 자연스럽게 null 로 흘린다).
 */
export function parseKoreanDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) return null;

  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  // 존재하지 않는 날짜(예: 20260230)는 롤오버되므로 되돌려 검증.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}
