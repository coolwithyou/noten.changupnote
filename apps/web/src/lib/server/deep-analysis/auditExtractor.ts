import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
  assertDeepAnalysisModelEffort,
  supportsDeepAnalysisEffort,
  type CriterionDimension,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisEffort,
  type DeepAnalysisModelResult,
  type DeepAnalysisUsage,
} from "@cunote/contracts";
import { priceDeepAnalysisUsage } from "./costPolicy";
import {
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  DEEP_ANALYSIS_SCORING_TABLE_COMPLETENESS_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  normalizeCriteria,
} from "./extractor";
import { createDeepAnalysisAuditEvidenceCatalog } from "./auditEvidence";

export const DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION =
  "deep-analysis-audit-candidates-v4" as const;
export const DEEP_ANALYSIS_AUDIT_TOOL_NAME =
  "emit_deep_analysis_audit_candidates" as const;

export const DEEP_ANALYSIS_AUDIT_CONTRACT_REPAIR_CODES = [
  "financial_health_impairment_scalar_to_array",
  "prior_award_incubation_tenancy_scope",
  "prior_award_same_year_other_support_scope",
  "prior_award_unsupported_monetary_threshold_to_text_only",
] as const;

export type DeepAnalysisAuditContractRepairCode =
  (typeof DEEP_ANALYSIS_AUDIT_CONTRACT_REPAIR_CODES)[number];

export interface DeepAnalysisAuditContractRepair {
  index: number;
  code: DeepAnalysisAuditContractRepairCode;
}

const AUDIT_MAX_TOKENS = 8_000;
const AUDIT_TIMEOUT_MS = 540_000;
const AUDIT_RETRY_DELAY_MS = 5_000;
const AUDIT_RETRYABLE_STATUSES = new Set([429, 500, 529]);

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content?: Array<AnthropicToolUseBlock | { type: string; text?: string }>;
  stop_reason?: string;
  usage?: Record<string, unknown>;
}

/**
 * Blind audit는 primary 분석 문서 전체를 다시 쓰지 않는다. 원문에서 직접 확인한
 * 신청 자격·결격·우대·배점 criterion 후보만 반환하고, 22축 부재 상태는 서버가
 * 후보 집합으로부터 결정적으로 만든다.
 */
export const DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT = [
  "너는 정부지원사업 공고의 독립 자격조건 감사자다. primary 결과는 보지 않는다.",
  "출력은 원문에서 직접 확인한 신청 자격·결격·우대·평가점수 criterion 후보만 포함한다.",
  "조건이 없는 축을 표현하는 행을 만들지 마라. inspected_no_condition, ambiguous, input_missing은 criterion kind가 아니다.",
  "분석문, 축별 상태표, 공고 요약, 프로그램 의도, taxonomy 제안은 출력하지 마라.",
  "각 후보는 제공된 evidence catalog의 primary_source_ref 하나를 반드시 선택한다. source_span 문자열을 직접 만들지 마라.",
  "예외처럼 같은 판단을 뒷받침하는 별도 근거가 있을 때만 supporting_source_refs를 사용한다. 서로 다른 매칭 효과는 한 후보로 합치지 말고 나눈다.",
  "필수조건은 required, 제외대상은 exclusion, 우대·평가점수는 preferred다.",
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_SCORING_TABLE_COMPLETENESS_RULE,
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  "지역 코드는 서울 11, 부산 26, 대구 27, 인천 28, 광주 29, 대전 30, 울산 31, 세종 36, 경기 41, 강원 42, 충북 43, 충남 44, 전북 45, 전남 46, 경북 47, 경남 48, 제주 50을 사용한다.",
  "region={regions:[시도코드],nationwide?}, biz_age={min_months?,max_months?,include_preliminary?}, industry={tags:[문자열]}, size={sizes:[예비|소상공인|소기업|중소기업|중견기업|대기업]}, revenue={min_krw?,max_krw?}, employees={min?,max?}, founder_age={ranges:[{min?,max?,label}]}, founder_trait={traits:[문자열]}, certification={certs:[문자열]}, ip={types:[문자열]}, target_type={targets:[문자열]} 형식을 사용한다.",
  "세금·공과금 체납은 dimension=tax_compliance, operator=in, kind=exclusion, value.flags=[national_tax_delinquent|local_tax_delinquent|customs_delinquent|social_insurance_delinquent]를 사용한다. 예외는 payment_deferral_approved, tax_debt_repaid_with_proof, restart_funding_recipient, retry_guarantee_recipient 중 원문에 명시된 값만 value.exceptions에 둔다.",
  "신용·금융 상태는 dimension=credit_status, operator=in, kind=exclusion, value.flags=[credit_delinquency|loan_default|bond_default|rehabilitation_in_progress|bankruptcy_filed|court_receivership|financial_misconduct|asset_seizure|guarantee_restricted]를 사용한다. 예외는 credit_debt_repaid_with_proof, debt_adjustment_agreement, court_plan_approved, bankruptcy_discharge_confirmed, repayment_plan_in_good_standing, statute_expired, restart_funding_recipient, retry_guarantee_recipient 중 원문에 명시된 값만 value.exceptions에 둔다.",
  "제재·참여제한은 dimension=sanction, operator=in, kind=exclusion, value.flags=[participation_restricted|subsidy_fraud|subsidy_law_violation|obligation_breach|wage_arrears_listed|serious_accident_listed|agreement_breach]를 사용한다.",
  "재무건전성은 dimension=financial_health, kind=exclusion, value에 debt_ratio_pct_threshold, impairment_excluded, min_interest_coverage 중 원문에 있는 값만 둔다. impairment_excluded는 반드시 [\"partial\"|\"full\"] 배열이며, 자본잠식만 언급하면 [\"partial\",\"full\"], 자본전액잠식이면 [\"full\"]을 사용한다.",
  "prior_award exclusion은 범위를 반드시 value.scope로 명시한다. 동일·유사 지원, 동일 과제, 본 사업 과거 선정, 당해연도 타부처 중복은 scope=self와 self_kind를 쓰고, 창업보육센터·지역센터 입주 이력은 scope=self, channel=incubation_tenancy를 사용한다.",
  "특정 사업·사업유형 수혜 이력은 scope=program|program_type과 비어 있지 않은 programs를 사용한다. 금액 임계가 붙은 과거 지원 이력처럼 현재 prior_award canonical로 무손실 표현할 수 없거나 범위를 특정할 수 없으면 other/text_only exclusion과 exact evidence note로 보존한다.",
  "고용보험·피보험자 조건은 insured_workforce, 투자유치 하한은 investment/gte와 value.min_total_krw를 사용한다. 투자 상한은 investment/text_only와 value.note로 보존한다.",
  "premises와 export_performance는 해당 dimension의 text_only와 value.note로 보존한다.",
  "canonical value를 안전하게 만들 수 없는 명시적 매칭 규정은 other/text_only와 value.note로 보존한다.",
].join("\n");

export function buildDeepAnalysisAuditToolSchema() {
  return {
    name: DEEP_ANALYSIS_AUDIT_TOOL_NAME,
    description: "공고 원문에서 독립적으로 확인한 신청 자격·결격·우대·배점 criterion 후보만 반환한다.",
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
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
              operator: { type: "string", enum: [...CRITERION_OPERATORS] },
              kind: { type: "string", enum: [...CRITERION_KINDS] },
              value: { type: "object" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              primary_source_ref: { type: "string", minLength: 19, maxLength: 19 },
              supporting_source_refs: {
                type: "array",
                maxItems: 8,
                items: { type: "string", minLength: 19, maxLength: 19 },
              },
              note: { type: "string" },
            },
            required: [
              "dimension",
              "operator",
              "kind",
              "value",
              "confidence",
              "primary_source_ref",
            ],
          },
        },
      },
      required: ["criteria"],
    },
  };
}

export function normalizeDeepAnalysisAuditCandidateResult(input: {
  model: string;
  effort: DeepAnalysisEffort | null;
  evidenceText: string;
  rawToolInput: unknown;
  rawResponseText: string;
  stopReason: string | null;
  usage: DeepAnalysisUsage | null;
}): DeepAnalysisModelResult {
  const directToolInput = isRecord(input.rawToolInput) ? input.rawToolInput : {};
  const authoredCriteria = Array.isArray(directToolInput.criteria)
    ? directToolInput.criteria
    : [];
  const evidenceCatalog = createDeepAnalysisAuditEvidenceCatalog(input.evidenceText);
  const resolved = evidenceCatalog.resolveCriteria(authoredCriteria);
  const repaired = repairDeepAnalysisAuditCriteriaContract(resolved.criteria);
  const rawCriteria = repaired.criteria;
  const criteria = normalizeCriteria(rawCriteria, input.evidenceText);
  const foundDimensions = new Set<CriterionDimension>(
    criteria.map((criterion) => criterion.dimension),
  );
  const axisAssessments: DeepAnalysisAxisAssessment[] = CRITERION_DIMENSIONS.map(
    (dimension) => ({
      dimension,
      status: foundDimensions.has(dimension)
        ? "condition_found"
        : "inspected_no_condition",
      confidence: foundDimensions.has(dimension) ? 1 : 0,
      comment: foundDimensions.has(dimension)
        ? "audit criterion 후보에서 결정적으로 파생"
        : "audit criterion 후보 없음",
    }),
  );
  const rawAxes = axisAssessments.map((axis) => ({
    dimension: axis.dimension,
    status: axis.status,
    confidence: axis.confidence,
    comment: axis.comment,
  }));
  return {
    model: input.model,
    effort: input.effort,
    analysisMarkdown: "",
    programIntent: null,
    criteria,
    axisAssessments,
    taxonomyProposals: [],
    usage: input.usage,
    costUsd: input.usage
      ? priceDeepAnalysisUsage({ model: input.model, usage: input.usage })
      : null,
    rawToolInput: {
      audit_contract_version: DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION,
      criteria: rawCriteria,
      axis_assessments: rawAxes,
      audit_authored_criteria: resolved.criteria,
      audit_contract_repairs: repaired.repairs,
      audit_source_reference_errors: resolved.unresolvedReferences,
    },
    rawResponseText: input.rawResponseText,
    stopReason: input.stopReason,
  };
}

/**
 * Blind audit 모델이 찾은 사실은 유지하되, sealed exact evidence만으로 의미가
 * 하나로 결정되는 구형/축약 value 형태만 현재 typed criterion 계약으로 복원한다.
 * 의미가 여러 방식으로 해석될 수 있는 누락은 그대로 두어 validator가 fail-closed
 * 처리한다.
 */
export function repairDeepAnalysisAuditCriteriaContract(rows: unknown[]): {
  criteria: unknown[];
  repairs: DeepAnalysisAuditContractRepair[];
} {
  const repairs: DeepAnalysisAuditContractRepair[] = [];
  const criteria = rows.map((row, index) => {
    if (!isRecord(row) || !isRecord(row.value)) return row;

    if (row.dimension === "financial_health") {
      const impairment = row.value.impairment_excluded;
      if (impairment === "partial" || impairment === "full") {
        repairs.push({
          index,
          code: "financial_health_impairment_scalar_to_array",
        });
        return {
          ...row,
          value: {
            ...row.value,
            impairment_excluded: [impairment],
          },
        };
      }
      return row;
    }

    if (
      row.dimension !== "prior_award"
      || row.kind !== "exclusion"
    ) {
      return row;
    }

    const sourceSpan = cleanString(row.source_span);
    if (!sourceSpan) return row;
    const normalizedSpan = normalizeAuditContractEvidence(sourceSpan);
    const scope = cleanString(row.value.scope);
    if (scope && scope !== "self") return row;

    if (isIncubationTenancyEvidence(normalizedSpan)) {
      if (
        scope === "self"
        && row.value.channel === "incubation_tenancy"
        && typeof row.value.self_kind !== "string"
      ) {
        return row;
      }
      repairs.push({
        index,
        code: "prior_award_incubation_tenancy_scope",
      });
      return {
        ...row,
        value: {
          ...withoutPriorAwardSelfKind(row.value),
          scope: "self",
          channel: "incubation_tenancy",
        },
      };
    }

    if (isSameYearOtherSupportEvidence(normalizedSpan)) {
      if (
        scope === "self"
        && row.value.self_kind === "same_year_other_support"
      ) {
        return row;
      }
      repairs.push({
        index,
        code: "prior_award_same_year_other_support_scope",
      });
      return {
        ...row,
        value: {
          ...withoutLegacyPriorAwardProgramKeys(row.value),
          scope: "self",
          self_kind: "same_year_other_support",
          channel: "general",
        },
      };
    }

    if (!scope && isUnsupportedPriorAwardMonetaryThreshold(normalizedSpan)) {
      repairs.push({
        index,
        code: "prior_award_unsupported_monetary_threshold_to_text_only",
      });
      return {
        ...row,
        dimension: "other",
        operator: "text_only",
        value: { note: sourceSpan },
      };
    }

    return row;
  });
  return { criteria, repairs };
}

function normalizeAuditContractEvidence(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function isIncubationTenancyEvidence(value: string): boolean {
  return /(?:센터|보육).{0,30}(?:기\s*)?입주(?:\s*경력|\s*이력)?/u.test(value)
    || /(?:기\s*)?입주(?:\s*경력|\s*이력)?.{0,30}(?:센터|보육)/u.test(value);
}

function isSameYearOtherSupportEvidence(value: string): boolean {
  return /(?:당해|해당|동일|같은)\s*연도/u.test(value)
    && /(?:중복|기\s*수혜|수혜|지원)/u.test(value);
}

function isUnsupportedPriorAwardMonetaryThreshold(value: string): boolean {
  return /\d[\d,]*(?:\.\d+)?\s*(?:조|억|천만|백만|만)?\s*원\s*(?:이상|초과|미만|이하)/u
    .test(value)
    && /(?:지원|수혜)/u.test(value);
}

function withoutLegacyPriorAwardProgramKeys(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const {
    program_names: _programNames,
    programs: _programs,
    ...rest
  } = value;
  return rest;
}

function withoutPriorAwardSelfKind(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const {
    self_kind: _selfKind,
    ...rest
  } = withoutLegacyPriorAwardProgramKeys(value);
  return rest;
}

export async function runDeepGrantAuditAnalysis(options: {
  apiKey: string;
  inputText: string;
  evidenceText?: string;
  model?: string;
  effort?: DeepAnalysisEffort | null;
  taskInstruction?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeepAnalysisModelResult> {
  const model = options.model ?? "claude-haiku-4-5-20251001";
  const effort = options.effort === undefined
    ? supportsDeepAnalysisEffort(model) ? "high" : null
    : options.effort;
  assertDeepAnalysisModelEffort({ model, effort });
  const evidenceCatalog = createDeepAnalysisAuditEvidenceCatalog(
    options.evidenceText ?? options.inputText,
  );
  const modelInputText = isAuditSynthesisInput(options.inputText)
    ? options.inputText
    : evidenceCatalog.promptText;
  const requestBody = JSON.stringify({
    model,
    max_tokens: AUDIT_MAX_TOKENS,
    ...(effort ? { output_config: { effort } } : {}),
    system: DEEP_ANALYSIS_AUDIT_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        options.taskInstruction
          ?? "아래 sealed 공고 입력만 근거로 criterion 후보를 빠짐없이 추출하라.",
        "",
        modelInputText,
      ].join("\n"),
    }],
    tools: [buildDeepAnalysisAuditToolSchema()],
    tool_choice: { type: "tool", name: DEEP_ANALYSIS_AUDIT_TOOL_NAME },
  });

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
    try {
      return await (options.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: requestBody,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Anthropic audit extraction timed out after ${AUDIT_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  let response = await attempt();
  if (AUDIT_RETRYABLE_STATUSES.has(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, AUDIT_RETRY_DELAY_MS));
    response = await attempt();
  }
  const rawResponseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic audit extraction failed: ${response.status} ${response.statusText}\n${rawResponseText.slice(0, 1_000)}`,
    );
  }
  const payload = JSON.parse(rawResponseText) as AnthropicMessageResponse;
  const toolUse = payload.content?.find(
    (block): block is AnthropicToolUseBlock =>
      block.type === "tool_use"
      && "name" in block
      && block.name === DEEP_ANALYSIS_AUDIT_TOOL_NAME,
  );
  if (!toolUse) {
    if (payload.stop_reason === "max_tokens") {
      throw new Error(
        `Audit candidate output reached max_tokens=${AUDIT_MAX_TOKENS} before tool_use.`,
      );
    }
    throw new Error(
      `Anthropic response has no ${DEEP_ANALYSIS_AUDIT_TOOL_NAME} tool_use (stop_reason=${payload.stop_reason ?? "unknown"}).`,
    );
  }
  return normalizeDeepAnalysisAuditCandidateResult({
    model,
    effort,
    evidenceText: options.evidenceText ?? options.inputText,
    rawToolInput: toolUse.input,
    rawResponseText,
    stopReason: payload.stop_reason ?? null,
    usage: normalizeUsage(payload.usage),
  });
}

function isAuditSynthesisInput(inputText: string): boolean {
  return inputText.includes(
    `"auditContractVersion":"${DEEP_ANALYSIS_AUDIT_CONTRACT_VERSION}"`,
  );
}

function normalizeUsage(usage: Record<string, unknown> | undefined): DeepAnalysisUsage | null {
  if (!usage) return null;
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: finiteNumber(usage.cache_read_input_tokens),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
