import type {
  RoundtripFailureCode,
  RoundtripFieldCandidate,
  RoundtripFieldInputKind,
  RoundtripFieldPlanningSummary,
  RoundtripLlmTransport,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { priceDeepAnalysisUsage } from "@/lib/server/deep-analysis/costPolicy";

const TOOL_NAME = "emit_application_field_plan";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_TIMEOUT_MS = 180_000;
export const ROUNDTRIP_FIELD_CANDIDATE_LIMIT = 180;
const API_CANDIDATES_PER_REQUEST = 20;
const SUBSCRIPTION_CANDIDATES_PER_REQUEST = 40;
const MAX_API_LLM_BATCHES = Math.ceil(ROUNDTRIP_FIELD_CANDIDATE_LIMIT / API_CANDIDATES_PER_REQUEST);
const MAX_ADJUDICATION_ROUNDS = 2;
const ACCEPT_INPUT_CONFIDENCE = 0.55;
const ACCEPT_REJECTION_CONFIDENCE = 0.75;
const RETRYABLE_STATUSES = new Set([429, 500, 529]);
const WINDOW_EXHAUSTED_MARKER = "[CLAUDE_CLI_WINDOW_EXHAUSTED]";

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface AnthropicResponse {
  content?: Array<AnthropicToolUseBlock | { type: string; text?: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface FieldPlannerUsage {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface RoundtripFieldPlannerUsageEvent extends FieldPlannerUsage {
  costUsd: number;
}

interface FieldDecisionBatch {
  decisions: FieldDecision[];
  usage: FieldPlannerUsage;
}

interface FieldDecision {
  candidateId: string;
  isUserInput: boolean;
  inputKind: RoundtripFieldInputKind | "none";
  confidence: number;
  helpText: string;
  evidence: string;
  suggestedLabel: string;
}

export interface RoundtripFieldPlannerRuntimeConfig {
  transport: RoundtripLlmTransport;
  requestedModel: string;
  timeoutMs: number;
  candidateLimit: number | null;
  candidateBatchSize: number;
  candidateConcurrency: number;
  parentLabRunId: string | null;
}

class FieldPlanningError extends Error {
  constructor(readonly code: RoundtripFailureCode, message: string) {
    super(message);
    this.name = "FieldPlanningError";
  }
}

export function resolveRoundtripFieldPlannerRuntimeConfig(options?: {
  model?: string;
  timeoutMs?: number;
  transport?: RoundtripLlmTransport;
  candidateConcurrency?: number;
  parentLabRunId?: string | null;
}): RoundtripFieldPlannerRuntimeConfig {
  const transport = options?.transport ?? "api";
  const defaultConcurrency = transport === "claude-cli" ? 2 : MAX_API_LLM_BATCHES;
  return {
    transport,
    requestedModel: resolveModel(options?.model),
    timeoutMs: resolveTimeoutMs(options?.timeoutMs),
    // 로컬 구독은 추가 API 비용 없이 전체 후보를 끝까지 훑는다. 운영 API 경로는
    // 기존 비용 상한 180개를 보존해 이번 변경이 운영 지출을 우발적으로 늘리지 않는다.
    candidateLimit: transport === "claude-cli" ? null : ROUNDTRIP_FIELD_CANDIDATE_LIMIT,
    candidateBatchSize: transport === "claude-cli"
      ? SUBSCRIPTION_CANDIDATES_PER_REQUEST
      : API_CANDIDATES_PER_REQUEST,
    candidateConcurrency: positiveInteger(options?.candidateConcurrency) ?? defaultConcurrency,
    parentLabRunId: options?.parentLabRunId?.trim() || null,
  };
}

export async function planRoundtripFields(options: {
  fields: RoundtripFieldCandidate[];
  markdown: string;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  transport?: RoundtripLlmTransport;
  candidateConcurrency?: number;
  parentLabRunId?: string | null;
  onUsage?: (usage: RoundtripFieldPlannerUsageEvent) => Promise<void> | void;
}): Promise<{ fields: RoundtripFieldCandidate[]; summary: RoundtripFieldPlanningSummary }> {
  const startedMs = Date.now();
  const runtime = resolveRoundtripFieldPlannerRuntimeConfig(options);
  const fields = options.fields.map(cloneField);
  const candidates = runtime.candidateLimit === null
    ? fields
    : fields.slice(0, runtime.candidateLimit);
  if (candidates.length === 0) {
    return {
      fields,
      summary: buildSummary(runtime, "skipped", null, 0, fields, "판정할 입력 후보가 없습니다.", null),
    };
  }
  if (!options.apiKey) {
    return {
      fields,
      summary: buildSummary(
        runtime,
        "heuristic_fallback",
        null,
        Date.now() - startedMs,
        fields,
        "ANTHROPIC_API_KEY가 없어 결정적 후보 규칙만 적용했습니다.",
        "api_key_missing",
      ),
    };
  }

  const usageItems: FieldPlannerUsage[] = [];
  const decidedCandidateIds = new Set<string>();
  const adjudicatedCandidateIds = new Set<string>();
  const primary = await requestDecisionPass({
    candidates,
    markdown: options.markdown,
    apiKey: options.apiKey,
    runtime,
    round: 0,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
  });
  usageItems.push(...primary.usageItems);
  applyDecisions(fields, primary.decisions, 0, decidedCandidateIds);

  if (primary.decisions.length === 0) {
    const failureCode = primary.failureCode ?? "invalid_response";
    return {
      fields,
      summary: buildSummary(
        runtime,
        "heuristic_fallback",
        runtime.requestedModel,
        Date.now() - startedMs,
        fields,
        primary.warning ?? "모델이 후보 판정 배열을 비워 반환했습니다.",
        failureCode,
        sumPlannerUsage(usageItems),
        {
          processedCandidateCount: 0,
          unprocessedCandidateCount: fields.length,
          adjudicationStatus: runtime.transport === "claude-cli" ? "failed" : "skipped",
          adjudicationRounds: 0,
          adjudicatedCandidateCount: 0,
          remainingUnresolvedCandidateCount: candidates.length,
          adjudicationFailureCode: failureCode,
        },
      ),
    };
  }

  let unresolved = unresolvedDecisionCandidates(candidates, fields, decidedCandidateIds);
  let adjudicationRounds = 0;
  let adjudicationFailureCode: RoundtripFailureCode | null = null;
  if (runtime.transport === "claude-cli") {
    for (let round = 1; round <= MAX_ADJUDICATION_ROUNDS && unresolved.length > 0; round += 1) {
      adjudicationRounds = round;
      unresolved.forEach((field) => adjudicatedCandidateIds.add(field.fieldInstanceId));
      const adjudication = await requestDecisionPass({
        candidates: unresolved,
        markdown: options.markdown,
        apiKey: options.apiKey,
        runtime,
        round,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.onUsage ? { onUsage: options.onUsage } : {}),
      });
      usageItems.push(...adjudication.usageItems);
      applyDecisions(fields, adjudication.decisions, round, decidedCandidateIds);
      adjudicationFailureCode = adjudication.failureCode;
      unresolved = unresolvedDecisionCandidates(candidates, fields, decidedCandidateIds);
      if (adjudication.decisions.length === 0 && adjudication.failureCode !== null) break;
    }
  }

  const usage = sumPlannerUsage(usageItems);
  const unprocessedCandidateCount = fields.filter(
    (candidate) => !decidedCandidateIds.has(candidate.fieldInstanceId),
  ).length;
  const outOfScopeCandidateCount = Math.max(0, fields.length - candidates.length);
  const remainingUnresolvedCandidateCount = unresolved.length + outOfScopeCandidateCount;
  const adjudicationStatus: NonNullable<RoundtripFieldPlanningSummary["adjudicationStatus"]> =
    runtime.transport !== "claude-cli"
      ? "skipped"
      : adjudicationRounds === 0
        ? "not_needed"
        : unresolved.length === 0
          ? "resolved"
          : adjudicationFailureCode !== null
            ? "failed"
            : "partial";
  const warningParts = [
    primary.warning,
    remainingUnresolvedCandidateCount > 0
      ? `${runtime.transport === "claude-cli" ? "자동 재판정 후에도" : "비용 상한 적용 후"} `
        + `${remainingUnresolvedCandidateCount}개 후보가 미해결 상태입니다.`
      : null,
  ].filter((value): value is string => Boolean(value));
  return {
    fields,
    summary: buildSummary(
      runtime,
      "llm",
      runtime.requestedModel,
      Date.now() - startedMs,
      fields,
      warningParts.length > 0 ? warningParts.join(" ") : null,
      primary.failureCode !== null && unresolved.length > 0 ? primary.failureCode : null,
      usage,
      {
        processedCandidateCount: decidedCandidateIds.size,
        unprocessedCandidateCount,
        adjudicationStatus,
        adjudicationRounds,
        adjudicatedCandidateCount: adjudicatedCandidateIds.size,
        remainingUnresolvedCandidateCount,
        adjudicationFailureCode,
      },
    ),
  };
}

interface DecisionPassResult {
  decisions: FieldDecision[];
  usageItems: FieldPlannerUsage[];
  failureCode: RoundtripFailureCode | null;
  warning: string | null;
}

async function requestDecisionPass(input: {
  candidates: RoundtripFieldCandidate[];
  markdown: string;
  apiKey: string;
  runtime: RoundtripFieldPlannerRuntimeConfig;
  round: number;
  fetchImpl?: typeof fetch;
  onUsage?: (usage: RoundtripFieldPlannerUsageEvent) => Promise<void> | void;
}): Promise<DecisionPassResult> {
  const results = await mapWithConcurrency(
    chunkCandidates(input.candidates, input.runtime.candidateBatchSize),
    input.runtime.candidateConcurrency,
    async (batch) => {
      try {
        const value = await requestFieldDecisions({
          apiKey: input.apiKey,
          model: input.runtime.requestedModel,
          timeoutMs: input.runtime.timeoutMs,
          transport: input.runtime.transport,
          candidates: batch,
          markdown: input.markdown,
          adjudicationRound: input.round,
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        });
        await input.onUsage?.({
          ...value.usage,
          costUsd: priceDeepAnalysisUsage({ model: input.runtime.requestedModel, usage: value.usage }) ?? 0,
        });
        return { status: "fulfilled" as const, value };
      } catch (error) {
        return {
          status: "rejected" as const,
          error,
          code: classifyFieldPlanningFailure(error),
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  const fulfilled = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const rejected = results.filter((result) => result.status === "rejected");
  const failureCode = rejected[0]?.status === "rejected" ? rejected[0].code : null;
  return {
    decisions: fulfilled.flatMap((result) => result.decisions),
    usageItems: fulfilled.map((result) => result.usage),
    failureCode,
    warning: rejected.length > 0
      ? `${input.round === 0 ? "최초 판정" : `${input.round}차 재판정`} ${rejected.length}개 묶음이 실패했습니다: `
        + rejected.map((result) => result.status === "rejected" ? result.message : "").filter(Boolean).join(" | ")
      : null,
  };
}

function applyDecisions(
  fields: RoundtripFieldCandidate[],
  decisions: FieldDecision[],
  round: number,
  decidedCandidateIds: Set<string>,
): void {
  const byId = new Map(decisions.map((decision) => [decision.candidateId, decision]));
  for (const field of fields) {
    const decision = byId.get(field.fieldInstanceId);
    if (!decision) continue;
    applyDecision(field, decision, round);
    decidedCandidateIds.add(field.fieldInstanceId);
  }
}

function unresolvedDecisionCandidates(
  candidates: RoundtripFieldCandidate[],
  fields: RoundtripFieldCandidate[],
  decidedCandidateIds: ReadonlySet<string>,
): RoundtripFieldCandidate[] {
  const byId = new Map(fields.map((field) => [field.fieldInstanceId, field]));
  return candidates.flatMap((candidate) => {
    const field = byId.get(candidate.fieldInstanceId);
    if (!field || !decidedCandidateIds.has(candidate.fieldInstanceId)) return [field ?? candidate];
    return field.llmDecision === "uncertain" ? [field] : [];
  });
}

async function requestFieldDecisions(input: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  transport: RoundtripLlmTransport;
  candidates: RoundtripFieldCandidate[];
  markdown: string;
  adjudicationRound: number;
  fetchImpl?: typeof fetch;
}): Promise<FieldDecisionBatch> {
  const candidatePayload = input.candidates.map((field) => ({
    candidate_id: field.fieldInstanceId,
    proposed_label: field.label,
    source: field.source,
    proposed_input_kind: field.inputKind,
    write_operation: field.writeOperation,
    original_value: field.originalValue,
    helper_text: field.helperText,
    unit: field.unit,
    options: field.options.map((option) => option.label),
    empty: field.empty,
    structural_signals: field.inputSignals,
    previous_decision: field.llmDecision ?? null,
    previous_confidence: field.llmConfidence,
    surrounding_text: findSurroundingText(input.markdown, field),
  }));
  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: resolveMaxTokens(),
    system: [
      "너는 한국 정부지원사업 신청서의 사용자 입력 필드를 판정한다.",
      input.adjudicationRound > 0
        ? `이 요청은 최초 판정에서 누락되거나 확신이 낮았던 후보의 ${input.adjudicationRound}차 독립 재판정이다.`
        : "이 요청은 최초 판정이다.",
      "각 candidate_id를 반드시 하나씩 판정하고, 문서에 실제로 신청자가 입력해야 하는 영역만 is_user_input=true로 둔다.",
      "빈 셀뿐 아니라 단위만 있는 셀, 파란색 예시 문구로 보이는 값, 괄호형 작성 안내문, □ 선택지, ○ 표시 지시문도 입력 대상일 수 있다.",
      "반대로 섹션명·표 머리글·포괄 라벨(예: 재무현황, 관련기술현황)과 이미 확정된 고정 문구는 입력 필드로 만들지 않는다.",
      "행 라벨과 열 머리글을 결합해 매출액·연도처럼 구체적인 필드를 선호한다.",
      "값을 작성하거나 추정하지 말고 필드의 의미와 입력 UI만 판정한다.",
      "candidate_id와 쓰기 위치는 바꾸거나 새로 만들지 않는다. evidence는 제공된 텍스트를 짧게 그대로 인용한다.",
      "모든 candidate_id를 빠짐없이 반환한다. 원문만으로 판단 불가능할 때에만 confidence를 0.75 미만으로 둔다.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: `다음 Kordoc 구조 후보를 판정하라.\n${JSON.stringify(candidatePayload)}`,
    }],
    tools: [buildFieldPlanToolSchema()],
    tool_choice: { type: "tool", name: TOOL_NAME },
  });

  const requestFetch = input.fetchImpl ?? (input.transport === "api" ? fetch : null);
  if (!requestFetch) {
    throw new FieldPlanningError(
      "transport_not_configured",
      "claude-cli transport에 fetchImpl이 주입되지 않아 API 자동 폴백 없이 중단했습니다.",
    );
  }
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      return await requestFetch("https://api.anthropic.com/v1/messages", {
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
        throw new FieldPlanningError(
          "request_timeout",
          `Anthropic field plan 호출이 타임아웃됐습니다(${input.timeoutMs}ms).`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  let requestCount = 1;
  let response = await attempt();
  if (RETRYABLE_STATUSES.has(response.status)) {
    requestCount += 1;
    response = await attempt();
  }
  const body = await response.text();
  if (!response.ok) {
    throw new FieldPlanningError(
      body.includes(WINDOW_EXHAUSTED_MARKER) ? "window_exhausted" : "http_error",
      `Anthropic field plan failed: ${response.status} ${body.slice(0, 500)}`,
    );
  }
  let payload: AnthropicResponse;
  try {
    payload = JSON.parse(body) as AnthropicResponse;
  } catch {
    throw new FieldPlanningError("invalid_response", `Anthropic field plan JSON 파싱 실패: ${body.slice(0, 500)}`);
  }
  const toolUse = payload.content?.find(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use" && "name" in block && block.name === TOOL_NAME,
  );
  if (!toolUse) {
    throw new FieldPlanningError(
      "invalid_response",
      `도구 응답이 없습니다(stop_reason=${payload.stop_reason ?? "unknown"}).`,
    );
  }
  const raw = isRecord(toolUse.input) && Array.isArray(toolUse.input.decisions) ? toolUse.input.decisions : [];
  const allowed = new Set(input.candidates.map((candidate) => candidate.fieldInstanceId));
  return {
    decisions: raw.flatMap((value) => normalizeDecision(value, allowed)),
    usage: {
      requestCount,
      inputTokens: nonNegativeInteger(payload.usage?.input_tokens),
      outputTokens: nonNegativeInteger(payload.usage?.output_tokens),
      cacheReadTokens: nonNegativeInteger(payload.usage?.cache_read_input_tokens),
    },
  };
}

function buildFieldPlanToolSchema() {
  return {
    name: TOOL_NAME,
    description: "신청서 편집 후보별 사용자 입력 여부와 UI 유형을 반환한다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              candidate_id: { type: "string" },
              is_user_input: { type: "boolean" },
              suggested_label: { type: "string" },
              input_kind: {
                type: "string",
                enum: ["text", "textarea", "number", "single_choice", "multiple_choice", "none"],
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              help_text: { type: "string" },
              evidence: { type: "string" },
            },
            required: [
              "candidate_id",
              "is_user_input",
              "suggested_label",
              "input_kind",
              "confidence",
              "help_text",
              "evidence",
            ],
          },
        },
      },
      required: ["decisions"],
    },
  };
}

function normalizeDecision(value: unknown, allowed: Set<string>): FieldDecision[] {
  if (!isRecord(value)) return [];
  const candidateId = cleanString(value.candidate_id, 64);
  if (!candidateId || !allowed.has(candidateId)) return [];
  const inputKind = isInputKind(value.input_kind) ? value.input_kind : "none";
  return [{
    candidateId,
    isUserInput: value.is_user_input === true,
    inputKind,
    confidence: clamp(typeof value.confidence === "number" ? value.confidence : 0, 0, 1),
    helpText: cleanString(value.help_text, 500),
    evidence: cleanString(value.evidence, 300),
    suggestedLabel: cleanString(value.suggested_label, 100),
  }];
}

function applyDecision(field: RoundtripFieldCandidate, decision: FieldDecision, round: number): void {
  field.analysisSource = "llm";
  field.llmConfidence = decision.confidence;
  field.llmDecisionRound = round;
  const acceptedInput = decision.isUserInput
    && decision.inputKind !== "none"
    && decision.confidence >= ACCEPT_INPUT_CONFIDENCE;
  const acceptedRejection = !decision.isUserInput
    && decision.confidence >= ACCEPT_REJECTION_CONFIDENCE;
  field.llmDecision = acceptedInput ? "input" : acceptedRejection ? "not_input" : "uncertain";
  field.recommendedInput = acceptedInput;
  field.inputLikelihood = decision.isUserInput ? decision.confidence : 1 - decision.confidence;
  if (field.recommendedInput && decision.inputKind !== "none") {
    field.inputKind = compatibleInputKind(field, decision.inputKind);
  }
  if (decision.helpText) field.helperText = decision.helpText;
  field.inputSignals.push(field.llmDecision === "input"
    ? `LLM 맥락 판정: 사용자 입력${round > 0 ? ` (${round}차 재판정)` : ""}`
    : field.llmDecision === "not_input"
      ? `LLM 맥락 판정: 입력 대상 아님${round > 0 ? ` (${round}차 재판정)` : ""}`
      : `LLM 맥락 판정 보류${round > 0 ? ` (${round}차 재판정)` : ""}`);
  if (decision.suggestedLabel && decision.suggestedLabel !== field.label) {
    field.displayLabel = decision.suggestedLabel;
    field.inputSignals.push(`LLM 표시명 제안: ${decision.suggestedLabel}`);
  }
  if (decision.evidence) field.inputSignals.push(`LLM 근거: ${decision.evidence}`);
}

function compatibleInputKind(
  field: RoundtripFieldCandidate,
  requested: Exclude<RoundtripFieldInputKind | "none", "none">,
): RoundtripFieldInputKind {
  if (field.writeOperation === "insert_before_unit") return "number";
  if (field.writeOperation === "toggle_text_choice" || field.writeOperation === "replace_instruction") {
    return requested === "multiple_choice" ? "multiple_choice" : "single_choice";
  }
  if (requested === "single_choice" || requested === "multiple_choice") return field.inputKind;
  if (field.source === "contextual-region" && field.location.target?.kind === "block_text") return "textarea";
  return requested;
}

function findSurroundingText(markdown: string, field: RoundtripFieldCandidate): string {
  const needles = [field.helperText, field.originalValue, field.label].filter((value): value is string => Boolean(value?.trim()));
  for (const needle of needles) {
    const index = markdown.indexOf(needle);
    if (index < 0) continue;
    return markdown.slice(Math.max(0, index - 220), Math.min(markdown.length, index + needle.length + 320));
  }
  return "";
}

function buildSummary(
  runtime: RoundtripFieldPlannerRuntimeConfig,
  status: RoundtripFieldPlanningSummary["status"],
  model: string | null,
  durationMs: number,
  fields: RoundtripFieldCandidate[],
  warning: string | null,
  failureCode: RoundtripFailureCode | null,
  usage: FieldPlannerUsage = emptyPlannerUsage(),
  feedback?: Pick<
    RoundtripFieldPlanningSummary,
    | "processedCandidateCount"
    | "unprocessedCandidateCount"
    | "adjudicationStatus"
    | "adjudicationRounds"
    | "adjudicatedCandidateCount"
    | "remainingUnresolvedCandidateCount"
    | "adjudicationFailureCode"
  >,
): RoundtripFieldPlanningSummary {
  const acceptedCount = fields.filter((field) => field.recommendedInput).length;
  return {
    status,
    model,
    durationMs,
    candidateCount: fields.length,
    acceptedCount,
    rejectedCount: fields.length - acceptedCount,
    warning,
    transport: runtime.transport,
    requestedModel: runtime.requestedModel,
    timeoutMs: runtime.timeoutMs,
    candidateLimit: runtime.candidateLimit,
    candidateBatchSize: runtime.candidateBatchSize,
    candidateConcurrency: runtime.candidateConcurrency,
    parentLabRunId: runtime.parentLabRunId,
    failureCode,
    ...feedback,
    ...usage,
    costUsd: status === "llm" && usage.inputTokens + usage.outputTokens > 0
      ? priceDeepAnalysisUsage({ model: runtime.requestedModel, usage })
      : null,
  };
}

function emptyPlannerUsage(): FieldPlannerUsage {
  return { requestCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

function sumPlannerUsage(items: readonly FieldPlannerUsage[]): FieldPlannerUsage {
  return items.reduce<FieldPlannerUsage>((sum, item) => ({
    requestCount: sum.requestCount + item.requestCount,
    inputTokens: sum.inputTokens + item.inputTokens,
    outputTokens: sum.outputTokens + item.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens,
  }), emptyPlannerUsage());
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function cloneField(field: RoundtripFieldCandidate): RoundtripFieldCandidate {
  return {
    ...field,
    inputSignals: [...field.inputSignals],
    options: field.options.map((option) => ({ ...option })),
    location: field.location.target
      ? { ...field.location, target: { ...field.location.target } }
      : { ...field.location },
  };
}

function resolveModel(explicit?: string): string {
  return explicit?.trim() || process.env.APPLICATION_ROUNDTRIP_MODEL?.trim() || DEFAULT_MODEL;
}

function resolveMaxTokens(): number {
  const parsed = Number.parseInt(process.env.APPLICATION_ROUNDTRIP_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

function resolveTimeoutMs(explicit?: number): number {
  const explicitTimeout = positiveInteger(explicit);
  if (explicitTimeout !== null) return explicitTimeout;
  const parsed = Number.parseInt(process.env.APPLICATION_ROUNDTRIP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isInputKind(value: unknown): value is RoundtripFieldInputKind | "none" {
  return value === "text" || value === "textarea" || value === "number"
    || value === "single_choice" || value === "multiple_choice" || value === "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function chunkCandidates(fields: RoundtripFieldCandidate[], batchSize: number): RoundtripFieldCandidate[][] {
  const chunks: RoundtripFieldCandidate[][] = [];
  for (let index = 0; index < fields.length; index += batchSize) {
    chunks.push(fields.slice(index, index + batchSize));
  }
  return chunks;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      if (index >= values.length) return;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function classifyFieldPlanningFailure(error: unknown): RoundtripFailureCode {
  if (error instanceof FieldPlanningError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "request_timeout";
  if (error instanceof Error && error.message.includes(WINDOW_EXHAUSTED_MARKER)) return "window_exhausted";
  return "request_failed";
}

function positiveInteger(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
