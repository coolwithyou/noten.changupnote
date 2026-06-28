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
      max_tokens: 1800,
      temperature: 0,
      system: [
        "너는 정부지원사업 공고의 신청 자격조건을 구조화하는 추출기다.",
        "입력 텍스트에 명시된 조건만 추출하고, 추정하지 않는다.",
        "지역 코드는 한국 시도 행정코드 2자리(서울 11, 부산 26, 대구 27, 인천 28, 광주 29, 대전 30, 울산 31, 세종 36, 경기 41, 강원 42, 충북 43, 충남 44, 전북 45, 전남 46, 경북 47, 경남 48, 제주 50)를 사용한다.",
        "규모 값은 예비, 소상공인, 소기업, 중소기업, 중견기업, 대기업 중에서만 사용한다.",
        "업종은 공고 표현을 가능한 짧은 한국어 정책 태그로 추출한다. 모호하면 text_only 조건으로 남긴다.",
        "휴폐업 제외 조건은 dimension=business_status, operator=not_in, kind=exclusion, value={\"statuses\":[\"closed\"],\"labels\":[\"휴폐업\"]} 로 추출한다.",
        "세금 체납, 제재, 중복수혜처럼 팝빌 휴폐업 상태만으로 판정할 수 없는 배제 조건은 other text_only exclusion으로 남긴다.",
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

function normalizeCriterionRow(row: unknown, sourceId: string, index: number): GrantCriterion | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  const dimension = stringEnum(value.dimension, CRITERION_DIMENSIONS);
  const kind = stringEnum(value.kind, CRITERION_KINDS);
  const operator = stringEnum(value.operator, CRITERION_OPERATORS) ?? "text_only";
  if (!dimension || !kind) return null;

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
  const sourceSpan = cleanString(value.source_span);
  const rawText = cleanString(value.raw_text) || sourceSpan;
  const sourceField = cleanString(value.source_field) || "llm_extracted";
  if (sourceSpan) criterion.source_span = sourceSpan;
  if (rawText) criterion.raw_text = rawText;
  criterion.source_field = sourceField;
  return criterion;
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
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
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
