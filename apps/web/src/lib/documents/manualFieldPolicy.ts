export const MANUAL_LABEL_KEYWORDS = [
  "서명",
  "署名",
  "사인",
  "직인",
  "날인",
  "인감",
  "도장",
  "동의",
  "서약",
  "확인서명",
  "첨부",
  "붙임",
  "별첨",
  "주민등록",
  "외국인등록",
  "여권번호",
  "운전면허",
] as const;

const RESIDENT_OR_ALIEN_REGISTRATION_PATTERN = /(?:^|\D)\d{6}-?[1-8]\d{6}(?:\D|$)/u;
const PASSPORT_PATTERN = /\b[A-Z][0-9]{8}\b/u;
const DRIVER_LICENSE_PATTERN = /\b\d{2}-\d{2}-\d{6}-\d{2}\b/u;

function stripSpaces(value: string): string {
  return value.replace(/\s+/gu, "");
}

/** 기존 빠른 작성의 자동 처리 금지 라벨 판정을 그대로 공유한다. */
export function isManualLabel(label: string): boolean {
  const normalized = stripSpaces(label);
  if (!normalized) return true;
  return MANUAL_LABEL_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/** 본문 후보와 인접 문맥에 manual 키워드나 민감 식별번호가 있으면 fail-closed한다. */
export function isDocumentAgentSensitiveText(value: string): boolean {
  if (isManualLabel(value)) return true;
  return RESIDENT_OR_ALIEN_REGISTRATION_PATTERN.test(value)
    || PASSPORT_PATTERN.test(value)
    || DRIVER_LICENSE_PATTERN.test(value);
}
