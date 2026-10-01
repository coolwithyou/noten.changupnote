/** Fixed safe copy only: provider output, source text and credentials never enter errors. */
const messages = {
  section_output_invalid: "AI 응답의 문단 형식을 확인하지 못했어요. 자료를 보존한 채 새로 요청해 주세요.",
  section_control_characters: "초안에 사용할 수 없는 문자가 있어 제외했어요. 새로 요청해 주세요.",
  section_evidence_invalid: "초안의 인용문을 원문에서 확인하지 못했어요. 선택한 자료를 확인해 주세요.",
  section_evidence_missing: "회사 내용이나 사업 계획의 출처가 빠져 초안을 제외했어요. 관련 자료를 확인해 주세요.",
  section_company_source_invalid: "공고나 사업 계획을 회사 사실의 근거로 사용한 초안을 제외했어요. 회사 자료를 확인해 주세요.",
  section_plan_as_fact: "예정된 계획을 완료한 실적으로 표현한 초안을 제외했어요. 실적과 계획을 구분해 주세요.",
  section_plan_source_invalid: "사업 계획을 사용자 입력에서 확인하지 못했어요. 이번 사업 설명에 계획을 추가해 주세요.",
  section_quantity_mismatch: "초안의 수치나 단위가 인용문과 달라 제외했어요. 원문의 수치와 단위를 확인해 주세요.",
  section_output_too_long: "초안이 문항 분량을 초과했어요. 작성 범위를 줄여 다시 요청해 주세요.",
  section_provider_timeout: "AI 응답 시간이 초과됐어요. 현재 문안과 자료는 유지됩니다.",
  section_provider_unavailable: "AI 서비스가 요청을 처리하지 못했어요. 현재 문안과 자료는 유지됩니다.",
  section_generation_failed: "문항 초안을 완성하지 못했어요. 현재 문안과 자료는 유지됩니다.",
} as const;
export type SectionFailureCode = keyof typeof messages;
export function sectionFailureMessage(code: string | null | undefined): string {
  return code && Object.hasOwn(messages, code) ? messages[code as SectionFailureCode] : messages.section_generation_failed;
}
export function isSectionFailureCode(code: string): code is SectionFailureCode { return Object.hasOwn(messages, code); }
