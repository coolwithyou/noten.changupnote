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
import { assertGrantCriteriaContract } from "./criteria-contract.js";
import type { BizInfoProgramExtractionInput } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

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
  usage: Record<string, unknown> | null;
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
        "업종은 공고 표현을 가능한 짧은 한국어 정책 태그로 추출한다. 모호하면 text_only 조건으로 남긴다.",
        "휴폐업 제외 조건은 dimension=business_status, operator=not_in, kind=exclusion, value={\"statuses\":[\"closed\"],\"labels\":[\"휴폐업\"]} 로 추출한다.",
        "",
        "[결격(배제) 조건 구조화 — 아래 축으로 반드시 분해한다]",
        "- 세금·공과금 체납: dimension=tax_compliance, operator=in, kind=exclusion, value.flags=[국세=national_tax_delinquent, 지방세=local_tax_delinquent, 관세=customs_delinquent, 4대보험료=social_insurance_delinquent] 중 해당. 납부기한 연장·징수유예 등 예외 문구가 있으면 value.exceptions=[\"payment_deferral_approved\"].",
        "- 신용·금융 상태: dimension=credit_status, operator=in, kind=exclusion, value.flags=[연체=credit_delinquency, 채무불이행=loan_default, 부도=bond_default, 회생·개인회생=rehabilitation_in_progress, 파산=bankruptcy_filed, 법정관리·청산=court_receivership, 금융질서문란=financial_misconduct, 압류=asset_seizure, 보증금지·보증제한=guarantee_restricted] 중 해당. 변제 정상이행 예외→exceptions=[\"repayment_plan_in_good_standing\"], 시효소멸 예외→[\"statute_expired\"].",
        "- 제재·참여제한: dimension=sanction, operator=in, kind=exclusion, value.flags=[참여제한=participation_restricted, 부정수급·환수=subsidy_fraud, 보조금법위반·특수관계=subsidy_law_violation, 의무불이행=obligation_breach, 임금체불명단=wage_arrears_listed, 중대재해명단=serious_accident_listed, 협약·계약위반=agreement_breach] 중 해당.",
        "- 재무건전성: dimension=financial_health, kind=exclusion, value.debt_ratio_pct_threshold={\"value\":숫자,\"inclusive\":이상=true/초과=false}, value.impairment_excluded=[\"partial\"|\"full\"](자본잠식만 언급 시 [\"partial\",\"full\"]), value.min_interest_coverage=숫자.",
        "- 고용보험·피보험자: dimension=insured_workforce, value.employment_insurance_required=true / min_insured·max_insured 숫자 / no_layoff_within_months 숫자.",
        "- 투자유치: dimension=investment, value.min_total_krw(원 단위 정수) / rounds / tips_operator_required.",
        "- 배제업종(유흥주점·사행시설·암호화자산·부동산·도박): dimension=industry, operator=not_in, kind=exclusion, value.labels=[업종명].",
        "",
        "[구조화 금지 — other text_only exclusion 으로만 남긴다]",
        "- 중복수혜·동일사업 중복지원·타부처 중복·참여 중 과제·창업사관학교/NEST 등 프로그램 수료·참여 이력은 절대 prior_award(또는 위 결격 축)로 만들지 말고 other text_only exclusion 으로 둔다.",
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
      tools: [buildBizInfoCriteriaToolSchema()],
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

  return {
    criteria: normalizeBizInfoLlmCriteria(toolUse.input, options.input.source_id),
    requiredDocuments: normalizeBizInfoLlmRequiredDocuments(toolUse.input),
    model,
    usage: payload.usage ?? null,
  };
}

export function normalizeBizInfoLlmCriteria(payload: unknown, sourceId: string): GrantCriterion[] {
  const rows = Array.isArray((payload as { criteria?: unknown[] } | null)?.criteria)
    ? (payload as { criteria: unknown[] }).criteria
    : [];

  const criteria = rows.flatMap((row, index) => {
    const criterion = normalizeCriterionRow(row, sourceId, index);
    return criterion ? [criterion] : [];
  });
  assertGrantCriteriaContract(criteria, `bizinfo:${sourceId}`);
  return criteria;
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
 * 구조화 금지 축 강등(C2/M4). LLM 이 아래를 반환하면 evaluator·프로필이 없어 false pass·해소 불가 unknown 을
 * 유발하므로 other/text_only exclusion 으로 강등한다(span·label 보존):
 *   - prior_award + exclusion (중복수혜·참여 이력류) — C2: exact-match evaluator 로는 판정 불가
 *   - premises / export_performance (예약 2축) — M4: 파이프라인 미활성
 */
const PRIOR_AWARD_DIMENSION = "prior_award";

function shouldDowngradeToOther(dimension: CriterionDimension, kind: CriterionKind): boolean {
  if (RESERVED_LLM_EXCLUDED_DIMENSIONS.has(dimension)) return true; // M4 예약 2축
  if (dimension === PRIOR_AWARD_DIMENSION && kind === "exclusion") return true; // C2
  return false;
}

/**
 * M1 span 정책 대상 축 — 신규 결격/재무/고용/투자 축. 이 축의 구조화 criteria 는
 * `source_span` 이 필수이고, `raw_text` 에 원문 전문 복제를 금지한다(HIGH_RISK_DOMAIN_PATTERN 오탐 방지).
 * source_span 이 없으면 other/text_only 로 강등한다.
 */
const SPAN_REQUIRED_DIMENSIONS = new Set<string>([
  "tax_compliance",
  "credit_status",
  "sanction",
  "financial_health",
  "insured_workforce",
  "investment",
]);

function normalizeCriterionRow(row: unknown, sourceId: string, index: number): GrantCriterion | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  let dimension = stringEnum(value.dimension, CRITERION_DIMENSIONS);
  const kind = stringEnum(value.kind, CRITERION_KINDS);
  let operator = stringEnum(value.operator, CRITERION_OPERATORS) ?? "text_only";
  if (!dimension || !kind) return null;

  const sourceSpan = cleanString(value.source_span);

  // 강등 판정(C2·M4·M1). 강등 대상은 other/text_only exclusion 으로 내리고 span·라벨을 note 로 보존한다.
  let downgraded = shouldDowngradeToOther(dimension, kind);
  if (!downgraded && SPAN_REQUIRED_DIMENSIONS.has(dimension) && operator !== "text_only" && !sourceSpan) {
    // M1: 신규 구조화 축이 source_span 없이 왔으면 판정 근거를 신뢰할 수 없다 → 강등.
    downgraded = true;
  }
  if (downgraded) {
    const note =
      cleanString(readNote(value.value)) ||
      sourceSpan ||
      `${dimension} 조건 원문 확인 필요`;
    dimension = "other";
    operator = "text_only";
    const criterion: GrantCriterion = {
      id: `bizinfo:${sourceId}:llm-${index + 1}`,
      grant_id: sourceId,
      dimension,
      operator,
      kind: "exclusion",
      value: { note },
      confidence: clampNumber(value.confidence, 0.1, 0.95, 0.65),
      needs_review: true,
      parser_version: BIZINFO_NORMALIZER_VERSION,
    };
    if (sourceSpan) {
      criterion.source_span = sourceSpan;
      criterion.raw_text = sourceSpan;
    }
    criterion.source_field = cleanString(value.source_field) || "llm_extracted";
    return criterion;
  }

  const criterion: GrantCriterion = {
    id: `bizinfo:${sourceId}:llm-${index + 1}`,
    grant_id: sourceId,
    dimension,
    operator,
    kind,
    value: normalizeCriterionValue(operator, value.value, dimension),
    confidence: clampNumber(value.confidence, 0.1, 0.95, 0.65),
    needs_review: Boolean(value.needs_review),
    parser_version: BIZINFO_NORMALIZER_VERSION,
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
  return criterion;
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
  return objectValue;
}

/**
 * LLM 이 emit 할 수 있는 dimension enum — 예약 2축(premises/export_performance)은 제외한다(M4).
 * 이 축은 프로필 파이프라인·evaluator 가 아직 활성화되지 않아 LLM 이 emit 하면 해소 불가 unknown 이 된다.
 */
const RESERVED_LLM_EXCLUDED_DIMENSIONS = new Set(["premises", "export_performance"]);
const LLM_EMITTABLE_DIMENSIONS = CRITERION_DIMENSIONS.filter(
  (dimension) => !RESERVED_LLM_EXCLUDED_DIMENSIONS.has(dimension),
);

export function buildBizInfoCriteriaToolSchema() {
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
