import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
  type DeepAnalysisAuditModel,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import type { DeepAnalysisValidationResult } from "./validator";
import type { DeepAnalysisAuditItemResult } from "./audit";
import {
  DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS,
  priceDeepAnalysisUsage,
} from "./costPolicy";
import {
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  resolveExactEvidenceSpan,
} from "./extractor";
import { stableJson } from "./sourceRevision";

export const DEEP_ANALYSIS_AUDIT_ADJUDICATION_VERSION =
  "deep-analysis-audit-adjudication-v12" as const;
export const DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT = [
  "너는 정부지원사업 공고의 독립 감사자다.",
  "너는 이미 primary를 보지 않고 원문을 독립 분석했다. 이제 원문, primary 결과, 네 독립 결과를 대조해 primary를 항목별로 감사한다.",
  "독립 결과는 누락 후보를 찾기 위한 탐색 신호다. primary와 같은 criterion 배열·분할·kind·문구를 재생성할 필요가 없다.",
  "최종 감사 대상은 primary가 신청 시점의 자격·결격·우대·평가점수를 22축에서 의미상 누락하거나 잘못 분류했는지다.",
  "표현·criterion 분할·source span 길이·blind 결과의 contract/normalization 차이만으로 blocking finding을 만들지 마라.",
  "blind 결과가 validation issue를 가져도 원문과 primary만으로 의미가 명확하면 primary를 직접 판정한다. 실제 의미를 확정할 수 없을 때만 unsure다.",
  "reviewed_dimensions에는 22축을 정확히 한 번씩 모두 넣어 전수 검토를 증명한다.",
  "blocking_findings에는 원문으로 입증된 primary의 실질 누락 또는 오분류만 넣는다. 각 finding의 source_span은 sealed source에서 원문 그대로 인용한다.",
  "audit_only 후보가 중복·과분해·비자격 서술이거나 primary가 이미 의미상 반영했다면 blocking_findings에 넣지 않는다.",
  "의미를 확정할 수 없는 축은 빈 결과로 통과시키지 말고 uncertainties에 이유와 함께 넣는다.",
  "실제 blocker와 uncertainty가 모두 없으면 두 배열을 비워 반환한다. 비차단 차이의 설명을 억지로 finding으로 만들지 마라.",
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  "primary와 audit의 flags가 같아도 value.exceptions가 누락되거나 다른 결격 항목의 예외가 붙어 있으면 실질 오분류 finding이다. JSON의 실제 value를 확인하고 설명만으로 예외가 반영됐다고 추정하지 마라.",
  "기준을 완화하거나 원문 밖 내용을 추정하지 마라.",
].join("\n");
const AUDIT_ADJUDICATION_TIMEOUT_MS = 540_000;
const AUDIT_ADJUDICATION_RETRY_DELAY_MS = 5_000;
const AUDIT_ADJUDICATION_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

interface Candidate {
  kind: "criterion";
  dimension: CriterionDimension;
  candidateKind: "primary" | "audit_only";
  key: string;
  primary: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
}

interface RawBlockingFinding {
  dimension?: unknown;
  finding_type?: unknown;
  source_span?: unknown;
  reason?: unknown;
}

interface RawUncertainty {
  dimension?: unknown;
  reason?: unknown;
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    name?: string;
    input?: {
      reviewed_dimensions?: unknown;
      blocking_findings?: unknown;
      uncertainties?: unknown;
    };
  }>;
  stop_reason?: string;
  usage?: Record<string, unknown>;
}

export async function adjudicateDeepAnalysisAudit(input: {
  apiKey: string;
  model: DeepAnalysisAuditModel;
  evidenceText: string;
  primaryResult: DeepAnalysisModelResult;
  primaryValidation: DeepAnalysisValidationResult;
  auditResult: DeepAnalysisModelResult;
  auditValidation: DeepAnalysisValidationResult;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}): Promise<{
  verdict: "concur" | "disagree" | "unsure";
  itemResults: DeepAnalysisAuditItemResult[];
  rawResponseText: string;
  rawToolInput: Record<string, unknown>;
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
  costUsd: number | null;
}> {
  const candidates = buildCandidates(input.primaryValidation, input.auditValidation);
  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS,
    system: DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        "<<<SEALED_SOURCE>>>",
        input.evidenceText,
        "<<<END_SEALED_SOURCE>>>",
        "<<<PRIMARY_AXES>>>",
        stableJson(input.primaryResult.axisAssessments),
        "<<<AUDIT_AXES>>>",
        stableJson(input.auditResult.axisAssessments),
        "<<<PRIMARY_VALIDATION_ISSUES>>>",
        stableJson(input.primaryValidation.issues),
        "<<<AUDIT_VALIDATION_ISSUES>>>",
        stableJson(input.auditValidation.issues),
        "<<<CRITERION_CANDIDATES>>>",
        stableJson(candidates),
        "<<<END_COMPARISON_INPUT>>>",
      ].join("\n"),
    }],
    tools: [auditAdjudicationTool()],
    tool_choice: { type: "tool", name: "emit_deep_analysis_audit_adjudication" },
  });
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? AUDIT_ADJUDICATION_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await (input.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: requestBody,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Anthropic audit adjudication timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  let response = await attempt();
  if (AUDIT_ADJUDICATION_RETRYABLE_STATUSES.has(response.status)) {
    await new Promise((resolve) => setTimeout(
      resolve,
      input.retryDelayMs ?? AUDIT_ADJUDICATION_RETRY_DELAY_MS,
    ));
    response = await attempt();
  }
  const rawResponseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic audit adjudication failed: ${response.status} ${response.statusText}\n${rawResponseText.slice(0, 1_000)}`,
    );
  }
  const payload = JSON.parse(rawResponseText) as AnthropicResponse;
  const tool = payload.content?.find((block) => (
    block.type === "tool_use" && block.name === "emit_deep_analysis_audit_adjudication"
  ));
  const rawToolInput = isRecord(tool?.input) ? tool.input : {};
  const normalized = normalizeAdjudication({
    evidenceText: input.evidenceText,
    reviewedDimensions: rawToolInput.reviewed_dimensions,
    findingRows: rawToolInput.blocking_findings,
    uncertaintyRows: rawToolInput.uncertainties,
  });
  const usage = normalizeUsage(payload.usage);
  return {
    ...normalized,
    rawResponseText,
    rawToolInput,
    usage,
    costUsd: usage
      ? priceDeepAnalysisUsage({ model: input.model, usage })
      : null,
  };
}

function buildCandidates(
  primary: DeepAnalysisValidationResult,
  audit: DeepAnalysisValidationResult,
): Candidate[] {
  const primaryByHash = new Map(
    primary.criteria.map((item) => [item.semanticSha256, item]),
  );
  const auditByHash = new Map(
    audit.criteria.map((item) => [item.semanticSha256, item]),
  );
  const candidates: Candidate[] = primary.criteria.map((item) => ({
    kind: "criterion",
    dimension: item.criterion.dimension,
    candidateKind: "primary",
    key: item.semanticSha256,
    primary: {
      ...item.canonicalCriterion,
      source_span: item.criterion.sourceSpan,
    },
    audit: auditByHash.has(item.semanticSha256)
      ? {
        ...auditByHash.get(item.semanticSha256)!.canonicalCriterion,
        source_span: auditByHash.get(item.semanticSha256)!.criterion.sourceSpan,
      }
      : null,
  }));
  for (const item of audit.criteria) {
    if (primaryByHash.has(item.semanticSha256)) continue;
    candidates.push({
      kind: "criterion",
      dimension: item.criterion.dimension,
      candidateKind: "audit_only",
      key: item.semanticSha256,
      primary: null,
      audit: {
        ...item.canonicalCriterion,
        source_span: item.criterion.sourceSpan,
      },
    });
  }
  return candidates.sort((left, right) => (
    `${left.dimension}:${left.candidateKind}:${left.key}`
      .localeCompare(`${right.dimension}:${right.candidateKind}:${right.key}`)
  ));
}

function normalizeAdjudication(input: {
  evidenceText: string;
  reviewedDimensions: unknown;
  findingRows: unknown;
  uncertaintyRows: unknown;
}): {
  verdict: "concur" | "disagree" | "unsure";
  itemResults: DeepAnalysisAuditItemResult[];
} {
  const reviewedDimensions = Array.isArray(input.reviewedDimensions)
    ? input.reviewedDimensions.filter((value): value is string => typeof value === "string")
    : [];
  const findingRows = Array.isArray(input.findingRows)
    ? input.findingRows.filter(isRecord) as RawBlockingFinding[]
    : [];
  const uncertaintyRows = Array.isArray(input.uncertaintyRows)
    ? input.uncertaintyRows.filter(isRecord) as RawUncertainty[]
    : [];
  const reviewedSet = new Set(reviewedDimensions);
  let contractInvalid = reviewedDimensions.length !== CRITERION_DIMENSIONS.length
    || reviewedSet.size !== CRITERION_DIMENSIONS.length
    || CRITERION_DIMENSIONS.some((dimension) => !reviewedSet.has(dimension))
    || (Array.isArray(input.findingRows) && findingRows.length !== input.findingRows.length)
    || !Array.isArray(input.findingRows)
    || (Array.isArray(input.uncertaintyRows)
      && uncertaintyRows.length !== input.uncertaintyRows.length)
    || !Array.isArray(input.uncertaintyRows);
  const findingsByDimension = new Map<CriterionDimension, string[]>();
  const uncertaintiesByDimension = new Map<CriterionDimension, string[]>();
  for (const row of findingRows) {
    const dimension = isDimension(row.dimension) ? row.dimension : null;
    const findingType = row.finding_type;
    const sourceSpan = typeof row.source_span === "string" ? row.source_span.trim() : "";
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (
      !dimension
      || (findingType !== "missing_eligibility" && findingType !== "misclassified_eligibility")
      || !sourceSpan
      || !reason
      || resolveExactEvidenceSpan(sourceSpan, input.evidenceText) === null
    ) {
      contractInvalid = true;
      continue;
    }
    const rows = findingsByDimension.get(dimension) ?? [];
    rows.push(`${findingType}: ${reason}`);
    findingsByDimension.set(dimension, rows);
  }
  for (const row of uncertaintyRows) {
    const dimension = isDimension(row.dimension) ? row.dimension : null;
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (!dimension || !reason) {
      contractInvalid = true;
      continue;
    }
    const rows = uncertaintiesByDimension.get(dimension) ?? [];
    rows.push(reason);
    uncertaintiesByDimension.set(dimension, rows);
  }
  const itemResults: DeepAnalysisAuditItemResult[] = CRITERION_DIMENSIONS.map((dimension) => {
    const blockers = findingsByDimension.get(dimension) ?? [];
    const uncertainties = uncertaintiesByDimension.get(dimension) ?? [];
    const reasons = [...blockers, ...uncertainties];
    return {
      kind: "axis",
      dimension,
      key: dimension,
      primary: dimension,
      audit: dimension,
      verdict: reasons.length === 0 ? "concur" : "disagree",
      reason: reasons.length === 0 ? null : reasons.join("\n"),
    };
  });
  return {
    verdict: contractInvalid
      ? "unsure"
      : uncertaintiesByDimension.size > 0
        ? "unsure"
        : findingsByDimension.size > 0
          ? "disagree"
          : "concur",
    itemResults,
  };
}

function auditAdjudicationTool() {
  return {
    name: "emit_deep_analysis_audit_adjudication",
    description: "22축 전수검토와 실제 신청자격 의미 blocker 또는 uncertainty만 반환한다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reviewed_dimensions: {
          type: "array",
          minItems: CRITERION_DIMENSIONS.length,
          maxItems: CRITERION_DIMENSIONS.length,
          items: { type: "string", enum: [...CRITERION_DIMENSIONS] },
        },
        blocking_findings: {
          type: "array",
          maxItems: CRITERION_DIMENSIONS.length * 2,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
              finding_type: {
                type: "string",
                enum: ["missing_eligibility", "misclassified_eligibility"],
              },
              source_span: { type: "string" },
              reason: { type: "string" },
            },
            required: ["dimension", "finding_type", "source_span", "reason"],
          },
        },
        uncertainties: {
          type: "array",
          maxItems: CRITERION_DIMENSIONS.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
              reason: { type: "string" },
            },
            required: ["dimension", "reason"],
          },
        },
      },
      required: ["reviewed_dimensions", "blocking_findings", "uncertainties"],
    },
  };
}

function isDimension(value: unknown): value is CriterionDimension {
  return typeof value === "string"
    && (CRITERION_DIMENSIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
} | null {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens);
  const outputTokens = Number(usage.output_tokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  return { inputTokens, outputTokens };
}
