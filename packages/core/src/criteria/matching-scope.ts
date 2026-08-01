import type { GrantCriterion } from "@cunote/contracts";

export type NonMatchingCriterionReason =
  | "application_truthfulness_declaration"
  | "application_document_procedure"
  | "post_selection_obligation";

type MatchingScopeCriterion = {
  dimension: GrantCriterion["dimension"];
  operator: string;
  kind: GrantCriterion["kind"];
  source_span?: string | null;
};

const APPLICATION_MATERIAL_PATTERN =
  /신청(?:서|내용|자료)?|사업계획서|계획서|제출(?:서류|자료|문서|정보)?|증빙(?:서류|자료)?|작성|기재/u;
const TRUTHFULNESS_PATTERN = /허위|거짓|과장|위조|변조|표절|도용/u;
const DOCUMENT_PROCEDURE_PATTERN =
  /미제출|미비|누락|제출.{0,10}(?:완료하지|하지\s*않|않은)|제출\s*기한|기한\s*내\s*제출|양식.{0,12}(?:미준수|준수하지)|(?:서명|날인).{0,8}(?:누락|미비)/u;
const POST_SELECTION_CONTEXT_PATTERN =
  /선정\s*후|지원\s*후|협약(?:서)?|사업\s*수행|수행\s*내용|실제\s*수행|성과\s*보고|중간\s*보고|최종\s*보고|시정\s*요구/u;
const POST_SELECTION_BREACH_PATTERN =
  /지원\s*(?:취소|중단)|선정\s*취소|협약\s*(?:해지|위반)|환수|반환|불이행|위반|응하지\s*않/u;
const PLAN_VS_EXECUTION_PATTERN =
  /(?:신청서|계획서).{0,40}(?:수행\s*내용|실제\s*수행).{0,24}(?:상이|불일치)|(?:수행\s*내용|실제\s*수행).{0,40}(?:신청서|계획서).{0,24}(?:상이|불일치)/u;
const CURRENT_SANCTION_STATUS_PATTERN =
  /참여\s*제한\s*중|제재\s*(?:중|조치\s*대상)|현재.{0,20}(?:제한|금지)/u;

/**
 * 사업자 매칭의 입력이 될 수 없는 신청 절차·사후 의무를 고정밀도로 식별한다.
 *
 * 이 규칙은 일반적인 법 위반·제재 이력까지 넓게 추정하지 않는다. 이미 존재하는
 * 참여제한·제재 상태는 신청 시점의 결격일 수 있으므로 보존하고, 신청서 진실성·서류
 * 완비 선언과 본 사업 선정 뒤의 이행 의무만 차단한다.
 */
export function nonMatchingCriterionReason(
  criterion: MatchingScopeCriterion,
): NonMatchingCriterionReason | null {
  if (criterion.kind !== "exclusion") return null;
  const text = normalizeScopeText(criterion.source_span);
  if (!text) return null;

  if (
    PLAN_VS_EXECUTION_PATTERN.test(text)
    || (
      POST_SELECTION_CONTEXT_PATTERN.test(text)
      && POST_SELECTION_BREACH_PATTERN.test(text)
      && !CURRENT_SANCTION_STATUS_PATTERN.test(text)
    )
  ) {
    return "post_selection_obligation";
  }

  if (criterion.dimension !== "other" || criterion.operator !== "text_only") {
    return null;
  }
  if (APPLICATION_MATERIAL_PATTERN.test(text) && TRUTHFULNESS_PATTERN.test(text)) {
    return "application_truthfulness_declaration";
  }
  if (APPLICATION_MATERIAL_PATTERN.test(text) && DOCUMENT_PROCEDURE_PATTERN.test(text)) {
    return "application_document_procedure";
  }
  return null;
}

export function isNonMatchingApplicationCriterion(
  criterion: MatchingScopeCriterion,
): boolean {
  return nonMatchingCriterionReason(criterion) !== null;
}

function normalizeScopeText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}
