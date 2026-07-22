import type {
  RoundtripFieldCandidate,
  RoundtripFieldInputKind,
  RoundtripFieldPlanningSummary,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";

const TOOL_NAME = "emit_application_field_plan";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_LLM_CANDIDATES = 180;
const LLM_CANDIDATES_PER_REQUEST = 20;
const RETRYABLE_STATUSES = new Set([429, 500, 529]);

interface AnthropicToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface AnthropicResponse {
  content?: Array<AnthropicToolUseBlock | { type: string; text?: string }>;
  stop_reason?: string;
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

export async function planRoundtripFields(options: {
  fields: RoundtripFieldCandidate[];
  markdown: string;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ fields: RoundtripFieldCandidate[]; summary: RoundtripFieldPlanningSummary }> {
  const startedMs = Date.now();
  const fields = options.fields.map(cloneField);
  const candidates = fields.slice(0, MAX_LLM_CANDIDATES);
  if (candidates.length === 0) {
    return { fields, summary: buildSummary("skipped", null, 0, fields, "판정할 입력 후보가 없습니다.") };
  }
  if (!options.apiKey) {
    return {
      fields,
      summary: buildSummary(
        "heuristic_fallback",
        null,
        Date.now() - startedMs,
        fields,
        "ANTHROPIC_API_KEY가 없어 결정적 후보 규칙만 적용했습니다.",
      ),
    };
  }

  const model = resolveModel();
  try {
    const decisionBatches = await Promise.all(
      chunkCandidates(candidates).map((batch) => requestFieldDecisions({
        apiKey: options.apiKey!,
        model,
        candidates: batch,
        markdown: options.markdown,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })),
    );
    const decisions = decisionBatches.flat();
    if (decisions.length === 0) throw new Error("모델이 후보 판정 배열을 비워 반환했습니다.");
    const byId = new Map(decisions.map((decision) => [decision.candidateId, decision]));
    for (const field of fields) {
      const decision = byId.get(field.fieldInstanceId);
      if (!decision) continue;
      applyDecision(field, decision);
    }
    return {
      fields,
      summary: buildSummary(
        "llm",
        model,
        Date.now() - startedMs,
        fields,
        byId.size < candidates.length
          ? `LLM이 ${candidates.length}개 후보 중 ${byId.size}개만 반환해 나머지는 구조 규칙을 유지했습니다.`
          : null,
      ),
    };
  } catch (error) {
    return {
      fields,
      summary: buildSummary(
        "heuristic_fallback",
        model,
        Date.now() - startedMs,
        fields,
        `LLM 필드 판정 실패: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
}

async function requestFieldDecisions(input: {
  apiKey: string;
  model: string;
  candidates: RoundtripFieldCandidate[];
  markdown: string;
  fetchImpl?: typeof fetch;
}): Promise<FieldDecision[]> {
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
    surrounding_text: findSurroundingText(input.markdown, field),
  }));
  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: resolveMaxTokens(),
    system: [
      "너는 한국 정부지원사업 신청서의 사용자 입력 필드를 판정한다.",
      "각 candidate_id를 반드시 하나씩 판정하고, 문서에 실제로 신청자가 입력해야 하는 영역만 is_user_input=true로 둔다.",
      "빈 셀뿐 아니라 단위만 있는 셀, 파란색 예시 문구로 보이는 값, 괄호형 작성 안내문, □ 선택지, ○ 표시 지시문도 입력 대상일 수 있다.",
      "반대로 섹션명·표 머리글·포괄 라벨(예: 재무현황, 관련기술현황)과 이미 확정된 고정 문구는 입력 필드로 만들지 않는다.",
      "행 라벨과 열 머리글을 결합해 매출액·연도처럼 구체적인 필드를 선호한다.",
      "값을 작성하거나 추정하지 말고 필드의 의미와 입력 UI만 판정한다.",
      "candidate_id와 쓰기 위치는 바꾸거나 새로 만들지 않는다. evidence는 제공된 텍스트를 짧게 그대로 인용한다.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: `다음 Kordoc 구조 후보를 판정하라.\n${JSON.stringify(candidatePayload)}`,
    }],
    tools: [buildFieldPlanToolSchema()],
    tool_choice: { type: "tool", name: TOOL_NAME },
  });

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolveTimeoutMs());
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
    } finally {
      clearTimeout(timeout);
    }
  };

  let response = await attempt();
  if (RETRYABLE_STATUSES.has(response.status)) response = await attempt();
  const body = await response.text();
  if (!response.ok) throw new Error(`Anthropic field plan failed: ${response.status} ${body.slice(0, 500)}`);
  const payload = JSON.parse(body) as AnthropicResponse;
  const toolUse = payload.content?.find(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use" && "name" in block && block.name === TOOL_NAME,
  );
  if (!toolUse) throw new Error(`도구 응답이 없습니다(stop_reason=${payload.stop_reason ?? "unknown"}).`);
  const raw = isRecord(toolUse.input) && Array.isArray(toolUse.input.decisions) ? toolUse.input.decisions : [];
  const allowed = new Set(input.candidates.map((candidate) => candidate.fieldInstanceId));
  return raw.flatMap((value) => normalizeDecision(value, allowed));
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

function applyDecision(field: RoundtripFieldCandidate, decision: FieldDecision): void {
  field.analysisSource = "llm";
  field.llmConfidence = decision.confidence;
  field.recommendedInput = decision.isUserInput && decision.inputKind !== "none" && decision.confidence >= 0.55;
  field.inputLikelihood = decision.confidence;
  if (field.recommendedInput && decision.inputKind !== "none") {
    field.inputKind = compatibleInputKind(field, decision.inputKind);
  }
  if (decision.helpText) field.helperText = decision.helpText;
  field.inputSignals.push(
    field.recommendedInput ? "LLM 맥락 판정: 사용자 입력" : "LLM 맥락 판정: 입력 대상 아님",
  );
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
  status: RoundtripFieldPlanningSummary["status"],
  model: string | null,
  durationMs: number,
  fields: RoundtripFieldCandidate[],
  warning: string | null,
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
  };
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

function resolveModel(): string {
  return process.env.APPLICATION_ROUNDTRIP_MODEL?.trim() || DEFAULT_MODEL;
}

function resolveMaxTokens(): number {
  const parsed = Number.parseInt(process.env.APPLICATION_ROUNDTRIP_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

function resolveTimeoutMs(): number {
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

function chunkCandidates(fields: RoundtripFieldCandidate[]): RoundtripFieldCandidate[][] {
  const chunks: RoundtripFieldCandidate[][] = [];
  for (let index = 0; index < fields.length; index += LLM_CANDIDATES_PER_REQUEST) {
    chunks.push(fields.slice(index, index + LLM_CANDIDATES_PER_REQUEST));
  }
  return chunks;
}
