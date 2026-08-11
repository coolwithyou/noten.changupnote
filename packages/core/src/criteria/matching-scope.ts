import type { GrantCriterion } from "@cunote/contracts";

export type NonMatchingCriterionReason =
  | "application_truthfulness_declaration"
  | "application_document_procedure"
  | "application_duplicate_support_declaration"
  | "eligibility_calculation_instruction"
  | "program_job_field"
  | "unresolved_industry_job_field"
  | "post_selection_obligation";

type MatchingScopeCriterion = {
  dimension: GrantCriterion["dimension"];
  operator: string;
  kind: GrantCriterion["kind"];
  value?: unknown;
  note?: string | null;
  source_span?: string | null;
};

const APPLICATION_MATERIAL_PATTERN =
  /신청(?:서|내용|자료)?|사업계획서|계획서|제출(?:서류|자료|문서|정보)?|증빙(?:서류|자료)?|작성|기재/u;
const TRUTHFULNESS_PATTERN = /허위|거짓|과장|위조|변조|표절|도용/u;
const DOCUMENT_PROCEDURE_PATTERN =
  /미제출|미비|누락|제출.{0,10}(?:완료하지|하지\s*않|않은)|제출\s*기한|기한\s*내\s*제출|양식.{0,12}(?:미준수|준수하지)|(?:서명|날인).{0,8}(?:누락|미비)/u;
const DUPLICATE_SUPPORT_DECLARATION_PATTERN =
  /(?:중복(?:적인)?\s*(?:지원\s*)?(?:신청|참여)|(?:지원사업|과제).{0,24}중복(?:적인)?\s*신청).{0,24}(?:하지\s*않겠|하지\s*아니하겠|않을\s*것|없음을\s*(?:확약|서약))/u;
const POST_SELECTION_CONTEXT_PATTERN =
  /선정\s*후|지원\s*후|협약(?:서)?|사업\s*수행|수행\s*내용|실제\s*수행|성과\s*보고|중간\s*보고|최종\s*보고|시정\s*요구/u;
const POST_SELECTION_BREACH_PATTERN =
  /지원\s*(?:취소|중단)|선정\s*취소|협약\s*(?:해지|위반)|환수|반환|불이행|위반|응하지\s*않/u;
const PLAN_VS_EXECUTION_PATTERN =
  /(?:신청서|계획서).{0,40}(?:수행\s*내용|실제\s*수행).{0,24}(?:상이|불일치)|(?:수행\s*내용|실제\s*수행).{0,40}(?:신청서|계획서).{0,24}(?:상이|불일치)/u;
const CURRENT_SANCTION_STATUS_PATTERN =
  /참여\s*제한\s*중|제재\s*(?:중|조치\s*대상)|현재.{0,20}(?:제한|금지)/u;
const ELIGIBILITY_CALCULATION_PATTERN =
  /다수(?:의)?\s*사업자등록증.{0,80}창업여부\s*기준표.{0,80}(?:신청\s*자격|적합\s*여부|창업\s*여부).{0,40}(?:결정|확인|판정)/u;
const PROGRAM_JOB_FIELD_PATTERN =
  /(?:모집|지원|배치|인턴|일경험)\s*(?:대상\s*)?(?:직무|직종)|직무\s*분야|인력\s*수요|청년.{0,24}(?:부여|배치|수행).{0,12}직무/u;
const UNRESOLVED_INDUSTRY_JOB_FIELD_PATTERN =
  /(?:업종.{0,60}(?:직무|직종|일경험).{0,60}(?:불명확|모호|확정되지|구분.{0,8}(?:어렵|불가))|(?:직무|직종|일경험).{0,60}업종.{0,60}(?:불명확|모호|확정되지|구분.{0,8}(?:어렵|불가)))/u;

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
  const text = normalizeScopeText(criterion.source_span);
  if (!text) return null;

  if (criterion.dimension === "industry") {
    const semanticText = normalizeScopeText([
      text,
      criterion.note,
      criterionValueNote(criterion.value),
    ].filter(Boolean).join(" "));
    if (PROGRAM_JOB_FIELD_PATTERN.test(text)) {
      return "program_job_field";
    }
    if (
      criterion.operator === "text_only"
      && UNRESOLVED_INDUSTRY_JOB_FIELD_PATTERN.test(semanticText)
    ) {
      return "unresolved_industry_job_field";
    }
  }

  if (
    criterion.dimension === "other"
    && criterion.operator === "text_only"
    && ELIGIBILITY_CALCULATION_PATTERN.test(text)
  ) {
    return "eligibility_calculation_instruction";
  }
  if (criterion.kind !== "exclusion") return null;

  if (
    (criterion.dimension === "prior_award" || criterion.dimension === "other")
    && DUPLICATE_SUPPORT_DECLARATION_PATTERN.test(text)
  ) {
    return "application_duplicate_support_declaration";
  }

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

function criterionValueNote(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const note = (value as Record<string, unknown>).note;
  return typeof note === "string" ? note : null;
}
