/**
 * 크레딧 표시용 라벨·설명 조립 (순수 함수).
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md
 *   - 9.1 ledger.description 서버 한국어 조립
 *   - 10.3 usage 내역은 기능명(한국어)·차감 크레딧·원화 환산. 토큰/모델은 상세 토글.
 *   - 3.2 featureCode 사전
 */

import type { CreditLedgerEntryType } from "./ports.js";

/** 3.2 featureCode → 한국어 라벨. 미등록 코드는 코드 그대로 반환(ops_batch_* 등도 표기). */
const FEATURE_LABELS: Record<string, string> = {
  application_draft: "지원서 초안 생성",
  application_review: "지원서 첨삭",
  business_plan_section: "사업계획서 섹션 작성",
  writing_guide_chat: "작성 가이드 대화",
  expert_field_answer: "전문가 필드 답변",
  popbill_lookup: "사업자 정보 조회",
  ops_batch_bizinfo_criteria: "운영 배치(기업마당 조건 추출)",
  ops_batch_knowledge_extraction: "운영 배치(지식 추출)",
  ops_batch_prelabel: "운영 배치(사전 라벨)",
};

export function featureLabel(featureCode: string): string {
  return FEATURE_LABELS[featureCode] ?? featureCode;
}

/** 9.1 ledger 항목의 한국어 description 조립. 금액은 양수=지급, 음수=차감. */
export function ledgerEntryDescription(entry: {
  entryType: CreditLedgerEntryType;
  amountCredits: number;
  reason: string | null;
}): string {
  const abs = Math.abs(entry.amountCredits);
  switch (entry.entryType) {
    case "signup_bonus_grant":
      return `가입 보너스 ${abs.toLocaleString("ko-KR")} 크레딧 지급`;
    case "purchase_grant":
      return `크레딧 충전 ${abs.toLocaleString("ko-KR")} 크레딧`;
    case "plan_grant":
      return `플랜 월 지급 ${abs.toLocaleString("ko-KR")} 크레딧`;
    case "admin_grant":
      return `운영자 지급 ${abs.toLocaleString("ko-KR")} 크레딧${entry.reason ? ` (${entry.reason})` : ""}`;
    case "promo_grant":
      return `프로모션 ${abs.toLocaleString("ko-KR")} 크레딧`;
    case "usage_capture":
      return `AI 작업 사용 ${abs.toLocaleString("ko-KR")} 크레딧`;
    case "refund_deduct":
      return `환불 회수 ${abs.toLocaleString("ko-KR")} 크레딧`;
    case "expiry":
      return `유효기간 만료 ${abs.toLocaleString("ko-KR")} 크레딧 소멸`;
    case "admin_deduct":
      return `운영자 차감 ${abs.toLocaleString("ko-KR")} 크레딧${entry.reason ? ` (${entry.reason})` : ""}`;
    case "reversal":
      return `정정 ${entry.amountCredits >= 0 ? "복원" : "차감"} ${abs.toLocaleString("ko-KR")} 크레딧${entry.reason ? ` (${entry.reason})` : ""}`;
    default:
      return `${abs.toLocaleString("ko-KR")} 크레딧`;
  }
}
