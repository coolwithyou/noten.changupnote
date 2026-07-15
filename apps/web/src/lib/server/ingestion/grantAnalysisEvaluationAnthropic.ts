import { createHash } from "node:crypto";
import {
  GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  type GrantAnalysisEvaluationAttemptReservation,
  type GrantAnalysisEvaluationRunFingerprintInput,
  type GrantAnalysisEvaluationStage,
} from "../matches/run-grant-analysis-evaluation";

export const GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL = "claude-fable-5";
export const GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL = "claude-opus-4-8";
export const GRANT_ANALYSIS_EVALUATION_ANTHROPIC_VERSION = "2023-06-01";
export const GRANT_ANALYSIS_EVALUATION_ANTHROPIC_BOUNDARY_VERSION =
  "grant-analysis-evaluation-anthropic-boundary-v2";
export const GRANT_ANALYSIS_EVALUATION_ANTHROPIC_ENDPOINT =
  "https://api.anthropic.com/v1/messages";

const ALLOWED_MODELS = new Set([
  GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL,
  GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL,
]);

export interface GrantAnalysisEvaluationAnthropicRequest {
  stage: GrantAnalysisEvaluationStage;
  model: string;
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
  outputSchema: Record<string, unknown>;
  validateOutput(value: unknown): boolean;
  reservation: GrantAnalysisEvaluationAttemptReservation;
}

export interface GrantAnalysisEvaluationAnthropicResult {
  stage: GrantAnalysisEvaluationStage;
  model: string;
  stopReason: string | null;
  usage: Record<string, unknown> | null;
  output: unknown;
  receipt: {
    requestId: string | null;
    messageId: string | null;
    usage: Record<string, unknown> | null;
    outputSha256: string;
  };
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
  usage?: Record<string, unknown>;
}

/**
 * Narrow Messages boundary for the evaluation runner. Every invocation is a
 * fresh request with one role prompt and one raw input; no conversational
 * state, prior role messages, candidate labels, or match results can leak in.
 */
export function createGrantAnalysisEvaluationAnthropicProvider(options: {
  mode: "plan" | "paid";
  confirmation?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  executionConfig: {
    configSha256: string;
    fingerprintInput: GrantAnalysisEvaluationRunFingerprintInput;
  };
  verifyPersistedReservation(
    reservation: GrantAnalysisEvaluationAttemptReservation,
  ): boolean | Promise<boolean>;
}) {
  return {
    async call(
      request: GrantAnalysisEvaluationAnthropicRequest,
    ): Promise<GrantAnalysisEvaluationAnthropicResult> {
      if (options.mode !== "paid") {
        throw new Error("Plan mode cannot call Anthropic Messages.");
      }
      if (options.confirmation !== GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION) {
        throw new Error(
          `Anthropic Messages requires confirmation ${GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION}.`,
        );
      }
      const apiKey = options.apiKey?.trim();
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for paid mode.");
      if (!ALLOWED_MODELS.has(request.model)) {
        throw new Error(
          `Evaluation model must be ${GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL} or explicit fallback ${GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL}.`,
        );
      }
      if (!request.systemPrompt.trim() || !request.userContent.trim()) {
        throw new Error("Anthropic evaluation request prompts must be non-empty.");
      }
      if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
        throw new Error("Anthropic evaluation maxTokens must be a positive integer.");
      }
      const reservation = request.reservation;
      const frozenProvider = options.executionConfig.fingerprintInput.provider;
      if (frozenProvider.boundaryVersion !== GRANT_ANALYSIS_EVALUATION_ANTHROPIC_BOUNDARY_VERSION ||
          frozenProvider.apiVersion !== GRANT_ANALYSIS_EVALUATION_ANTHROPIC_VERSION ||
          frozenProvider.endpoint !== GRANT_ANALYSIS_EVALUATION_ANTHROPIC_ENDPOINT ||
          frozenProvider.effort !== "high") {
        throw new Error("Anthropic evaluation provider boundary violates the frozen execution policy.");
      }
      const stagePolicy = options.executionConfig.fingerprintInput.stages[request.stage];
      if (!reservation || reservation.recordType !== "grant_analysis_evaluation_attempt_reservation" ||
          reservation.schemaVersion !== 1 || reservation.configSha256 !== options.executionConfig.configSha256 ||
          reservation.stage !== request.stage || reservation.plannedModel !== request.model ||
          reservation.maxTokens !== request.maxTokens || reservation.persistedStatus !== "running" ||
          reservation.successfulStageExists !== false || reservation.attempt < 1 || reservation.attempt > 2 ||
          reservation.persistedAttempts < 1 || reservation.persistedAttempts > reservation.maxCalls ||
          reservation.maxCalls !== options.executionConfig.fingerprintInput.retry.maxCalls ||
          reservation.globalAbsoluteCap !== options.executionConfig.fingerprintInput.retry.globalAbsoluteCap ||
          reservation.maxCalls > reservation.globalAbsoluteCap || !reservation.grantKey.trim() ||
          !reservation.sourceRevision.trim() || !reservation.reservationId.trim() ||
          !/^[a-f0-9]{64}$/i.test(reservation.outputSchemaSha256)) {
        throw new Error("Anthropic evaluation requires a valid persisted attempt reservation.");
      }
      const requestSchemaSha256 = sha256(stableStringify(request.outputSchema));
      if (!stagePolicy || request.model !== stagePolicy.model || request.maxTokens !== stagePolicy.maxOutputTokens ||
          options.executionConfig.fingerprintInput.modelAccess[request.model] !== true ||
          sha256(request.systemPrompt) !== stagePolicy.promptSha256 ||
          requestSchemaSha256 !== reservation.outputSchemaSha256 ||
          (request.stage !== "judge_3" && requestSchemaSha256 !== stagePolicy.schemaSha256) ||
          sha256(request.userContent) !== reservation.packetSha256) {
        throw new Error("Anthropic evaluation request violates the frozen execution policy.");
      }
      if (!await options.verifyPersistedReservation(reservation)) {
        throw new Error("Anthropic evaluation persisted attempt reservation was not verified.");
      }

      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(GRANT_ANALYSIS_EVALUATION_ANTHROPIC_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": GRANT_ANALYSIS_EVALUATION_ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.systemPrompt,
            messages: [{ role: "user", content: request.userContent }],
            output_config: {
              effort: "high",
              format: { type: "json_schema", schema: request.outputSchema },
            },
          }),
        });
      } catch {
        throw new Error(`Anthropic evaluation ${request.stage} request failed before response.`);
      }
      const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id");
      const providerReceipt = `status=${response.status}${requestId ? ` requestId=${requestId}` : ""}`;
      if (!response.ok) {
        throw new Error(`Anthropic evaluation ${request.stage} failed (${providerReceipt}).`);
      }
      let payload: AnthropicMessageResponse;
      try {
        payload = JSON.parse(await response.text()) as AnthropicMessageResponse;
      } catch {
        throw new Error(`Anthropic evaluation ${request.stage} returned invalid envelope JSON (${providerReceipt}).`);
      }
      if (payload.model !== request.model) {
        throw new Error(`Anthropic evaluation ${request.stage} returned an unpinned model (${providerReceipt}).`);
      }
      if (payload.stop_reason === "refusal") {
        throw new Error(`Anthropic evaluation ${request.stage} refused the request (${providerReceipt}).`);
      }
      if (payload.stop_reason === "max_tokens") {
        throw new Error(`Anthropic evaluation ${request.stage} reached max_tokens (${providerReceipt}).`);
      }
      if (payload.stop_reason !== "end_turn") {
        throw new Error(`Anthropic evaluation ${request.stage} returned a non-terminal stop reason (${providerReceipt}).`);
      }
      if (!Array.isArray(payload.content) || payload.content.some((block) =>
        block.type !== "text" && block.type !== "thinking" && block.type !== "redacted_thinking")) {
        throw new Error(`Anthropic evaluation ${request.stage} returned non-text structured output (${providerReceipt}).`);
      }
      const textBlocks = payload.content.filter((block) => block.type === "text");
      if (textBlocks.length !== 1 || typeof textBlocks[0]?.text !== "string") {
        throw new Error(`Anthropic evaluation ${request.stage} did not return exactly one text output (${providerReceipt}).`);
      }
      let output: unknown;
      try {
        output = JSON.parse(textBlocks[0].text);
      } catch {
        throw new Error(`Anthropic evaluation ${request.stage} returned invalid structured JSON (${providerReceipt}).`);
      }
      if (!request.validateOutput(output)) {
        throw new Error(`Anthropic evaluation ${request.stage} failed runtime schema validation (${providerReceipt}).`);
      }
      return {
        stage: request.stage,
        model: payload.model ?? request.model,
        stopReason: payload.stop_reason ?? null,
        usage: payload.usage ?? null,
        output,
        receipt: {
          requestId: safeProviderId(requestId),
          messageId: safeProviderId(payload.id),
          usage: payload.usage ?? null,
          outputSha256: sha256(stableStringify(output)),
        },
      };
    },
  };
}

function safeProviderId(value: string | undefined | null): string | null {
  if (!value || !/^[a-zA-Z0-9._:-]{1,200}$/.test(value)) return null;
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
