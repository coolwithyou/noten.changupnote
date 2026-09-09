import type {
  CriterionDimension,
  CriterionKind,
  CriterionOperator,
  CriterionValue,
  GrantCriterion,
  GrantRequiredDocument,
} from "@cunote/contracts";
import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
} from "@cunote/contracts";
import { normalizeGrantRequiredDocument } from "../documents/taxonomy.js";
import { BIZINFO_NORMALIZER_VERSION } from "./normalize.js";
import {
  assertGrantCriteriaContract,
  validateGrantCriteriaContract,
  type GrantCriteriaContractIssue,
} from "./criteria-contract.js";
import {
  canonicalizeCriterionValue,
  canonicalizeGrantCriteria,
  canonicalizeGrantCriterion,
} from "../criteria/canonicalize.js";
import { inspectPremisesCriterionSourceCompatibility } from "../premises/contract.js";
import { buildBizInfoDeterministicCriteria, mergeBizInfoDeterministicCriteria } from "./deterministic-criteria.js";
import type { BizInfoProgramExtractionInput } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

/**
 * BizInfo/K-Startup/Lab이 함께 쓰는 LLM criterion 정규화 계약.
 * source별 parser/prompt 버전과 분리해 정규화 구현 변경만 provenance에 결속한다.
 */
export const LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION =
  "grant-llm-criteria-normalization-v2" as const;

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content?: Array<AnthropicToolUseBlock | { type: string; text?: string }>;
  usage?: Record<string, unknown>;
}

export interface AnthropicCriteriaResult {
  criteria: GrantCriterion[];
  requiredDocuments: GrantRequiredDocument[];
  model: string;
  normalizerContractVersion: typeof LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION;
  usage: Record<string, unknown> | null;
}

export interface LlmCriteriaNormalizationOptions {
  sourcePrefix: string;
  parserVersion: string;
  contractLabel?: string;
  forceNeedsReview?: boolean;
}

export async function extractBizInfoCriteriaWithAnthropic(options: {
  input: BizInfoProgramExtractionInput;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<AnthropicCriteriaResult> {
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2400,
      temperature: 0,
      system: [
        "너는 정부지원사업 공고의 신청 자격조건을 구조화하는 추출기다.",
        "입력 텍스트에 명시된 조건만 추출하고, 추정하지 않는다.",
        "지역 코드는 한국 시도 행정코드 2자리(서울 11, 부산 26, 대구 27, 인천 28, 광주 29, 대전 30, 울산 31, 세종 36, 경기 41, 강원 42, 충북 43, 충남 44, 전북 45, 전남 46, 경북 47, 경남 48, 제주 50)를 사용한다.",
        "규모 값은 예비, 소상공인, 소기업, 중소기업, 중견기업, 대기업 중에서만 사용한다.",
        "업종은 dimension=industry의 value.tags 배열에 공고 표현을 가능한 짧은 한국어 정책 태그로 추출한다. 모호하면 text_only 조건으로 남긴다.",
        "휴폐업 제외 조건은 dimension=business_status, operator=not_in, kind=exclusion, value={\"statuses\":[\"closed\"],\"labels\":[\"휴폐업\"]} 로 추출한다.",
        "",
        "[결격(배제) 조건 구조화 — 아래 축으로 반드시 분해한다]",
        "- 세금·공과금 체납: dimension=tax_compliance, operator=in, kind=exclusion, value.flags=[국세=national_tax_delinquent, 지방세=local_tax_delinquent, 관세=customs_delinquent, 4대보험료=social_insurance_delinquent] 중 해당. 납부기한 연장·징수유예 등 예외 문구가 있으면 value.exceptions=[\"payment_deferral_approved\"].",
        "- 신용·금융 상태: dimension=credit_status, operator=in, kind=exclusion, value.flags=[연체=credit_delinquency, 채무불이행=loan_default, 부도=bond_default, 회생·개인회생=rehabilitation_in_progress, 파산=bankruptcy_filed, 법정관리·청산=court_receivership, 금융질서문란=financial_misconduct, 압류=asset_seizure, 보증금지·보증제한=guarantee_restricted] 중 해당. 변제 정상이행 예외→exceptions=[\"repayment_plan_in_good_standing\"], 시효소멸 예외→[\"statute_expired\"].",
        "- 제재·참여제한: dimension=sanction, operator=in, kind=exclusion, value.flags=[참여제한=participation_restricted, 부정수급·환수=subsidy_fraud, 보조금법위반·특수관계=subsidy_law_violation, 의무불이행=obligation_breach, 임금체불명단=wage_arrears_listed, 중대재해명단=serious_accident_listed, 협약·계약위반=agreement_breach] 중 해당.",
        "- 재무건전성: dimension=financial_health, kind=exclusion, value.debt_ratio_pct_threshold={\"value\":숫자,\"inclusive\":이상=true/초과=false}, value.impairment_excluded=[\"partial\"|\"full\"](자본잠식만 언급 시 [\"partial\",\"full\"]), value.min_interest_coverage=숫자.",
        "- 고용보험·피보험자: dimension=insured_workforce, value.employment_insurance_required=true / min_insured·max_insured 숫자 / no_layoff_within_months 숫자.",
        "- 투자유치: dimension=investment, value.min_total_krw(원 단위 정수) / rounds / tips_operator_required.",
        "- 배제업종(유흥주점·사행시설·암호화자산·부동산·도박): dimension=industry, operator=not_in, kind=exclusion, value.tags=[업종명].",
        "",
        "[수혜·참여 이력 구조화 — prior_award]",
        "- 동일·유사 지원 수행, 동일 과제 동시참여, 본 사업 과거 선정, 당해연도 타부처 중복은 dimension=prior_award, kind=exclusion, operator=exists, value={\"scope\":\"self\",\"self_kind\":\"current_similar|same_project|same_business_prior|same_year_other_support\",\"channel\":\"general\"}.",
        "- 다른 창업보육센터·BI 중복입주는 value={\"scope\":\"self\",\"channel\":\"incubation_tenancy\",\"self_kind\":\"same_year_other_support\"}.",
        "- 특정 지원사업 참여·수혜·수료 이력은 operator=in, value={\"scope\":\"program\"|\"program_type\",\"programs\":[\"사업명\"],\"states\":[\"participating\"|\"completed\"|\"graduated\"]}. 최근 N년·개월 조건은 within={\"value\":N,\"unit\":\"year\"|\"month\"}.",
        "- prior_award 구조화 조건에도 해당 근거 문장 source_span이 반드시 있어야 한다. 범위나 사업명을 특정할 수 없으면 other text_only exclusion으로 남긴다.",
        "",
        "[구조화 금지 — other text_only exclusion 으로만 남긴다]",
        "- 서류 허위·미제출·표절·모방·\"기타 부적합\" 같은 절차·재량 조건도 other text_only exclusion.",
        "- premises, export_performance 축은 이번 스키마에서 사용하지 않는다(제외).",
        "",
        "[결격·재무·고용·투자 축 span 규칙 — 반드시 준수]",
        "- 위 축의 구조화 조건은 반드시 해당 근거 문장만 source_span 에 담는다. source_span 이 없으면 그 조건은 만들지 말고 other text_only 로 남긴다.",
        "- raw_text 에 공고 전문·문단 전체를 복사하지 마라. 근거 문장(source_span)만 사용한다.",
        "",
        "제출 서류는 required_documents에 넣는다. 원문 source_span이 없으면 서류 항목을 만들지 않는다.",
      ].join("\n"),
      messages: [{
        role: "user",
        content: [
          "아래 기업마당 공고에서 신청 가능 여부 판정에 필요한 조건만 추출해라.",
          "필수조건은 required, 제외대상은 exclusion, 우대조건은 preferred로 분리해라.",
          "조건이 원문 확인 수준이면 operator=text_only와 value.note를 사용해라.",
          "제출 서류는 criteria가 아니라 required_documents로 분리해라.",
          "",
          options.input.text.slice(0, 12000),
        ].join("\n"),
      }],
      tools: [buildGrantCriteriaToolSchema()],
      tool_choice: { type: "tool", name: "emit_grant_criteria" },
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic criteria extraction failed: ${response.status} ${response.statusText}\n${body.slice(0, 1000)}`);
  }

  const payload = JSON.parse(body) as AnthropicMessageResponse;
  const toolUse = payload.content?.find(
    (block): block is AnthropicToolUseBlock =>
      block.type === "tool_use" && "name" in block && block.name === "emit_grant_criteria",
  );
  if (!toolUse) {
    throw new Error("Anthropic response did not contain emit_grant_criteria tool_use");
  }

  const normalizedCriteria = normalizeBizInfoLlmCriteria(toolUse.input, options.input.source_id);
  const criteria = canonicalizeGrantCriteria(mergeBizInfoDeterministicCriteria(
    buildBizInfoDeterministicCriteria(options.input),
    normalizedCriteria,
  ));
  assertGrantCriteriaContract(criteria, `bizinfo:${options.input.source_id}:merged`);
  return {
    criteria,
    requiredDocuments: normalizeBizInfoLlmRequiredDocuments(toolUse.input),
    model,
    normalizerContractVersion: LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION,
    usage: payload.usage ?? null,
  };
}

export function normalizeBizInfoLlmCriteria(payload: unknown, sourceId: string): GrantCriterion[] {
  return normalizeGrantLlmCriteria(payload, sourceId, {
    sourcePrefix: "bizinfo",
    parserVersion: BIZINFO_NORMALIZER_VERSION,
    contractLabel: `bizinfo:${sourceId}`,
    forceNeedsReview: true,
  });
}

export function normalizeGrantLlmCriteria(
  payload: unknown,
  sourceId: string,
  options: LlmCriteriaNormalizationOptions,
): GrantCriterion[] {
  const rows = Array.isArray((payload as { criteria?: unknown[] } | null)?.criteria)
    ? (payload as { criteria: unknown[] }).criteria
    : [];

  const criteria = rows.flatMap((row, index) => {
    const criterion = normalizeCriterionRow(row, sourceId, index, options);
    if (!criterion) return [];
    const issues = validateGrantCriteriaContract([criterion]);
    return issues.length === 0
      ? [criterion]
      : [downgradeContractInvalidCriterion(criterion, issues)];
  });
  assertGrantCriteriaContract(criteria, options.contractLabel ?? `${options.sourcePrefix}:${sourceId}`);
  return criteria;
}

/**
 * 한 row의 enum/value 계약 오류가 공고 전체 criteria를 0건으로 만들지 않게 하는 fail-safe.
 * 의미를 임의 보정하지 않고 원문 확인용 text_only로만 내리며, 원래 kind와 근거를 보존한다.
 */
function downgradeContractInvalidCriterion(
  criterion: GrantCriterion,
  issues: GrantCriteriaContractIssue[],
): GrantCriterion {
  const issueSummary = issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join(" | ")
    .slice(0, 800);
  const sourceSpan = criterion.source_span ?? criterion.raw_text ?? null;
  return {
    ...(criterion.id ? { id: criterion.id } : {}),
    ...(criterion.grant_id ? { grant_id: criterion.grant_id } : {}),
    dimension: "other",
    operator: "text_only",
    kind: criterion.kind,
    value: {
      note: sourceSpan ?? `${criterion.dimension} 조건 원문 확인 필요`,
      downgrade_reason: "contract_validation_failed",
      original_dimension: criterion.dimension,
      original_operator: criterion.operator,
      original_value: criterion.value,
      contract_issues: issueSummary,
    },
    confidence: criterion.confidence,
    needs_review: true,
    ...(criterion.parser_version ? { parser_version: criterion.parser_version } : {}),
    ...(sourceSpan ? { source_span: sourceSpan, raw_text: sourceSpan } : {}),
    ...(criterion.source_field ? { source_field: criterion.source_field } : {}),
  };
}

export function normalizeBizInfoLlmRequiredDocuments(payload: unknown): GrantRequiredDocument[] {
  const rows = Array.isArray((payload as { required_documents?: unknown[] } | null)?.required_documents)
    ? (payload as { required_documents: unknown[] }).required_documents
    : [];
  const documents = new Map<string, GrantRequiredDocument>();

  for (const row of rows) {
    const document = normalizeRequiredDocumentRow(row);
    if (!document || documents.has(document.name)) continue;
    documents.set(document.name, document);
  }

  return [...documents.values()];
}

/**
 * 구조화 금지 축 강등(M4). LLM 이 아래를 반환하면 evaluator·프로필이 없어 false pass·해소 불가 unknown 을
 * 유발하므로 other/text_only 로 강등한다. 표현 능력만 낮추며 원래 kind·축·연산자·근거를 보존한다:
 *   - export_performance (예약 축) — M4: 파이프라인 미활성
 *   - premises는 exact reviewed premises-v1만 통과하고 나머지는 같은 M4 경로로 보존한다.
 */
function shouldDowngradeToOther(
  dimension: CriterionDimension,
  structuredPremisesAllowed: boolean,
): boolean {
  if (dimension === "premises") return !structuredPremisesAllowed;
  if (RESERVED_LLM_EXCLUDED_DIMENSIONS.has(dimension)) return true; // M4 예약 축
  return false;
}

/**
 * M1 span 정책 대상 축 — 신규 결격/재무/고용/투자 축. 이 축의 구조화 criteria 는
 * `source_span` 이 필수이고, `raw_text` 에 원문 전문 복제를 금지한다(HIGH_RISK_DOMAIN_PATTERN 오탐 방지).
 * source_span 이 없으면 other/text_only 로 강등한다.
 */
const SPAN_REQUIRED_DIMENSIONS = new Set<string>([
  "prior_award",
  "tax_compliance",
  "credit_status",
  "sanction",
  "financial_health",
  "insured_workforce",
  "investment",
]);

function normalizeCriterionRow(
  row: unknown,
  sourceId: string,
  index: number,
  options: LlmCriteriaNormalizationOptions,
): GrantCriterion | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  let dimension = stringEnum(value.dimension, CRITERION_DIMENSIONS);
  const kind = stringEnum(value.kind, CRITERION_KINDS);
  let operator = stringEnum(value.operator, CRITERION_OPERATORS) ?? "text_only";
  if (!dimension || !kind) return null;

  const sourceSpan = cleanString(value.source_span);
  const premisesCompatibility = dimension === "premises"
    ? inspectPremisesCriterionSourceCompatibility({
        value: value.value,
        sourceSpan,
        note: value.note,
      })
    : null;
  const structuredPremisesAllowed = dimension === "premises"
    && kind === "required"
    && operator === "exists"
    && options.forceNeedsReview !== true
    && value.needs_review === false
    && premisesCompatibility?.ok === true;

  // 강등 판정(M4·M1). 표현만 other/text_only 로 낮추고 자격 의미(kind)는 바꾸지 않는다.
  // 원래 축·연산자와 강등 사유는 matcher의 원천 정정 보호 및 오프라인 진단에서 사용한다.
  let downgradeReason:
    | "reserved_dimension"
    | "missing_required_source_span"
    | "exclusive_upper_bound_mismatch"
    | "sanction_cause_state_flattening"
    | null = shouldDowngradeToOther(dimension, structuredPremisesAllowed) ? "reserved_dimension" : null;
  if (!downgradeReason && SPAN_REQUIRED_DIMENSIONS.has(dimension) && operator !== "text_only" && !sourceSpan) {
    // M1: 신규 구조화 축이 source_span 없이 왔으면 판정 근거를 신뢰할 수 없다 → 강등.
    downgradeReason = "missing_required_source_span";
  }
  if (
    !downgradeReason
    && dimension === "biz_age"
    && operator !== "text_only"
    && sourceSpan
    && hasExclusiveYearUpperBoundMismatch(sourceSpan, value.value, operator, kind)
  ) {
    // matcher의 정수 월 upper bound는 inclusive다. 원문 "N년 미만"과 모델의 N*12개월
    // 값이 충돌하면 N*12-1로 의도를 추정해 고치지 않고 원문 확인으로 명시 보류한다.
    downgradeReason = "exclusive_upper_bound_mismatch";
  }
  if (
    !downgradeReason
    && dimension === "sanction"
    && (operator === "in" || operator === "not_in")
    && kind === "exclusion"
    && sourceSpan
    && hasSanctionCauseStateFlattening(sourceSpan, value.value)
  ) {
    // "협약 위반 때문에 현재 참여 제한 중"은 원인과 현재 상태의 AND/인과 조건이다.
    // 두 flag를 OR로 평가하면 과거 위반만 있는 회사를 자동 탈락시키므로, 어느 한쪽을
    // 추정해 삭제하지 않고 공용 normalizer에서 원문 확인 대상으로 보류한다.
    downgradeReason = "sanction_cause_state_flattening";
  }
  if (downgradeReason) {
    const originalDimension = dimension;
    const originalOperator = operator;
    const note =
      cleanString(readNote(value.value)) ||
      sourceSpan ||
      `${dimension} 조건 원문 확인 필요`;
    dimension = "other";
    operator = "text_only";
    const criterion: GrantCriterion = {
      id: `${options.sourcePrefix}:${sourceId}:llm-${index + 1}`,
      grant_id: sourceId,
      dimension,
      operator,
      kind,
      value: {
        note,
        downgrade_reason: downgradeReason,
        original_dimension: originalDimension,
        original_operator: originalOperator,
        original_value: value.value,
      },
      confidence: clampNumber(value.confidence, 0.1, 0.95, 0.65),
      needs_review: true,
      parser_version: options.parserVersion,
    };
    if (sourceSpan) {
      criterion.source_span = sourceSpan;
      criterion.raw_text = sourceSpan;
    }
    criterion.source_field = cleanString(value.source_field) || "llm_extracted";
    return criterion;
  }

  const criterion: GrantCriterion = {
    id: `${options.sourcePrefix}:${sourceId}:llm-${index + 1}`,
    grant_id: sourceId,
    dimension,
    operator,
    kind,
    value: structuredPremisesAllowed && premisesCompatibility?.ok
      ? premisesCompatibility.value
      : normalizeCriterionValue(operator, value.value, dimension),
    confidence: clampNumber(value.confidence, 0.1, 0.95, 0.65),
    needs_review: options.forceNeedsReview ? true : Boolean(value.needs_review),
    parser_version: options.parserVersion,
  };
  const sourceField = cleanString(value.source_field) || "llm_extracted";
  // M1 span 정책: 신규 구조화 축은 raw_text 에 원문 전문 복제 금지 → source_span 만 raw_text 로 쓴다.
  // 그 외 축은 기존대로 LLM raw_text(없으면 source_span)를 보존한다.
  const rawText = SPAN_REQUIRED_DIMENSIONS.has(dimension)
    ? sourceSpan
    : cleanString(value.raw_text) || sourceSpan;
  if (sourceSpan) criterion.source_span = sourceSpan;
  if (rawText) criterion.raw_text = rawText;
  criterion.source_field = sourceField;
  const canonical = canonicalizeGrantCriterion(criterion);

  // region 방어: canonicalize가 시도 코드로 환원하지 못한 지역 값은 regions가 비워진다.
  // 그대로 두면 계약 검증(non-empty regions or nationwide)이 공고 전체 추출을 차단하므로,
  // 해당 criterion만 text_only로 강등해 원문 확인 대상으로 보존한다.
  if (canonical.dimension === "region" && canonical.operator !== "text_only") {
    const regionValue = canonical.value as { regions?: string[]; labels?: string[]; nationwide?: boolean };
    if ((regionValue.regions ?? []).length === 0 && regionValue.nationwide !== true) {
      const labelText = (regionValue.labels ?? []).join(", ");
      return {
        ...canonical,
        operator: "text_only",
        value: {
          note: labelText ? `지역 조건 원문 확인 필요: ${labelText}` : "지역 조건 원문 확인 필요",
          downgrade_reason: "region_unresolved",
          original_dimension: canonical.dimension,
          original_operator: canonical.operator,
          original_value: canonical.value,
        },
        needs_review: true,
      };
    }
  }
  return canonical;
}

function hasExclusiveYearUpperBoundMismatch(
  sourceSpan: string,
  rawValue: unknown,
  operator: CriterionOperator,
  kind: CriterionKind,
): boolean {
  const match = /(?:업력(?:\s*조건)?|창업(?:기업|\s*후)?|설립(?:\s*후)?|개업(?:\s*후)?)\s*(?:은|이|가)?\s*[:：]?\s*(\d{1,2})(?![.\d])\s*년\s*미만/u.exec(
    sourceSpan,
  );
  if (!match?.[1]) return false;
  const years = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(years) || years <= 0) return false;
  const canonical = canonicalizeCriterionValue(
    "biz_age",
    operator,
    rawValue as CriterionValue,
    kind,
  ) as {
    max_months?: unknown;
  };
  const maxMonths = canonical.max_months;
  if (typeof maxMonths !== "number" || !Number.isInteger(maxMonths)) return false;
  // 더 좁은 상한은 원문과 충돌하지 않는다. exclusive 경계를 포함하거나 넘길 때만 보류한다.
  return maxMonths >= years * 12;
}

function hasSanctionCauseStateFlattening(sourceSpan: string, rawValue: unknown): boolean {
  const canonical = canonicalizeCriterionValue(
    "sanction",
    "in",
    rawValue as CriterionValue,
    "exclusion",
  ) as { flags?: unknown };
  const flags = Array.isArray(canonical.flags)
    ? canonical.flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  if (!flags.includes("agreement_breach") || !flags.includes("participation_restricted")) {
    return false;
  }
  // 단순 나열("협약 위반 또는 참여 제한")은 잡지 않는다. 실제 원문처럼 위반이
  // 현재 참여 제한의 원인으로 연결되고, 현재 상태("중")가 명시된 경우만 fail-closed한다.
  return /(?:협약|계약)[^\n]{0,24}위반[^\n]{0,16}(?:등으로|으로|로\s*인해|로\s*인하여|사유로)[^\n]{0,20}참여\s*제한[^\n]{0,12}(?:조치\s*)?중/u.test(
    sourceSpan,
  );
}

/** value.note(text_only placeholder) 추출 편의 — 강등 시 note 보존용. */
function readNote(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const note = (value as Record<string, unknown>).note;
  return typeof note === "string" ? note : "";
}

function normalizeCriterionValue(
  operator: CriterionOperator,
  value: unknown,
  dimension: CriterionDimension,
): CriterionValue {
  const objectValue = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (operator === "text_only") {
    return { note: cleanString(objectValue.note) || `${dimension} 조건 원문 확인 필요` };
  }
  if (dimension === "size") return normalizeSizeValue(objectValue);
  if (dimension === "industry") return normalizeIndustryValue(objectValue);
  if (dimension === "employees") return normalizeNumericBounds(objectValue, {
    min: ["min", "min_employees", "minimum"],
    max: ["max", "max_employees", "maximum"],
  });
  if (dimension === "revenue") return normalizeNumericBounds(objectValue, {
    min_krw: ["min_krw", "min_revenue_krw", "minimum_krw"],
    max_krw: ["max_krw", "max_revenue_krw", "maximum_krw"],
  });
  return objectValue;
}

function normalizeIndustryValue(value: Record<string, unknown>): CriterionValue {
  const tags = [...new Set(
    [value.tags, value.industries, value.labels]
      .flatMap((candidate) => Array.isArray(candidate) ? candidate : [])
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  const codes = [...new Set(
    [value.codes, value.ksic_codes, value.kics_codes]
      .flatMap((candidate) => Array.isArray(candidate) ? candidate : [])
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  )];
  const normalized: Record<string, unknown> = { ...value, tags };
  if (codes.length > 0) normalized.codes = codes;
  delete normalized.industries;
  delete normalized.labels;
  delete normalized.ksic_codes;
  delete normalized.kics_codes;
  return normalized;
}

const CANONICAL_SIZES = new Set(["예비", "소상공인", "소기업", "중소기업", "중견기업", "대기업"]);

function normalizeSizeValue(value: Record<string, unknown>): CriterionValue {
  const source = Array.isArray(value.sizes) ? value.sizes : [];
  const sizes = [...new Set(source.flatMap((item) => {
    if (typeof item !== "string") return [];
    const normalized = item.replace(/\s+/g, "").trim();
    if (normalized === "중소" || normalized === "소중기업") return ["중소기업"];
    if (normalized === "소상공") return ["소상공인"];
    return CANONICAL_SIZES.has(normalized) ? [normalized] : [];
  }))];
  return {
    ...value,
    sizes,
  };
}

function normalizeNumericBounds(
  value: Record<string, unknown>,
  aliases: Record<string, string[]>,
): CriterionValue {
  const normalized: Record<string, unknown> = { ...value };
  for (const [canonical, keys] of Object.entries(aliases)) {
    const candidate = keys.map((key) => value[key]).find((item) =>
      typeof item === "number" && Number.isFinite(item));
    if (candidate !== undefined) normalized[canonical] = candidate;
    for (const alias of keys) {
      if (alias !== canonical) delete normalized[alias];
    }
  }
  return normalized;
}

/**
 * LLM 이 emit 할 수 있는 dimension enum — 예약 2축(premises/export_performance)은 제외한다(M4).
 * 이 축은 프로필 파이프라인·evaluator 가 아직 활성화되지 않아 LLM 이 emit 하면 해소 불가 unknown 이 된다.
 */
const RESERVED_LLM_EXCLUDED_DIMENSIONS = new Set(["premises", "export_performance"]);
const LLM_EMITTABLE_DIMENSIONS = CRITERION_DIMENSIONS.filter(
  (dimension) => !RESERVED_LLM_EXCLUDED_DIMENSIONS.has(dimension),
);

export function buildGrantCriteriaToolSchema() {
  return {
    name: "emit_grant_criteria",
    description: "기업마당 공고 자격조건 추출 결과를 반환한다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        criteria: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...LLM_EMITTABLE_DIMENSIONS] },
              operator: { type: "string", enum: [...CRITERION_OPERATORS] },
              kind: { type: "string", enum: [...CRITERION_KINDS] },
              value: { type: "object" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              source_span: { type: "string" },
              raw_text: { type: "string" },
              source_field: { type: "string" },
              needs_review: { type: "boolean" },
            },
            required: ["dimension", "operator", "kind", "value", "confidence"],
          },
        },
        required_documents: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              required: { type: "boolean" },
              source: { type: "string", enum: ["self", "portal", "cert"] },
              source_span: { type: "string" },
              note: { type: "string" },
            },
            required: ["name", "required", "source", "source_span"],
          },
        },
      },
      required: ["criteria", "required_documents"],
    },
  };
}

/** @deprecated source-neutral schema는 buildGrantCriteriaToolSchema를 사용한다. */
export const buildBizInfoCriteriaToolSchema = buildGrantCriteriaToolSchema;

function normalizeRequiredDocumentRow(row: unknown): GrantRequiredDocument | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  const name = cleanString(value.name);
  const sourceSpan = cleanString(value.source_span);
  if (!name || !sourceSpan) return null;

  const document: GrantRequiredDocument = {
    name,
    required: typeof value.required === "boolean" ? value.required : true,
    source: stringEnum(value.source, ["self", "portal", "cert"] as const) ?? "self",
    source_span: sourceSpan,
  };
  const note = cleanString(value.note);
  if (note) document.note = note;
  return normalizeGrantRequiredDocument(document);
}

function stringEnum<T extends readonly string[]>(value: unknown, options: T): T[number] | null {
  if (typeof value !== "string") return null;
  return (options as readonly string[]).includes(value) ? value as T[number] : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}
