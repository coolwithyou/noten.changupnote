import { createHash } from "node:crypto";
import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
  type GrantCriterion,
  type GrantRequiredDocument,
} from "@cunote/contracts";
import {
  DEFAULT_ANTHROPIC_MODEL,
  buildBizInfoDeterministicCriteria,
  buildGrantCriteriaToolSchema,
  buildKStartupCriteria,
  canonicalizeGrantCriteria,
  mergeBizInfoDeterministicCriteria,
  mergeKStartupLlmCriteria,
  normalizeBizInfoLlmRequiredDocuments,
  normalizeGrantLlmCriteria,
  type BizInfoProgram,
  type BizInfoProgramExtractionInput,
  type KStartupAnnouncement,
  type KStartupExtractionInput,
} from "@cunote/core";

export const GRANT_ANALYSIS_PILOT_EXTRACTOR_VERSION = "grant-analysis-pilot-v1";

const RESERVED_DIMENSIONS = new Set<CriterionDimension>(["premises", "export_performance"]);
const PILOT_MODEL_DIMENSIONS = CRITERION_DIMENSIONS.filter(
  (dimension): dimension is Exclude<CriterionDimension, "premises" | "export_performance"> =>
    !RESERVED_DIMENSIONS.has(dimension),
);

export type PilotAxisModelStatus =
  | "condition_found"
  | "inspected_no_condition"
  | "ambiguous"
  | "input_missing";

export interface PilotAxisObservation {
  dimension: Exclude<CriterionDimension, "premises" | "export_performance">;
  modelStatus: PilotAxisModelStatus | "not_returned";
  effectiveStatus: PilotAxisModelStatus | "not_returned";
  confidence: number;
  evidenceSpans: string[];
  note: string;
  issues: string[];
}

export interface GrantAnalysisPilotPromptMetrics {
  sourceCharacters: number;
  includedCharacters: number;
  apiCharactersAvailable: number;
  apiCharactersIncluded: number;
  attachmentCharactersAvailable: number;
  attachmentCharactersIncluded: number;
  truncatedBlockCount: number;
  includedBlockCount: number;
  inputSha256: string;
}

export interface GrantAnalysisPilotExtractionResult {
  criteria: GrantCriterion[];
  requiredDocuments: GrantRequiredDocument[];
  axes: PilotAxisObservation[];
  normalizationRepairs: PilotNormalizationRepair[];
  model: string;
  usage: Record<string, unknown> | null;
  prompt: GrantAnalysisPilotPromptMetrics;
}

export interface PilotNormalizationRepair {
  rowIndex: number;
  action: "downgrade_to_text_only" | "drop_duplicate";
  reason: string;
}

type CommonExtractionOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

export type GrantAnalysisPilotExtractionOptions = CommonExtractionOptions & ({
  source: "kstartup";
  payload: KStartupAnnouncement;
  input: KStartupExtractionInput;
} | {
  source: "bizinfo";
  payload: BizInfoProgram;
  input: BizInfoProgramExtractionInput;
});

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface AnthropicMessageResponse {
  content?: Array<AnthropicToolUseBlock | { type: string; text?: string }>;
  usage?: Record<string, unknown>;
}

interface PilotBlock {
  label: string;
  source: "api_field" | "detail_section" | "attachment_markdown";
  source_field?: PropertyKey;
  filename?: string;
  text: string;
}

/**
 * A/B/C 파일럿 전용 추출기다. 결과는 초안이며 DB에 쓰지 않는다.
 * B와 C는 같은 모델·스키마를 사용하고, 유일한 실험 변수는 첨부 블록 유무다.
 */
export async function extractGrantAnalysisPilotWithAnthropic(
  options: GrantAnalysisPilotExtractionOptions,
): Promise<GrantAnalysisPilotExtractionResult> {
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const rendered = renderBalancedPilotInput(options.input);
  const response = await (options.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 5_000,
      temperature: 0,
      system: PILOT_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          "아래 공고 입력만 근거로 신청 자격조건과 20개 활성 축의 검사 상태를 반환해라.",
          "axis_assessments에는 각 활성 축을 정확히 한 번씩 넣어라.",
          "공고 밖의 상식이나 사업명만으로 조건을 추정하지 마라.",
          "",
          rendered.text,
        ].join("\n"),
      }],
      tools: [buildPilotToolSchema()],
      tool_choice: { type: "tool", name: "emit_grant_analysis_pilot" },
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic pilot extraction failed: ${response.status} ${response.statusText}\n${body.slice(0, 1_000)}`,
    );
  }
  const payload = JSON.parse(body) as AnthropicMessageResponse;
  const toolUse = payload.content?.find(
    (block): block is AnthropicToolUseBlock =>
      block.type === "tool_use" && "name" in block && block.name === "emit_grant_analysis_pilot",
  );
  if (!toolUse) throw new Error("Anthropic response did not contain emit_grant_analysis_pilot tool_use");

  const sourceId = options.input.source_id;
  const normalizedRows = normalizePilotCriteriaRows(toolUse.input, sourceId, options.source);
  const normalized = normalizedRows.criteria;
  const evidenceGated = gatePilotCriterionEvidence(normalized, rendered.blocks);
  const criteria = canonicalizeGrantCriteria(options.source === "kstartup"
    ? mergeKStartupLlmCriteria(buildKStartupCriteria(options.payload), evidenceGated)
    : mergeBizInfoDeterministicCriteria(buildBizInfoDeterministicCriteria(options.input), evidenceGated));
  const requiredDocuments = normalizeBizInfoLlmRequiredDocuments(toolUse.input)
    .filter((document) => Boolean(findEvidenceBlock(document.source_span ?? "", rendered.blocks)));
  const axes = normalizePilotAxes(toolUse.input, criteria, rendered.blocks);

  return {
    criteria,
    requiredDocuments,
    axes,
    normalizationRepairs: normalizedRows.repairs,
    model,
    usage: payload.usage ?? null,
    prompt: rendered.metrics,
  };
}

export function buildPilotToolSchema() {
  const base = buildGrantCriteriaToolSchema();
  return {
    ...base,
    name: "emit_grant_analysis_pilot",
    description: "공고 자격조건과 축별 검사 완전성을 함께 반환한다.",
    input_schema: {
      ...base.input_schema,
      properties: {
        ...base.input_schema.properties,
        axis_assessments: {
          type: "array",
          minItems: PILOT_MODEL_DIMENSIONS.length,
          maxItems: PILOT_MODEL_DIMENSIONS.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...PILOT_MODEL_DIMENSIONS] },
              status: {
                type: "string",
                enum: ["condition_found", "inspected_no_condition", "ambiguous", "input_missing"],
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              evidence_spans: { type: "array", items: { type: "string" }, maxItems: 3 },
              note: { type: "string" },
            },
            required: ["dimension", "status", "confidence", "evidence_spans", "note"],
          },
        },
      },
      required: [...base.input_schema.required, "axis_assessments"],
    },
  };
}

export function renderBalancedPilotInput(
  input: Pick<KStartupExtractionInput | BizInfoProgramExtractionInput, "source" | "source_id" | "title" | "text" | "blocks">,
  options: { maxApiChars?: number; maxAttachmentChars?: number } = {},
): { text: string; blocks: PilotBlock[]; metrics: GrantAnalysisPilotPromptMetrics } {
  const maxApiChars = options.maxApiChars ?? 14_000;
  const maxAttachmentChars = options.maxAttachmentChars ?? 18_000;
  const sourceBlocks = input.blocks as PilotBlock[];
  const apiBlocks = sourceBlocks.filter((block) => block.source !== "attachment_markdown");
  const attachmentBlocks = sourceBlocks.filter((block) => block.source === "attachment_markdown");
  const includedApi = capBlocks(apiBlocks, maxApiChars);
  const includedAttachments = capBlocks(attachmentBlocks, maxAttachmentChars);
  const blocks = [...includedApi.blocks, ...includedAttachments.blocks];
  const text = [
    `[${input.source} 공고 분석 파일럿 입력]`,
    `source_id: ${input.source_id}`,
    `title: ${input.title}`,
    ...blocks.map((block) => [
      `\n## ${block.label}`,
      block.source_field ? `source_field: ${String(block.source_field)}` : undefined,
      block.filename ? `filename: ${block.filename}` : undefined,
      block.text,
    ].filter(Boolean).join("\n")),
  ].join("\n");
  const apiCharactersAvailable = characterCount(apiBlocks);
  const attachmentCharactersAvailable = characterCount(attachmentBlocks);
  return {
    text,
    blocks,
    metrics: {
      sourceCharacters: input.text.length,
      includedCharacters: text.length,
      apiCharactersAvailable,
      apiCharactersIncluded: characterCount(includedApi.blocks),
      attachmentCharactersAvailable,
      attachmentCharactersIncluded: characterCount(includedAttachments.blocks),
      truncatedBlockCount: includedApi.truncatedBlockCount + includedAttachments.truncatedBlockCount,
      includedBlockCount: blocks.length,
      inputSha256: createHash("sha256").update(text).digest("hex"),
    },
  };
}

function normalizePilotAxes(
  payload: unknown,
  criteria: GrantCriterion[],
  evidenceBlocks: PilotBlock[],
): PilotAxisObservation[] {
  const rows = Array.isArray((payload as { axis_assessments?: unknown[] } | null)?.axis_assessments)
    ? (payload as { axis_assessments: unknown[] }).axis_assessments
    : [];
  const byDimension = new Map<CriterionDimension, Record<string, unknown>>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const dimension = typeof row.dimension === "string" && PILOT_MODEL_DIMENSIONS.includes(
      row.dimension as (typeof PILOT_MODEL_DIMENSIONS)[number],
    ) ? row.dimension as (typeof PILOT_MODEL_DIMENSIONS)[number] : null;
    if (!dimension || byDimension.has(dimension)) continue;
    byDimension.set(dimension, row);
  }

  return PILOT_MODEL_DIMENSIONS.map((dimension) => {
    const row = byDimension.get(dimension);
    const modelStatus = isPilotAxisModelStatus(row?.status) ? row.status : "not_returned";
    const dimensionCriteria = criteria.filter((criterion) => criterion.dimension === dimension);
    const hasStructured = dimensionCriteria.some((criterion) => criterion.operator !== "text_only");
    const hasTextOnly = dimensionCriteria.some((criterion) => criterion.operator === "text_only");
    const issues: string[] = [];
    let effectiveStatus: PilotAxisObservation["effectiveStatus"] = modelStatus;
    if (hasStructured) {
      effectiveStatus = "condition_found";
      if (modelStatus !== "condition_found") issues.push("criterion_overrides_axis_status");
    } else if (hasTextOnly) {
      effectiveStatus = "ambiguous";
      if (modelStatus !== "ambiguous" && modelStatus !== "condition_found") {
        issues.push("text_only_overrides_axis_status");
      }
    } else if (modelStatus === "condition_found") {
      effectiveStatus = "ambiguous";
      issues.push("condition_found_without_criterion");
    }
    const suppliedSpans = Array.isArray(row?.evidence_spans)
      ? row.evidence_spans.filter((value): value is string => typeof value === "string")
      : [];
    const evidenceSpans = suppliedSpans
      .map((span) => span.trim())
      .filter((span) => Boolean(findEvidenceBlock(span, evidenceBlocks)))
      .slice(0, 3);
    if (suppliedSpans.length > evidenceSpans.length) issues.push("axis_evidence_not_in_prompt");
    return {
      dimension,
      modelStatus,
      effectiveStatus,
      confidence: boundedConfidence(row?.confidence),
      evidenceSpans,
      note: cleanString(row?.note) ?? (row ? "" : "모델이 이 축을 반환하지 않았어요."),
      issues,
    };
  });
}

function gatePilotCriterionEvidence(criteria: GrantCriterion[], blocks: PilotBlock[]): GrantCriterion[] {
  return criteria.map((criterion) => {
    const block = findEvidenceBlock(criterion.source_span ?? "", blocks);
    if (criterion.operator === "text_only") {
      if (!block) {
        const {
          source_span: _unverifiedSourceSpan,
          source_field: _unverifiedSourceField,
          ...criterionWithoutEvidence
        } = criterion;
        return criterionWithoutEvidence;
      }
      return {
        ...criterion,
        ...(block.source_field
          ? { source_field: String(block.source_field) }
          : block.filename
            ? { source_field: `attachment:${block.filename}` }
            : {}),
      };
    }
    if (!block) {
      const {
        source_span: _unverifiedSourceSpan,
        source_field: _unverifiedSourceField,
        ...criterionWithoutEvidence
      } = criterion;
      return {
        ...criterionWithoutEvidence,
        dimension: "other",
        operator: "text_only",
        value: { note: `${criterion.dimension} 조건의 입력 근거를 확인하지 못했어요.` },
        confidence: Math.min(criterion.confidence, 0.5),
        needs_review: true,
      };
    }
    return {
      ...criterion,
      ...(block.source_field
        ? { source_field: String(block.source_field) }
        : block.filename
          ? { source_field: `attachment:${block.filename}` }
          : {}),
    };
  });
}

function normalizePilotCriteriaRows(
  payload: unknown,
  sourceId: string,
  source: "kstartup" | "bizinfo",
): { criteria: GrantCriterion[]; repairs: PilotNormalizationRepair[] } {
  const rows = Array.isArray((payload as { criteria?: unknown[] } | null)?.criteria)
    ? (payload as { criteria: unknown[] }).criteria
    : [];
  const criteria: GrantCriterion[] = [];
  const repairs: PilotNormalizationRepair[] = [];
  const dimensionSpanKeys = new Set<string>();

  rows.forEach((row, rowIndex) => {
    let normalized: GrantCriterion[] = [];
    try {
      normalized = normalizeGrantLlmCriteria({ criteria: [row] }, sourceId, {
        sourcePrefix: `${source}-pilot-${rowIndex + 1}`,
        parserVersion: GRANT_ANALYSIS_PILOT_EXTRACTOR_VERSION,
        contractLabel: `${source}:${sourceId}:pilot-row-${rowIndex + 1}`,
        forceNeedsReview: true,
      });
      if (normalized.length === 0) throw new Error("row did not normalize to a criterion");
    } catch (error) {
      const raw = isRecord(row) ? row : {};
      const sourceSpan = cleanString(raw.source_span);
      const rawValue = isRecord(raw.value) ? raw.value : {};
      const rawDimension = cleanString(raw.dimension) ?? "unknown";
      const note = cleanString(rawValue.note) ?? sourceSpan ?? `${rawDimension} 조건 구조화 실패`;
      const fallback = {
        dimension: "other",
        operator: "text_only",
        kind: raw.kind === "preferred" || raw.kind === "exclusion" ? raw.kind : "required",
        value: { note },
        confidence: boundedConfidence(raw.confidence) || 0.4,
        ...(sourceSpan ? { source_span: sourceSpan } : {}),
        needs_review: true,
      };
      normalized = normalizeGrantLlmCriteria({ criteria: [fallback] }, sourceId, {
        sourcePrefix: `${source}-pilot-repair-${rowIndex + 1}`,
        parserVersion: GRANT_ANALYSIS_PILOT_EXTRACTOR_VERSION,
        contractLabel: `${source}:${sourceId}:pilot-repair-${rowIndex + 1}`,
        forceNeedsReview: true,
      });
      repairs.push({
        rowIndex,
        action: "downgrade_to_text_only",
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }

    for (const criterion of normalized) {
      const span = normalizeEvidence(criterion.source_span ?? "");
      const key = span ? `${criterion.dimension}\u0000${span}` : "";
      if (key && dimensionSpanKeys.has(key)) {
        repairs.push({
          rowIndex,
          action: "drop_duplicate",
          reason: `duplicate dimension/source_span: ${criterion.dimension}`,
        });
        continue;
      }
      if (key) dimensionSpanKeys.add(key);
      criteria.push(criterion);
    }
  });
  return { criteria, repairs };
}

function findEvidenceBlock(span: string, blocks: PilotBlock[]): PilotBlock | null {
  const needle = normalizeEvidence(span);
  if (needle.length < 2) return null;
  return blocks.find((block) => normalizeEvidence(block.text).includes(needle)) ?? null;
}

function capBlocks(blocks: PilotBlock[], maxCharacters: number): {
  blocks: PilotBlock[];
  truncatedBlockCount: number;
} {
  const result: PilotBlock[] = [];
  let remaining = Math.max(0, maxCharacters);
  let truncatedBlockCount = 0;
  for (const block of blocks) {
    if (remaining <= 0) {
      truncatedBlockCount += 1;
      continue;
    }
    const text = block.text.slice(0, remaining);
    if (text.length < block.text.length) truncatedBlockCount += 1;
    if (text.trim()) result.push({ ...block, text });
    remaining -= text.length;
  }
  return { blocks: result, truncatedBlockCount };
}

function characterCount(blocks: PilotBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.text.length, 0);
}

function isPilotAxisModelStatus(value: unknown): value is PilotAxisModelStatus {
  return value === "condition_found" || value === "inspected_no_condition" ||
    value === "ambiguous" || value === "input_missing";
}

function boundedConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeEvidence(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PILOT_SYSTEM_PROMPT = [
  "너는 정부지원사업 공고의 신청 자격조건과 분석 완전성을 구조화하는 추출기다.",
  "입력에 명시된 조건만 추출하고 추정하지 않는다. 모든 구조화 조건의 source_span은 입력에 실제 존재하는 짧은 근거여야 한다.",
  "axis_assessments는 premises와 export_performance를 제외한 20개 활성 축을 모두 정확히 한 번씩 검사한 결과다.",
  "status=condition_found: 입력에서 해당 축 조건을 찾아 criteria에도 같은 dimension으로 냈다.",
  "status=inspected_no_condition: 제공된 모든 입력 블록을 검사했지만 해당 축 조건을 찾지 못했다.",
  "status=ambiguous: 관련 문구는 있으나 안전하게 구조화할 수 없다. 가능한 경우 text_only criterion을 낸다.",
  "status=input_missing: 공고가 첨부나 상세문을 가리키지만 해당 내용이 입력에 없어 그 축을 검사할 수 없다.",
  "inspected_no_condition과 input_missing을 절대 혼동하지 마라.",
  "지역 코드는 한국 시도 행정코드 2자리를 사용하고, 규모는 예비·소상공인·소기업·중소기업·중견기업·대기업만 사용한다.",
  "휴폐업 제외는 business_status/not_in/exclusion, 세금 체납은 tax_compliance, 신용·금융은 credit_status, 참여제한은 sanction으로 분리한다.",
  "재무건전성은 financial_health, 고용보험 피보험자는 insured_workforce, 투자유치는 investment로 분리한다.",
  "동일·유사 사업 중복수혜·참여 이력은 prior_award로 분리한다. 범위를 특정할 수 없으면 other/text_only로 둔다.",
  "value canonical 규칙: region={regions:[시도코드],nationwide?}, biz_age={min_months?,max_months?,include_preliminary?}, industry={tags:[문자열]}, size={sizes:[정규 규모]}, revenue={min_krw?,max_krw?}, employees={min?,max?}, founder_age={ranges:[{min?,max?,label}]}, founder_trait={traits:[문자열]}, certification={certs:[문자열]}, ip={types:[문자열]}, target_type={targets:[문자열]}.",
  "위 canonical value를 채울 수 없으면 빈 배열이나 빈 객체를 내지 말고 operator=text_only, dimension=other, value={note:근거문장}으로 둔다.",
  "서류 허위·미제출·표절·기타 부적합 같은 절차·재량 조건은 other/text_only exclusion으로 둔다.",
  "제출서류는 criteria가 아니라 required_documents에 넣고 source_span이 없으면 만들지 않는다.",
  "premises와 export_performance는 예약 축이므로 criteria나 axis_assessments에 내지 않는다.",
].join("\n");
