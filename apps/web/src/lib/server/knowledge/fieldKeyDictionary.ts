/**
 * Gate 1 표준 필드 key 사전 — 코드 스냅샷.
 *
 * 정본(single source of truth)은 기준서 `docs/gate1-field-map-labeling-guide.md` §"표준 key 사전"이다.
 * 이 파일은 그 15개 항목의 코드 스냅샷이며, 기준서가 갱신되면 여기도 동기화해야 한다.
 *
 * 공유 소비처(extraction·매칭·백필이 같은 화이트리스트를 쓰도록 이 모듈로 단일화):
 *   - extraction.ts: 추출 프롬프트에 "key: 의미" 요약을 주입하고, 추출된 scope.fieldKey 를
 *     이 화이트리스트로 검증한다(사전 밖 fieldKey 는 그 축만 제거 — 자유 발명 금지).
 *   - lessonContext.ts: fieldKey 동등성 매칭(양쪽 다 사전 기반이므로 불일치는 진짜 다른 필드).
 *   - backfill-lesson-field-keys.ts: fieldPattern → fieldKey 결정적(규칙 기반) 매핑 제안.
 */

export interface FieldKeyEntry {
  key: string;
  /** 사람이 읽는 의미(프롬프트 주입·백필 대조의 근거). */
  meaning: string;
}

/**
 * 표준 key 사전(15개). 정본: 기준서 §"표준 key 사전". 갱신 시 반드시 동기화.
 * 순서는 기준서 표와 동일하게 유지한다(프롬프트 재현성).
 */
export const FIELD_KEY_DICTIONARY: readonly FieldKeyEntry[] = [
  { key: "company_name", meaning: "기업명/상호" },
  { key: "biz_reg_no", meaning: "사업자등록번호" },
  { key: "ceo_name", meaning: "대표자 성명" },
  { key: "founded_date", meaning: "설립일/개업일" },
  { key: "address", meaning: "소재지" },
  { key: "industry", meaning: "업종/업태" },
  { key: "employee_count", meaning: "상시 근로자 수" },
  { key: "revenue", meaning: "매출액 (기간은 notes에)" },
  { key: "item_summary", meaning: "사업/아이템 개요" },
  { key: "exec_plan", meaning: "추진 계획" },
  { key: "expected_effect", meaning: "기대 효과" },
  { key: "budget_table", meaning: "사업비/예산 표" },
  { key: "budget_basis", meaning: "예산 산출근거" },
  { key: "rep_signature", meaning: "대표자 서명/날인" },
  { key: "consent_privacy", meaning: "개인정보 동의" },
] as const;

/** 화이트리스트 Set(O(1) 검증). */
export const FIELD_KEY_SET: ReadonlySet<string> = new Set(FIELD_KEY_DICTIONARY.map((e) => e.key));

/** fieldKey 가 표준 사전에 존재하는가(공백 정규화 후 정확 일치). */
export function isKnownFieldKey(key: string | null | undefined): boolean {
  if (typeof key !== "string") return false;
  return FIELD_KEY_SET.has(key.trim());
}

/**
 * 추출 프롬프트 주입용 "key: 의미" 15줄 블록.
 * 모델이 fieldPattern 과 의미가 일치하는 사전 key 를 scope.fieldKey 로 제안하게 하는 근거다.
 */
export function fieldKeyDictionaryPromptBlock(): string {
  return FIELD_KEY_DICTIONARY.map((e) => `${e.key}: ${e.meaning}`).join("\n");
}
