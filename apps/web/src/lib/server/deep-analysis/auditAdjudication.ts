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
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
} from "./extractor";
import { stableJson } from "./sourceRevision";

export const DEEP_ANALYSIS_AUDIT_ADJUDICATION_VERSION =
  "deep-analysis-audit-adjudication-v6" as const;
export const DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT = [
  "너는 정부지원사업 공고의 독립 감사자다.",
  "너는 이미 primary를 보지 않고 원문을 독립 분석했다. 이제 원문, primary 결과, 네 독립 결과를 대조해 primary를 항목별로 감사한다.",
  "표현·분할 방식 차이가 아니라 실제 자격 의미가 같은지 판단하라.",
  "primary criterion이 원문에 맞고 축·kind·operator·value가 안전하면 accept_primary.",
  "audit_only 후보가 primary의 실질 누락이면 change_required, 중복·과분해·비자격 서술이면 accept_primary.",
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  "reason과 verdict는 반드시 같은 결론이어야 한다. reason에서 이미 primary에 반영됐거나 중복이라고 판단했다면 verdict는 accept_primary여야 하며 change_required를 반환하지 마라.",
  "판단 불가면 unsure. 기준을 완화하거나 원문 밖 내용을 추정하지 마라.",
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

interface RawAdjudicationItem {
  kind?: unknown;
  dimension?: unknown;
  candidate_kind?: unknown;
  key?: unknown;
  verdict?: unknown;
  reason?: unknown;
}

interface RawAxisAdjudication {
  dimension?: unknown;
  verdict?: unknown;
  reason?: unknown;
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    name?: string;
    input?: {
      criterion_verdicts?: unknown;
      axis_verdicts?: unknown;
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
        "<<<CRITERION_CANDIDATES>>>",
        stableJson(candidates),
        "<<<END_COMPARISON_INPUT>>>",
      ].join("\n"),
    }],
    tools: [auditAdjudicationTool(candidates)],
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
    candidates,
    criterionRows: rawToolInput.criterion_verdicts,
    axisRows: rawToolInput.axis_verdicts,
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
  candidates: Candidate[];
  criterionRows: unknown;
  axisRows: unknown;
}): {
  verdict: "concur" | "disagree" | "unsure";
  itemResults: DeepAnalysisAuditItemResult[];
} {
  const itemResults: DeepAnalysisAuditItemResult[] = [];
  const criterionRows = Array.isArray(input.criterionRows)
    ? input.criterionRows.filter(isRecord) as RawAdjudicationItem[]
    : [];
  const axisRows = Array.isArray(input.axisRows)
    ? input.axisRows.filter(isRecord) as RawAxisAdjudication[]
    : [];
  let contractInvalid = criterionRows.length !== input.candidates.length
    || axisRows.length !== CRITERION_DIMENSIONS.length;
  const seenCriteria = new Set<string>();
  for (const candidate of input.candidates) {
    const rows = criterionRows.filter((row) => (
      row.key === candidate.key && row.candidate_kind === candidate.candidateKind
    ));
    if (
      rows.length !== 1
      || rows[0]?.dimension !== candidate.dimension
      || seenCriteria.has(`${candidate.candidateKind}:${candidate.key}`)
    ) {
      contractInvalid = true;
    }
    seenCriteria.add(`${candidate.candidateKind}:${candidate.key}`);
    const row = rows[0];
    const verdict = row?.verdict;
    const accepted = verdict === "accept_primary";
    const unsure = verdict !== "accept_primary" && verdict !== "change_required";
    if (unsure) contractInvalid = true;
    itemResults.push({
      kind: "criterion",
      dimension: candidate.dimension,
      key: candidate.key,
      primary: candidate.primary ? candidate.key : null,
      audit: candidate.audit ? candidate.key : null,
      verdict: accepted ? "concur" : "disagree",
      reason: typeof row?.reason === "string" ? row.reason : null,
    });
  }
  const seenAxes = new Set<string>();
  for (const dimension of CRITERION_DIMENSIONS) {
    const rows = axisRows.filter((row) => row.dimension === dimension);
    if (rows.length !== 1 || seenAxes.has(dimension)) contractInvalid = true;
    seenAxes.add(dimension);
    const row = rows[0];
    const verdict = row?.verdict;
    const accepted = verdict === "accept_primary";
    const unsure = verdict !== "accept_primary" && verdict !== "change_required";
    if (unsure) contractInvalid = true;
    itemResults.push({
      kind: "axis",
      dimension,
      key: dimension,
      primary: dimension,
      audit: dimension,
      verdict: accepted ? "concur" : "disagree",
      reason: typeof row?.reason === "string" ? row.reason : null,
    });
  }
  return {
    verdict: contractInvalid
      ? "unsure"
      : itemResults.every((item) => item.verdict === "concur")
        ? "concur"
        : "disagree",
    itemResults,
  };
}

function auditAdjudicationTool(candidates: Candidate[]) {
  return {
    name: "emit_deep_analysis_audit_adjudication",
    description: "primary 분석을 원문과 독립 분석 결과에 비추어 항목별 감사한다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        criterion_verdicts: {
          type: "array",
          minItems: candidates.length,
          maxItems: candidates.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["criterion"] },
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
              candidate_kind: { type: "string", enum: ["primary", "audit_only"] },
              key: { type: "string", enum: candidates.map((item) => item.key) },
              verdict: { type: "string", enum: ["accept_primary", "change_required", "unsure"] },
              reason: { type: "string" },
            },
            required: ["kind", "dimension", "candidate_kind", "key", "verdict", "reason"],
          },
        },
        axis_verdicts: {
          type: "array",
          minItems: CRITERION_DIMENSIONS.length,
          maxItems: CRITERION_DIMENSIONS.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
              verdict: { type: "string", enum: ["accept_primary", "change_required", "unsure"] },
              reason: { type: "string" },
            },
            required: ["dimension", "verdict", "reason"],
          },
        },
      },
      required: ["criterion_verdicts", "axis_verdicts"],
    },
  };
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
