/**
 * 계약 enum 단일 원천(leaf 모듈).
 *
 * openapi.ts와 index.ts가 공통으로 참조하는 enum 배열을 이 leaf에 둔다.
 * index.ts는 이 모듈을 re-export하고, openapi.ts는 여기서 직접 import한다.
 * (barrel index.ts를 통한 순환 import 초기화 오류 방지 — openapi.ts는 index.ts를
 * import하지 않는다.)
 */
export const CRITERION_DIMENSIONS = [
  "region",
  "biz_age",
  "industry",
  "size",
  "revenue",
  "employees",
  "founder_age",
  "founder_trait",
  "certification",
  "prior_award",
  "ip",
  "target_type",
  "business_status",
  "tax_compliance",
  "credit_status",
  "sanction",
  "financial_health",
  "insured_workforce",
  "investment",
  "premises",
  "export_performance",
  "other",
] as const;

export const MATCH_REVIEW_REASON_CODES = [
  "core_dimension_unknown",
  "criteria_under_extracted",
  "profile_missing",
  "hard_fail",
  "unstructured_criteria",
  "disqualification_unconfirmed",
] as const;
