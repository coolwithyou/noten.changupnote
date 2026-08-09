// 공모 딥분석 공용 모델 추출기. 운영 worker와 dev analysis-lab adapter가 함께 사용한다.
// Anthropic Messages API 직접 fetch(packages/core/src/bizinfo/llm-criteria.ts 관행).
//
// [Opus 4.8 필수 규칙 — 어기면 400]
//   - temperature / top_p / top_k 를 절대 보내지 않는다(파라미터 제거됨).
//   - thinking 파라미터도 보내지 않는다(생략). budget_tokens 금지.
//
// [비용 계산 — 크레딧/metering 래퍼 사용 금지]
//   운영 원가수집(metering)과 섞이면 실험 비용이 서비스 원가로 오염되므로 여기서 직접 계산만 한다.
//   모델별 가격과 Sonnet 5 가격 전환은 costPolicy 단일 원천을 사용한다.
//
// [응답 불신 원칙 — llm-criteria.ts 동형]
//   dimension/kind enum 밖 값은 드롭, confidence 는 0~1 클램프, source_span 은 최종 입력 텍스트에
//   부분문자열로 실재하는지 서버가 검증한다(spanVerified). 결과는 파일로만 저장하고 DB에 쓰지 않는다.
import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
  DEEP_ANALYSIS_PRIMARY_MODELS,
  assertDeepAnalysisModelEffort,
  supportsDeepAnalysisEffort,
  type CriterionDimension,
  type DeepAnalysisAssessmentStatus,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisConfirmationOption,
  type DeepAnalysisConfirmationReusable,
  type DeepAnalysisCriterion,
  type DeepAnalysisCriterionConfirmation,
  type DeepAnalysisCriterionKind,
  type DeepAnalysisEffort,
  type DeepAnalysisModelResult,
  type DeepAnalysisProgramIntent,
  type DeepAnalysisTaxonomyProposal,
  type DeepAnalysisUsage,
} from "@cunote/contracts";
import { priceDeepAnalysisUsage } from "./costPolicy";

export const ANALYSIS_LAB_TOOL_NAME = "emit_deep_grant_analysis";

const DEFAULT_MAX_TOKENS = 12_000;
const DEFAULT_TIMEOUT_MS = 540_000;

// 운영 deep-analysis-v1부터 22축 전부를 criterion으로 표현한다. premises와
// export_performance도 axis에서 조건을 찾았으면 근거 있는 criterion이 반드시 존재해야 한다.
const CRITERIA_EMITTABLE_DIMENSIONS = CRITERION_DIMENSIONS;

export function resolveLabModel(): string {
  return process.env.ANALYSIS_LAB_MODEL?.trim() || DEEP_ANALYSIS_PRIMARY_MODELS[0];
}

function resolveMaxTokens(): number {
  const raw = process.env.ANALYSIS_LAB_MAX_TOKENS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

function resolveTimeoutMs(): number {
  const raw = process.env.ANALYSIS_LAB_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export type DeepAnalysisResult = DeepAnalysisModelResult;

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

// 일시 오류(레이트리밋·과부하·서버 오류)는 1회 재시도한다(원시 fetch 라 SDK 자동 재시도가 없음).
const RETRYABLE_STATUSES = new Set([429, 500, 529]);
const RETRY_DELAY_MS = 5_000;

export async function runDeepGrantAnalysis(options: {
  apiKey: string;
  /** 최종 LLM 입력 텍스트(input.ts 산출) — source_span 검증 기준. */
  inputText: string;
  /** map-reduce synthesis처럼 모델 입력과 source_span 검증 원문이 다를 때만 지정한다. */
  evidenceText?: string;
  /** 운영 worker는 allowlist를 통과한 모델을 명시한다. */
  model?: string;
  /** 지원 모델은 비용·품질 비교를 재현할 수 있도록 request-level effort를 명시한다. */
  effort?: DeepAnalysisEffort | null;
  /** map-reduce synthesis처럼 기본 분석 지시를 더 좁혀야 할 때만 사용한다. */
  taskInstruction?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeepAnalysisResult> {
  const model = options.model ?? resolveLabModel();
  const effort = options.effort === undefined
    ? supportsDeepAnalysisEffort(model) ? "high" : null
    : options.effort;
  assertDeepAnalysisModelEffort({ model, effort });
  const maxTokens = resolveMaxTokens();
  const requestBody = JSON.stringify({
    model,
    max_tokens: maxTokens,
    ...(effort ? { output_config: { effort } } : {}),
    system: DEEP_ANALYSIS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        options.taskInstruction
          ?? "아래 공고 입력(구조화 필드 + 첨부 공고문 전문)만 근거로 공고를 깊게 분석해라.",
        "22축 전부를 검사하고, 모든 조건·평가에 원문 인용(source_span)을 남겨라.",
        "공고 밖의 상식이나 사업명만으로 조건을 추정하지 마라.",
        "",
        options.inputText,
      ].join("\n"),
    }],
    tools: [buildDeepAnalysisToolSchema()],
    tool_choice: { type: "tool", name: ANALYSIS_LAB_TOOL_NAME },
  });

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolveTimeoutMs());
    try {
      return await (options.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        // Opus 4.8: temperature/top_p/top_k/thinking 절대 미포함(400 방지 — 상단 주석).
        body: requestBody,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Anthropic 딥분석 호출이 타임아웃됐습니다(${resolveTimeoutMs()}ms).`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  let response = await attempt();
  if (RETRYABLE_STATUSES.has(response.status)) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_DELAY_MS));
    response = await attempt();
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic deep analysis failed: ${response.status} ${response.statusText}\n${body.slice(0, 1_000)}`,
    );
  }
  const payload = JSON.parse(body) as AnthropicMessageResponse;
  const toolUse = payload.content?.find(
    (block): block is AnthropicToolUseBlock =>
      block.type === "tool_use" && "name" in block && block.name === ANALYSIS_LAB_TOOL_NAME,
  );
  if (!toolUse) {
    // stop_reason 으로 실패 원인을 구분한다 — "tool_use 없음"만으로는 원인을 오해하기 쉽다.
    if (payload.stop_reason === "max_tokens") {
      throw new Error(
        `출력 토큰 한도(max_tokens=${maxTokens})에 도달해 도구 응답이 잘렸습니다. ` +
          "env ANALYSIS_LAB_MAX_TOKENS 를 높여 재시도해주세요.",
      );
    }
    if (payload.stop_reason === "refusal") {
      throw new Error("모델이 이 입력에 대한 응답을 거부했습니다(stop_reason=refusal).");
    }
    throw new Error(
      `Anthropic 응답에 ${ANALYSIS_LAB_TOOL_NAME} tool_use 가 없습니다(stop_reason=${payload.stop_reason ?? "unknown"}).`,
    );
  }

  const input = isRecord(toolUse.input) ? toolUse.input : {};
  const evidenceText = options.evidenceText ?? options.inputText;
  const usage = normalizeUsage(payload.usage);
  return {
    model,
    effort,
    analysisMarkdown: typeof input.analysis_markdown === "string" ? input.analysis_markdown : "",
    programIntent: normalizeProgramIntent(input.program_intent),
    criteria: normalizeCriteria(input.criteria, evidenceText),
    axisAssessments: normalizeAxisAssessments(input.axis_assessments),
    taxonomyProposals: normalizeTaxonomyProposals(input.taxonomy_proposals),
    usage,
    costUsd: usage ? priceDeepAnalysisUsage({ model, usage }) : null,
    rawToolInput: input,
    rawResponseText: body,
    stopReason: payload.stop_reason ?? null,
  };
}

// ── tool 스키마(손으로 쓴 JSON Schema — pilot/llm-criteria 스타일) ─────

/**
 * v3 confirmation tool 스키마 조각 — buildDeepAnalysisToolSchema 의 criteria[].confirmation
 * 정의이자, 경량 보강 CLI(confirmations.ts)가 재사용하는
 * 단일 원천이다(이중 관리 금지). 구조를 바꾸면 양쪽 promptVersion 을 함께 재고할 것.
 */
export const CONFIRMATION_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: { type: "string" },
    options: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "string" },
          label: { type: "string" },
          disqualifies: { type: "boolean" },
        },
        required: ["value", "label", "disqualifies"],
      },
    },
    answer_type: { type: "string", enum: ["single", "multi"] },
    reusable: { type: "string", enum: ["company_fact", "per_notice"] },
    condition_key: { type: "string" },
  },
  required: ["prompt", "options", "answer_type", "reusable"],
};

export function buildDeepAnalysisToolSchema() {
  return {
    name: ANALYSIS_LAB_TOOL_NAME,
    description: "공고 딥분석 결과(분석 문서·의도·22축 분해·축별 검사·신규 축 제안)를 반환한다.",
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
              dimension: { type: "string", enum: [...CRITERIA_EMITTABLE_DIMENSIONS] },
              operator: { type: "string", enum: [...CRITERION_OPERATORS] },
              kind: { type: "string", enum: [...CRITERION_KINDS] },
              value: { type: "object" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              source_span: { type: "string" },
              note: { type: "string" },
              // v3: 자가신고 확인 질문 — 판정 불가 결격(exclusion)에만 생성하므로 required 에 넣지 않는다.
              confirmation: CONFIRMATION_TOOL_SCHEMA,
            },
            required: ["dimension", "operator", "kind", "value", "confidence", "source_span"],
          },
        },
        axis_assessments: {
          type: "array",
          minItems: CRITERION_DIMENSIONS.length,
          maxItems: CRITERION_DIMENSIONS.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
              status: {
                type: "string",
                enum: ["condition_found", "inspected_no_condition", "ambiguous", "input_missing"],
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              comment: { type: "string" },
            },
            required: ["dimension", "status", "confidence", "comment"],
          },
        },
        analysis_markdown: {
          type: "string",
          description: "사람이 읽는 한국어 분석 문서(마크다운, 시스템 프롬프트의 구조 준수)",
        },
        program_intent: {
          type: "object",
          additionalProperties: false,
          properties: {
            one_liner: { type: "string" },
            target_profile: { type: "string" },
            evaluation_focus: { type: "array", items: { type: "string" } },
            benefit_summary: { type: "string" },
            caution_notes: { type: "array", items: { type: "string" } },
          },
          required: ["one_liner", "target_profile", "evaluation_focus", "benefit_summary", "caution_notes"],
        },
        taxonomy_proposals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              proposed_dimension: { type: "string" },
              rationale: { type: "string" },
              example_span: { type: "string" },
            },
            required: ["proposed_dimension", "rationale", "example_span"],
          },
        },
      },
      required: ["criteria", "axis_assessments", "analysis_markdown", "program_intent", "taxonomy_proposals"],
    },
  };
}

// ── 응답 정규화(응답 불신 — DB 미기록) ─────────────────────────────

/** export 는 검증 스크립트용(런타임 사용처는 runDeepGrantAnalysis 뿐). */
export function normalizeCriteria(rows: unknown, inputText: string): DeepAnalysisCriterion[] {
  if (!Array.isArray(rows)) return [];
  const normalizedInput = normalizeEvidence(inputText);
  const inputLines = buildNormalizedInputLines(inputText);
  const criteria: DeepAnalysisCriterion[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const dimension = stringEnum(row.dimension, CRITERIA_EMITTABLE_DIMENSIONS);
    const kind = stringEnum(row.kind, CRITERION_KINDS) as DeepAnalysisCriterionKind | null;
    if (!dimension || !kind) continue; // enum 밖 값은 드롭.
    const operator = typeof row.operator === "string" &&
      (CRITERION_OPERATORS as readonly string[]).includes(row.operator)
      ? row.operator
      : "text_only";
    const requestedSourceSpan = cleanString(row.source_span);
    const sourceSpan = requestedSourceSpan
      ? resolveExactEvidenceSpan(requestedSourceSpan, inputText) ?? requestedSourceSpan
      : null;
    const spanCheck = verifySpan(sourceSpan, normalizedInput, inputLines, inputText.length);
    const value = normalizeCriterionValue({
      rawValue: row.value,
      dimension,
      kind,
      operator,
      sourceSpan,
      spanVerified: spanCheck.verified,
      note: cleanString(row.note),
      inputText,
    });
    const confirmation = normalizeConfirmation(row.confirmation);
    criteria.push({
      dimension,
      kind,
      operator,
      value,
      confidence: boundedConfidence(row.confidence),
      sourceSpan,
      spanVerified: spanCheck.verified,
      spanOffsetRatio: spanCheck.offsetRatio,
      note: cleanString(row.note),
      // 드롭이면 필드 자체를 만들지 않는다(undefined 설정 금지 — v2 이하 런 파일과 형태 동일).
      ...(confirmation ? { confirmation } : {}),
    });
  }
  return criteria;
}

const CONFIRMATION_ANSWER_TYPES = ["single", "multi"] as const;
const CONFIRMATION_REUSABLES: readonly DeepAnalysisConfirmationReusable[] = ["company_fact", "per_notice"];

/**
 * confirmation 정규화(v3) — 응답 불신 원칙. 부분 결함은 옵션 단위로 드롭하되,
 * 질문으로 성립하지 않으면(프롬프트 없음·옵션 2~4개 밖·결격/비결격 극성 결손·reusable
 * 어휘 밖) confirmation 전체를 드롭한다 — criterion 은 유지된다(질문 없는 결격 추출).
 * export 는 검증 스크립트용.
 */
export function normalizeConfirmation(value: unknown): DeepAnalysisCriterionConfirmation | null {
  if (!isRecord(value)) return null;
  const prompt = cleanString(value.prompt);
  if (!prompt) return null;

  if (!Array.isArray(value.options)) return null;
  const options: DeepAnalysisConfirmationOption[] = [];
  const seenValues = new Set<string>();
  for (const row of value.options) {
    if (!isRecord(row)) continue;
    const optionValue = cleanString(row.value);
    const label = cleanString(row.label);
    if (!optionValue || !label || typeof row.disqualifies !== "boolean") continue; // 결함 옵션 드롭.
    if (seenValues.has(optionValue)) continue; // value 중복 제거(첫 항목 유지).
    seenValues.add(optionValue);
    options.push({ value: optionValue, label, disqualifies: row.disqualifies });
  }
  if (options.length < 2 || options.length > 4) return null;
  if (!options.some((option) => option.disqualifies) || !options.some((option) => !option.disqualifies)) {
    return null; // 결격/비결격 어느 한쪽이 없으면 질문으로 무의미.
  }

  const answerType = stringEnum(value.answer_type, CONFIRMATION_ANSWER_TYPES) ?? "single";
  const reusable = stringEnum(value.reusable, CONFIRMATION_REUSABLES);
  if (!reusable) return null;
  return {
    prompt,
    options,
    answerType,
    reusable,
    // per_notice 는 공고 국한 선언 — 키가 와도 강제 null(공고 간 식별 대상 아님).
    conditionKey: reusable === "company_fact" ? cleanString(value.condition_key) : null,
  };
}

/**
 * 원본 라인 ↔ 정규화 라인의 대응 — 라인 폴백 검증이 히트한 줄을 원본 inputText 기준
 * 문자 오프셋으로 환산하기 위해 유지한다(정규화 후 빈 줄을 필터링하면 원 인덱스가 어긋난다).
 */
interface NormalizedInputLine {
  /** 공백 정규화된 라인 텍스트(빈 라인은 목록에서 제외). */
  normalized: string;
  /** 원본 inputText 기준 이 라인의 시작 문자 오프셋 — 위치 진단(offsetRatio) 계산용. */
  startOffset: number;
}

/** 위치 진단용 라인 인덱스. export 는 검증 스크립트용(런타임 사용처는 normalizeCriteria 뿐). */
export function buildNormalizedInputLines(inputText: string): NormalizedInputLine[] {
  const lines: NormalizedInputLine[] = [];
  let offset = 0;
  for (const raw of inputText.split("\n")) {
    const normalized = normalizeEvidence(raw);
    if (normalized.length > 0) lines.push({ normalized, startOffset: offset });
    offset += raw.length + 1; // 개행 문자 1자 포함.
  }
  return lines;
}

/** verifySpan 결과 — 검증 여부 + 검증된 히트 위치의 입력 내 비율(0~1, 미검증이면 null). */
export interface SpanVerification {
  verified: boolean;
  offsetRatio: number | null;
}

/**
 * HWP markdown의 줄바꿈/연속 공백 또는 structured JSON 문자열의 escape를 모델이
 * 사람이 읽는 형태로 인용한 경우 실제 sealed raw substring으로 되돌린다.
 * 여러 위치가 같은 raw substring을 가리키는 것은 위치를 선택하지 않아도 되므로
 * 허용한다. JSON 문자열의 escape 표기만 다른 후보는 모두 같은 requestedSpan으로
 * 정규화됨이 확인된 경우라서 sealed source 순서상 첫 exact raw span을 사용한다.
 * 일반 원문의 서로 다른 공백 후보는 임의 선택하지 않고 validator가 계속 차단한다.
 */
export function resolveExactEvidenceSpan(
  requestedSpan: string,
  inputText: string,
): string | null {
  if (inputText.includes(requestedSpan)) return requestedSpan;
  const directCandidates = findNormalizedEvidenceCandidates(requestedSpan, inputText);
  if (directCandidates.length === 1) return directCandidates[0]!;
  const trailingBullet = resolveTrailingBulletEvidenceCandidate(requestedSpan, inputText);
  if (trailingBullet) return trailingBullet;

  return findEscapedEvidenceCandidates(requestedSpan, inputText)[0] ?? null;
}

/**
 * validator가 차단한 source_span을 repair할 때만 사용하는 exact 후보 목록이다.
 * 공백 정규화 결과가 같은 raw substring이 여러 개면 자동 선택하지 않고 전부
 * 반환한다. 일반 normalize 경계는 계속 후보가 하나일 때만 자동 복원한다.
 */
export function findExactEvidenceSpanCandidates(
  requestedSpan: string,
  inputText: string,
): string[] {
  if (inputText.includes(requestedSpan)) return [requestedSpan];
  const directCandidates = findNormalizedEvidenceCandidates(requestedSpan, inputText);
  if (directCandidates.length > 0) return directCandidates;
  const trailingBullet = resolveTrailingBulletEvidenceCandidate(requestedSpan, inputText);
  if (trailingBullet) return [trailingBullet];
  const escapedCandidates = findEscapedEvidenceCandidates(requestedSpan, inputText);
  if (escapedCandidates.length > 0) return escapedCandidates;
  return findOrderedTokenEvidenceCandidates(requestedSpan, inputText)
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
}

function findEscapedEvidenceCandidates(
  requestedSpan: string,
  inputText: string,
): string[] {
  const escapedCandidates = new Set<string>();
  for (const match of inputText.matchAll(JSON_STRING_LITERAL_PATTERN)) {
    const token = match[0];
    let decoded: unknown;
    try {
      decoded = JSON.parse(token);
    } catch {
      continue;
    }
    if (typeof decoded !== "string") continue;
    const decodedCandidate =
      resolveNormalizedEvidenceCandidate(requestedSpan, decoded)
      ?? resolveNormalizedEvidenceCandidate(requestedSpan, decoded, true);
    if (!decodedCandidate) continue;
    const encodedCandidate = JSON.stringify(decodedCandidate).slice(1, -1);
    if (token.slice(1, -1).includes(encodedCandidate)) {
      escapedCandidates.add(encodedCandidate);
    }
  }
  return [...escapedCandidates];
}

const DEEP_ANALYSIS_SOURCE_BODY_PATTERN =
  /^<<<DEEP_ANALYSIS_SOURCE id="[^"]+" kind="(?:structured|attachment)" sha256="[0-9a-f]{64}">>>\n([\s\S]*?)\n<<<END_DEEP_ANALYSIS_SOURCE>>>$/gm;
const MAX_ORDERED_TOKEN_EVIDENCE_CHARS = 8_000;
const MAX_ORDERED_TOKEN_EVIDENCE_CANDIDATES = 16;
const MAX_ORDERED_TOKEN_START_OFFSETS_PER_SOURCE = 4_096;

/**
 * 모델이 표의 여러 셀을 공백 한 줄로 이어 쓰거나 OCR 어절 공백을 제거한 경우의
 * repair 전용 후보다. 요청 문자열의 의미를 해석하지 않고 2자 이상 어절(숫자 포함
 * 어절과 문장 끝 어절은 1자 허용)이 원문에서 같은 순서로 모두 나타나는 구간만 exact
 * substring으로 반환한다. 이 후보도 자동 채택하지 않고 repair 모델 입력에만 제공한다.
 */
function findOrderedTokenEvidenceCandidates(
  requestedSpan: string,
  inputText: string,
): string[] {
  const rawTokens = [...requestedSpan.matchAll(/[\p{Letter}\p{Number}%~]+/gu)]
    .map((match) => match[0]);
  const tokens = rawTokens
    .filter((token) => token.length >= 2 || /\p{Number}/u.test(token));
  const trailingToken = rawTokens.at(-1);
  if (
    trailingToken
    && !tokens.includes(trailingToken)
    && trailingToken.length === 1
  ) {
    tokens.push(trailingToken);
  }
  if (tokens.length < 3) return [];

  const sourceBodies = [...inputText.matchAll(DEEP_ANALYSIS_SOURCE_BODY_PATTERN)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  const bodies = sourceBodies.length > 0 ? sourceBodies : [inputText];
  const candidates = new Set<string>();
  for (const body of bodies) {
    const mapped = compactEvidenceWithOffsets(body);
    const firstToken = tokens[0]!.replace(/\s+/g, "");
    let inspectedStartOffsets = 0;
    for (
      let firstOffset = mapped.text.indexOf(firstToken);
      firstOffset >= 0
        && inspectedStartOffsets < MAX_ORDERED_TOKEN_START_OFFSETS_PER_SOURCE;
      firstOffset = mapped.text.indexOf(firstToken, firstOffset + 1)
    ) {
      inspectedStartOffsets += 1;
      let cursor = firstOffset + firstToken.length;
      let lastEnd = cursor;
      let matched = true;
      for (const token of tokens.slice(1)) {
        const compactToken = token.replace(/\s+/g, "");
        const offset = mapped.text.indexOf(compactToken, cursor);
        if (offset < 0) {
          matched = false;
          break;
        }
        lastEnd = offset + compactToken.length;
        cursor = lastEnd;
      }
      if (!matched) continue;
      const start = mapped.starts[firstOffset];
      const end = mapped.ends[lastEnd - 1];
      if (
        start === undefined
        || end === undefined
        || end <= start
        || end - start > MAX_ORDERED_TOKEN_EVIDENCE_CHARS
      ) continue;
      candidates.add(body.slice(start, end));
      if (candidates.size > MAX_ORDERED_TOKEN_EVIDENCE_CANDIDATES * 4) {
        retainShortestEvidenceCandidates(
          candidates,
          MAX_ORDERED_TOKEN_EVIDENCE_CANDIDATES * 2,
        );
      }
    }
  }
  return [...candidates]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_ORDERED_TOKEN_EVIDENCE_CANDIDATES);
}

function retainShortestEvidenceCandidates(
  candidates: Set<string>,
  limit: number,
): void {
  const retained = [...candidates]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, limit);
  candidates.clear();
  for (const candidate of retained) candidates.add(candidate);
}

function compactEvidenceWithOffsets(value: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  while (index < value.length) {
    const whitespaceWidth = evidenceWhitespaceWidth(value, index, false);
    if (whitespaceWidth > 0) {
      index += whitespaceWidth;
      continue;
    }
    characters.push(value[index]!);
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }
  return { text: characters.join(""), starts, ends };
}

/**
 * HWP 표에서 모델이 짧은 섹션 제목의 불릿(□)을 조건문 불릿(▸)으로 잘못 복사한 경우,
 * 실제 조건문 자체가 충분히 길고 sealed input에서 유일하게 해소될 때만 제목을 버리고
 * 두 번째 불릿 이후 exact substring을 근거로 사용한다. 일반 목록이나 여러 문장을
 * 임의로 축약하지 않도록 ▸가 정확히 2개, 제목 prefix 40자 이하, 조건문 40자 이상을
 * 모두 요구한다.
 */
function resolveTrailingBulletEvidenceCandidate(
  requestedSpan: string,
  inputText: string,
): string | null {
  const offsets = [...requestedSpan.matchAll(/▸/g)].map((match) => match.index);
  if (offsets.length !== 2) return null;
  const second = offsets[1]!;
  const prefix = normalizeEvidence(requestedSpan.slice(0, second));
  const condition = requestedSpan.slice(second).trim();
  if (prefix.length > 40 || normalizeEvidence(condition).length < 40) return null;
  if (inputText.includes(condition)) return condition;
  return resolveNormalizedEvidenceCandidate(condition, inputText);
}

const JSON_STRING_LITERAL_PATTERN =
  /"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\])*"/g;

function resolveNormalizedEvidenceCandidate(
  requestedSpan: string,
  inputText: string,
  decodeEscapedWhitespace = false,
): string | null {
  const candidates = findNormalizedEvidenceCandidates(
    requestedSpan,
    inputText,
    decodeEscapedWhitespace,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

function findNormalizedEvidenceCandidates(
  requestedSpan: string,
  inputText: string,
  decodeEscapedWhitespace = false,
): string[] {
  const needle = normalizeEvidence(requestedSpan);
  if (needle.length < 2) return [];
  const mapped = normalizeEvidenceWithOffsets(inputText, decodeEscapedWhitespace);
  const candidates = new Set<string>();
  for (
    let offset = mapped.text.indexOf(needle);
    offset >= 0;
    offset = mapped.text.indexOf(needle, offset + 1)
  ) {
    const start = mapped.starts[offset];
    const end = mapped.ends[offset + needle.length - 1];
    if (start !== undefined && end !== undefined && end > start) {
      candidates.add(inputText.slice(start, end));
    }
  }
  return [...candidates];
}

/**
 * source_span 이 최종 입력 텍스트(공백 정규화)에 부분문자열로 실재하는지 검사하고,
 * 검증된 경우 히트 위치의 입력 내 비율(offsetRatio, 0~1)을 부수 기록한다 —
 * 장문 recall 저하(lost-in-the-middle) 위치 진단 전용(선행 구현 #7, aggregate.ts 가 소비).
 * [프롬프트 동결 원칙] 이 확장은 저장 메타데이터 추가일 뿐이다 — 요청 본문·시스템
 * 프롬프트·tool 스키마는 무변경(promptVersion lab-deep-v2 불변). Opus 4.8 파라미터
 * 불변식(temperature/top_p/top_k/thinking 미전송)도 그대로다.
 * offsetRatio 분모: 직접 히트는 정규화 입력 길이, 라인 폴백 히트는 원본 입력 길이 —
 * 전/중/후 3분위 진단 목적상 두 분모가 섞이는 미세 오차는 허용한다(정밀 좌표 아님).
 * export 는 검증 스크립트용.
 */
export function verifySpan(
  span: string | null,
  normalizedInput: string,
  inputLines: NormalizedInputLine[],
  /** 원본 inputText 길이 — 라인 폴백 히트의 offsetRatio 분모. */
  inputTotalChars: number,
): SpanVerification {
  if (!span) return { verified: false, offsetRatio: null };
  const needle = normalizeEvidence(span);
  if (needle.length < 2) return { verified: false, offsetRatio: null };
  const directIndex = normalizedInput.indexOf(needle);
  if (directIndex >= 0) {
    return {
      verified: true,
      offsetRatio: normalizedInput.length > 0 ? directIndex / normalizedInput.length : null,
    };
  }
  // 폴백(v2): "라벨: 값" 형식 인용은 라벨과 값이 "같은 줄"에 함께 실재할 때만 인정한다.
  // 전체 텍스트 기준 개별 포함으로 하면 서로 다른 문맥의 라벨·값 조합("지원지역: 서울"류)이
  // 거짓 검증될 수 있다(Codex 리뷰 M4) — 같은 줄 공존을 요구해 차단한다.
  const colon = needle.indexOf(":");
  if (colon > 0) {
    const label = needle.slice(0, colon).trim();
    const value = needle.slice(colon + 1).trim();
    if (label.length >= 2 && value.length >= 2) {
      const hitLine = inputLines.find(
        (line) => line.normalized.includes(label) && line.normalized.includes(value),
      );
      if (hitLine) {
        return {
          verified: true,
          offsetRatio: inputTotalChars > 0 ? hitLine.startOffset / inputTotalChars : null,
        };
      }
    }
  }
  return { verified: false, offsetRatio: null };
}

const AXIS_STATUSES: readonly DeepAnalysisAssessmentStatus[] = [
  "condition_found",
  "inspected_no_condition",
  "ambiguous",
  "input_missing",
];

export function normalizeAxisAssessments(rows: unknown): DeepAnalysisAxisAssessment[] {
  if (!Array.isArray(rows)) return [];
  const byDimension = new Map<CriterionDimension, DeepAnalysisAxisAssessment>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const dimension = stringEnum(row.dimension, CRITERION_DIMENSIONS);
    const status = stringEnum(row.status, AXIS_STATUSES);
    if (!dimension || !status || byDimension.has(dimension)) continue;
    byDimension.set(dimension, {
      dimension,
      status,
      confidence: boundedConfidence(row.confidence),
      comment: cleanString(row.comment),
    });
  }
  // 22축 표준 순서로 정렬(누락 축은 반환하지 않음 — diff 쪽에서 null 처리).
  return CRITERION_DIMENSIONS.flatMap((dimension) => {
    const assessment = byDimension.get(dimension);
    return assessment ? [assessment] : [];
  });
}

function normalizeTaxonomyProposals(rows: unknown): DeepAnalysisTaxonomyProposal[] {
  if (!Array.isArray(rows)) return [];
  const proposals: DeepAnalysisTaxonomyProposal[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const proposedDimension = cleanString(row.proposed_dimension);
    const rationale = cleanString(row.rationale);
    const exampleSpan = cleanString(row.example_span);
    if (!proposedDimension || !rationale || !exampleSpan) continue;
    proposals.push({ proposedDimension, rationale, exampleSpan });
  }
  return proposals;
}

function normalizeProgramIntent(value: unknown): DeepAnalysisProgramIntent | null {
  if (!isRecord(value)) return null;
  return {
    oneLiner: cleanString(value.one_liner) ?? "",
    targetProfile: cleanString(value.target_profile) ?? "",
    evaluationFocus: stringArray(value.evaluation_focus),
    benefitSummary: cleanString(value.benefit_summary) ?? "",
    cautionNotes: stringArray(value.caution_notes),
  };
}

function normalizeUsage(usage: Record<string, unknown> | undefined): DeepAnalysisUsage | null {
  if (!usage) return null;
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cacheReadTokens = finiteNumber(usage.cache_read_input_tokens);
  return { inputTokens, outputTokens, cacheReadTokens };
}

// ── 시스템 프롬프트 ────────────────────────────────────────────────
// llm-criteria.ts 의 22축 분해·결격 canonical 매핑 지침 기반 + 딥분석 강화(첨부 전문 근거·전수 검사·인용 의무).

/**
 * v3 confirmation 생성 규칙 원문 — DEEP_ANALYSIS_SYSTEM_PROMPT 본문의 일부(스프레드 삽입,
 * 조인 결과 불변)이자, 경량 보강 CLI(confirmations.ts)가
 * 그대로 공유하는 단일 원천이다(이중 관리 금지). 문구 수정은 곧 프롬프트 개정이다 —
 * 양쪽 promptVersion 을 함께 재고할 것.
 */
export const CONFIRMATION_PROMPT_RULES = [
  "[confirmation — 자가신고 확인 질문(결격 전용)]",
  "kind=exclusion 인 criterion 중 소싱 가능한 기업 데이터로 충족 여부를 판정할 수 없고 기업의 자가신고로만 해소되는 항목에는 confirmation 객체를 함께 생성한다.",
  "대상 예: prior_award 의 수혜·참여 이력 조건, other/text_only 의 절차·자격 조건. tax_compliance/credit_status/sanction 의 표준 플래그 결격에는 만들지 않는다(공용 확인 절차가 따로 있다). 표준 플래그로 담기지 않는 특수 조건이면 예외로 생성한다.",
  "prompt 는 source_span 원문의 특정성을 그대로 유지한 존댓말 객관식 질문 문장으로 쓴다. canonical 값 기준으로 일반화하지 마라. 예: 원문이 '타 정부지원사업에서 체계적합성시험비를 기 지원받은 경우'라면 '다른 정부지원사업에서 체계적합성시험비를 지원받은 적이 있나요?' 로 묻는다 — '올해 다른 지원사업 수혜를 받은 적이 있나요?' 같은 일반화 금지.",
  "options 는 2~4개. value 는 영문 snake_case, label 은 한국어. 결격에 해당하는 선택지는 disqualifies=true 로 표시하고, disqualifies true/false 선택지가 각각 최소 1개씩 있어야 한다. '잘 모르겠어요' 선택지는 만들지 마라(확인 UI가 공통 제공한다).",
  "reusable: 답이 이 공고와 무관하게 성립하는 기업의 사실(특정 항목 수혜 이력, 사업 참여 이력 등)이면 company_fact, 이 공고에서만 유효한 신청 역할 선언(주관기업으로 참여 등)이면 per_notice.",
  "company_fact 이면 condition_key 에 그 사실을 식별하는 안정적인 영문 snake_case 키를 쓴다(예: prior_award_system_conformity_test_fee). per_notice 면 condition_key 를 생략한다.",
];

export const DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE =
  "business_status는 active/closed 같은 사업자등록상 운영 상태만 뜻한다. 지급불능·부도·파산·회생·법정관리·청산은 credit_status 플래그로만 표현하고, 동일 사실을 business_status criterion이나 condition_found로 중복 표현하지 마라. 예: 원문이 '부도 또는 파산기업(예정 포함)'이면 credit_status의 bond_default/bankruptcy_filed만 추출하고, 다른 휴업·폐업 근거가 없는 한 business_status는 inspected_no_condition이다.";
export const DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE =
  "중소기업·중견기업·대기업 같은 법정 기업 규모 분류는 size로만 표현한다. target_type은 개인사업자·법인사업자·협동조합·비영리법인처럼 신청 주체의 법적 형태나 역할 유형에만 사용한다. 동일한 규모 문구를 size와 target_type에 중복 criterion이나 condition_found로 만들지 마라. 법인인감 날인, 회사명·대표자 기재, 제출서식 같은 작성·제출 방식만으로 법인사업자 전용이라고 추정하지 마라. 개인사업자 배제나 법인만 신청 가능하다는 명시적 자격 문장이 없으면 target_type 조건이 아니다.";
export const DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE =
  "신청대상 유형 열거에 '등', '예:', '포함하되 이에 한정되지 않음', '주로', '중심으로'처럼 예시임을 나타내는 표현이 있으면 target_type value.list_semantics=\"open\"으로 둔다. '다음 각 호에 한함', '아래 유형만', '이외 신청 불가'처럼 완전 열거가 명시됐거나, 지원대상·신청자격 문장이 신청 가능한 유형을 유한 목록으로 열거하면서 예시 표지가 없으면 list_semantics=\"closed\"로 둔다. open 목록 밖 유형을 자동 탈락시키지 마라.";
export const DEEP_ANALYSIS_SOURCE_SPAN_CONTIGUITY_RULE =
  "각 criterion의 source_span은 한 입력 블록 안의 연속된 substring 하나를 공백·줄바꿈·문장부호까지 그대로 복사한다. 서로 떨어진 문장, 표의 비인접 행, 본문과 각주를 한 source_span으로 합치지 마라. 여러 문장이 같은 조건을 보충하면 criterion을 충분히 입증하는 가장 짧은 연속 구간 하나만 source_span으로 쓰고 나머지는 note와 analysis_markdown에 설명한다.";
export const DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE =
  "financial_health의 구조화 criterion에 impairment_excluded가 full을 포함하면 자본전액잠식 결격을 이미 반영한 것이다. 같은 자본전액잠식 문구를 별도 text_only criterion으로 중복 만들지 말고, audit에서 그런 audit_only 후보가 나오면 primary 누락이 아니라 중복으로 판단하라.";
export const DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE =
  "criteria는 신청 시점의 자격·지원 제한·우대·평가점수처럼 신청 가능 판단과 사업자 매칭에 직접 쓰이는 규정만 포함한다. 본 사업 선정 후의 협약 이행, 수행내용 준수, 보고 의무와 그 위반에 따른 지원 취소·중단·환수 사유는 criterion으로 만들지 말고 analysis_markdown과 program_intent.caution_notes에만 기록한다. 동일 사실이 신청자격·지원 제한에도 명시되면 그 신청 단계 문장만 criterion 근거로 쓴다. 예: '지원 취소' 아래의 '협약서 등 관련 문서에서 명시한 사항을 2회 이상 위반'과 '지원신청서 및 계획서 내용과 수행내용이 상이'는 sanction/other criterion이 아니다. '회원가입시 ... 서류 제출 (영리기관만 해당)'처럼 괄호가 제출서류 적용 범위만 한정하고 신청 대상을 명시하지 않으면 target_type 조건이 아니다.";
export const DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE =
  "신청서·계획서·제출자료를 허위·거짓·과장 없이 작성한다는 진실성 서약, 표절·도용 금지, 서류 미제출·미비·양식 미준수 같은 접수 절차는 회사가 현재 보유한 자격 사실이 아니다. 이런 문구는 other/text_only exclusion, confirmation, condition_found로 만들지 말고 analysis_markdown 또는 program_intent.caution_notes의 신청 체크사항으로만 보존한다. 다만 과거 허위 제출로 인해 현재 정부사업 참여제한·제재 중이라는 명시적 상태는 sanction criterion으로 추출한다.";
export const DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE =
  "신청서·서식의 빈칸·체크박스·기업정보 기재란과 제출서류 목록은 정보수집·증빙 요구일 뿐이다. 납세증명서·사업자등록증·보험서류 같은 문서의 제출 요구만으로 신청자격·결격·우대·배점 조건이나 ambiguous 후보를 만들지 마라. 주변 문구나 공고 본문에 그 문서가 증명하는 사실의 필수·제외·우대·배점 효과가 명시되지 않았다면 해당 축은 inspected_no_condition이다. 다만 서식 안에서도 신청자격·결격·서약·우대·배점이 문장으로 명시되면 그 명시 문장을 근거로 조건을 추출한다.";
export const DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE =
  "자격·결격 문장에 붙은 '단', '다만', '예외' 조건은 매칭 결과를 바꾸는 핵심 조건이다. 예외를 생략하거나 바로 앞뒤의 다른 criterion에 옮겨 붙이지 마라. 각 criterion의 value.exceptions에는 그 criterion에 실제 적용되는 canonical 예외만 넣고, source_span은 본문과 해당 예외 문구를 함께 포함해 글자 그대로 인용하라. 같은 flags라도 예외의 종류나 적용 대상이 다르면 의미가 다른 criterion이다.";
export const DEEP_ANALYSIS_STRUCTURED_TARGET_RULE =
  "sealed structured source의 rawPayload.trgetNm은 Bizinfo가 제공한 공식 신청대상 필드다. 이 값이 '중소기업'처럼 지원대상을 구체적으로 명시하면 첨부 본문에 같은 문장이 반복되지 않아도 해당 축 criterion의 유효한 근거로 사용하고, 첨부에 없다는 이유만으로 inspected_no_condition이나 unsure로 낮추지 마라. 다만 structured 신청대상과 공고 본문·첨부의 명시 조건이 서로 충돌하면 임의로 선택하지 말고 ambiguous로 남겨라. 특히 본문의 신청·추천 대상 문장이 규모를 한정하지 않고 기업·기관 등으로 열려 있으며 신청서의 신청주체 선택란도 대기업·중소기업·대학·공공기관처럼 structured target보다 넓은 유형을 명시하면, 그 선택란은 단독 자격근거가 아니라 본문과 결합해 structured target 충돌을 입증하는 근거다. 이 경우 structured target만으로 size required criterion을 만들지 마라.";
export const DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE =
  "K-Startup의 rawPayload.biz_enyy와 biz_trgt_age처럼 포털 검색용 범주를 넓게 열거한 필드는 그 자체를 신청자격 상·하한으로 만들지 마라. 지원 가능한 모든 업력 또는 연령 범주를 사실상 전부 나열하면 비제한 검색 메타데이터이므로 criterion이나 ambiguous 근거가 아니다. 신청대상·신청자격 본문에 명시된 구체 조건이 있으면 그 문장을 우선하고, 양쪽이 모두 실제 자격 문장인데 충돌할 때만 ambiguous로 남겨라.";
export const DEEP_ANALYSIS_SCORING_TABLE_COMPLETENESS_RULE =
  "선정평가표·평가기준·배점표는 표 제목만 보지 말고 모든 평가항목, 하위 배점 행, 가점 행을 끝까지 검사한다. 점수를 바꾸는 서로 다른 사실은 각각 preferred criterion으로 보존하고 가장 가까운 22축에 배치한다. 안전한 canonical 값이 없으면 other/text_only와 원문 note로 남긴다. 같은 표의 다른 행을 추출했다는 이유로 외국어 홈페이지, 홍보자료, 인증, 사업장, 수출실적 같은 독립 배점 행을 생략하지 마라.";
export const DEEP_ANALYSIS_LOCALITY_PREMISES_RULE =
  "시·군·구 단위 소재지 요건은 region의 시도 코드만으로 의미가 완전히 보존되지 않는다. 예를 들어 '하남시 관내 본사 또는 공장'이면 region에 경기 41을 required로 두는 동시에 premises에 시군구와 본사·공장 조건을 그대로 담은 required/text_only criterion을 별도로 만든다. 시도보다 좁은 소재지 요건을 시도 코드 하나로만 끝내지 마라.";
export const DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE =
  "prior_award states의 completed는 사업 수행을 끝냈다는 뜻으로만 한정하지 않고 선정·수혜 사실이 확정된 상태를 뜻한다. 원문이 '선정된', '선정 이력', '지원을 받은'이면 completed, 현재 참여·수행 중이면 participating, 교육·프로그램 수료·졸업이면 graduated를 사용한다. 다만 원문이 '협약을 체결했던 이력'처럼 상태를 가리지 않고 중단처분·중도포기까지 명시적으로 포함하면 states를 넣지 말고 해당 program의 모든 이력을 대상으로 보존한다. states=[\"completed\"]로 범위를 줄이지 마라. 명시적 '선정된'을 completed로 표현한 결과를 수행완료 오분류로 감사하지 마라.";
export const DEEP_ANALYSIS_COMPOUND_PREDICATE_RULE =
  "하나의 신청조건이 금액·기간·기관유형·투자형태처럼 여러 전제를 AND로 결합하고 현재 canonical value가 그 전제를 모두 표현하지 못하면, 표현 가능한 일부만 구조화해 자동 pass가 가능하게 만들지 마라. 해당 축을 유지한 operator=text_only와 value.note에 전체 조건을 무손실 보존한다. 예: '공고 마감일로부터 2년 이내 투자기관으로부터 총 1천만원 이상 투자'는 현재 investment의 누적 총액만으로 기간과 투자기관을 판정할 수 없으므로 investment/gte가 아니라 investment/text_only 한 건으로 보존한다.";
export const DEEP_ANALYSIS_CONDITIONAL_INDUSTRY_RULE =
  "업종명이 자격·등록·신고 상태 같은 다른 전제 아래 예시로 열거되면 업종 자체의 무조건 배제로 축약하지 마라. 예: '금융정보분석원의 신고·등록이 되지 않은 자(가상자산 매매·중개업 등)'는 FIU 미신고가 핵심 전제이므로 industry/not_in tags로 모든 가상자산 업종을 배제하지 말고, 전체 조건을 industry/text_only와 value.note로 보존한다.";
export const DEEP_ANALYSIS_APPLICANT_INDUSTRY_SCOPE_RULE =
  "공고명·사업목적·모집안내가 동일 산업의 기업·스타트업을 신청자로 반복 지칭하고 지원내용이나 신청서의 제품·기술 분류도 그 산업 범위로 한정하면, 신청대상 절에 KSIC·사업자등록 업태 문장이 없더라도 실제 신청기업의 산업 범위다. 이때 특정 업종 태그로 자동 탈락시키지 말고 industry/required/text_only 한 건과 value.note에 전체 범위를 보존하고, 신청자를 산업 기업으로 지칭한 exact source_span을 사용한다. 예: '바이오 스타트업 모집'과 바이오헬스 기업 발굴 목적, 제약·의료기기·AI-SaMD 신청 분류가 함께 있으면 industry/text_only다. 반대로 지원 과제의 주제·도입 기술·육성하려는 생태계만 언급하고 신청기업을 그 산업 기업으로 반복 지칭하지 않으면 program_intent일 뿐 업종 조건이 아니다.";
export const DEEP_ANALYSIS_JOB_FIELD_INDUSTRY_BOUNDARY_RULE =
  "모집직무·지원직무·배치직무·직무분야·인력 수요 분야는 참여기업이 청년에게 제공할 업무나 프로그램 분야이지 신청기업의 업종 자격이 아니다. 이런 문구는 program_intent에만 보존하고 industry criterion이나 condition_found로 만들지 마라. 예: '모집직무: 경영·사무 / 광고·마케팅 / IT'는 업종 조건이 아니다. '경영·사무 / 광고·마케팅 / IT 분야 고용보험 피보험자수 20인 이상 기업'처럼 축약문만으로 기업 업종인지 모집직무인지 확정할 수 없고 상세 첨부도 입력에서 누락됐다면 industry/text_only를 만들지 말고 industry=input_missing으로 둔다. 상세 원문이 이를 모집직무로 명시하면 industry=inspected_no_condition이다. 신청기업이 특정 업종을 영위해야 한다거나 KSIC·사업자등록 업태·종목·제외업종을 명시한 경우에만 industry criterion을 만든다.";
export const DEEP_ANALYSIS_BUSINESS_STATUS_RULE =
  "휴업과 폐업을 함께 배제하는 '휴·폐업' 조건은 dimension=business_status, operator=not_in, kind=exclusion, value={\"statuses\":[\"suspended\",\"closed\"],\"labels\":[\"휴폐업\"]}로 추출한다. statuses=[\"closed\"]로 휴업을 누락하지 마라.";
export const DEEP_ANALYSIS_UNRESOLVED_REFUND_RULE =
  "기관에서 발생한 환수금 등의 반환이 종결되지 않았다는 조건은 부정수급 발생을 뜻하지 않는다. 원문이 부정수급을 별도로 명시하지 않으면 sanction/subsidy_fraud로 축약하지 말고 sanction/text_only와 value.note에 반환 미종결 조건과 예외를 함께 보존한다.";
export const DEEP_ANALYSIS_INDUSTRY_ENUMERATION_RULE =
  "법령·별표의 제외업종을 구조화할 때는 열거된 모든 행을 끝까지 검사한다. '그 밖에 경제질서 및 미풍양속에 현저히 어긋나는 업종으로서 부령으로 정하는 업종' 같은 마지막 포괄 행을 note에만 남기고 tags에서 누락하지 마라. 안전한 업종 코드나 태그로 판정할 수 없는 행은 별도 industry/text_only로 보존해 부분 열거만으로 자동 pass가 나지 않게 한다.";
export const DEEP_ANALYSIS_ELIGIBILITY_CALCULATION_RULE =
  "다수의 사업자등록증 보유 시 창업여부 기준표에 따라 창업일·업력을 계산하라는 문구는 독립 자격조건이 아니라 biz_age 판정 방법이다. other/text_only criterion이나 confirmation을 만들지 말고, 실제 기준표에서 추출한 biz_age criterion의 note와 analysis_markdown에 계산 방법으로 합쳐 보존한다.";
export const DEEP_ANALYSIS_FUTURE_REGION_ALTERNATIVE_RULE =
  "현재 소재지가 대상 지역 밖이어도 협약체결 전까지 이전하고 확약서를 제출하면 신청할 수 있는 대안 경로가 있으면, 현재 region 값만 보는 region/in criterion으로 즉시 탈락시키지 마라. 이전 기한·대상 지역·확약 조건을 모두 포함한 region/text_only 한 건으로 보존하고, 같은 조건의 일부만 region/in으로 중복 구조화하지 마라. 예: 현재 수도권 기업도 협약 전 비수도권 이전 예정이면 가능한 공고는 비수도권 코드만 region/in으로 만들면 안 된다.";

export const DEEP_ANALYSIS_SYSTEM_PROMPT = [
  "너는 정부지원사업 공고를 깊게 분석하는 전문 분석가다.",
  "첨부 공고문 전문을 근거로 최대한 깊게, 모든 축을 검사하고 반드시 원문 인용(source_span)을 남겨라.",
  "입력에 명시된 내용만 사용한다. 원문에 없는 내용을 창작하지 마라. 모든 source_span 은 입력에 실제 존재하는 짧은 근거 문장이어야 한다.",
  "source_span 은 입력 텍스트의 표기를 글자 그대로 복사하라 — 재구성·요약·라벨 형식 변경을 하지 마라.",
  "",
  "[analysis_markdown — 사람이 읽는 한국어 분석 문서. 반드시 아래 구조를 이 순서대로 따른다]",
  "# 공고 요약",
  "## 이 공고가 찾는 기업",
  "## 자격 요건 분해   (축별로 근거 인용을 포함)",
  "## 결격·배제 조건",
  "## 지원 내용",
  "## 심사·평가 포인트",
  "## 판단 유보 사항   (원문에 없어 확인이 필요한 것)",
  "요건마다 근거를 인용하고, 원문에서 확인되지 않는 내용은 '판단 유보 사항'에 정직하게 남겨라.",
  "",
  "[program_intent — 공모의 정성적 방향성]",
  "one_liner(공고 한 줄 요약), target_profile(이 공고가 찾는 기업상), evaluation_focus(심사에서 중시하는 포인트),",
  "benefit_summary(지원 내용 요약), caution_notes(신청 전 주의할 점)를 원문 근거 위에서 작성한다.",
  "",
  "[criteria — 22축 자격조건 분해]",
  "필수조건은 required, 제외대상은 exclusion, 우대조건은 preferred 로 분리한다.",
  "criteria 는 신청 가능 여부, 결격, 우대, 평가점수에 실제 영향을 주는 명시적 규정만 만든다.",
  DEEP_ANALYSIS_SOURCE_SPAN_CONTIGUITY_RULE,
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_SCORING_TABLE_COMPLETENESS_RULE,
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  DEEP_ANALYSIS_COMPOUND_PREDICATE_RULE,
  DEEP_ANALYSIS_CONDITIONAL_INDUSTRY_RULE,
  DEEP_ANALYSIS_APPLICANT_INDUSTRY_SCOPE_RULE,
  DEEP_ANALYSIS_JOB_FIELD_INDUSTRY_BOUNDARY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_CALCULATION_RULE,
  DEEP_ANALYSIS_FUTURE_REGION_ALTERNATIVE_RULE,
  "지역 코드는 한국 시도 행정코드 2자리(서울 11, 부산 26, 대구 27, 인천 28, 광주 29, 대전 30, 울산 31, 세종 36, 경기 41, 강원 42, 충북 43, 충남 44, 전북 45, 전남 46, 경북 47, 경남 48, 제주 50)를 사용한다.",
  "규모 값은 예비, 소상공인, 소기업, 중소기업, 중견기업, 대기업 중에서만 사용한다.",
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE,
  "업종은 dimension=industry 의 value.tags 배열에 짧은 한국어 정책 태그로 추출한다. 모호하면 text_only 로 남긴다.",
  DEEP_ANALYSIS_INDUSTRY_ENUMERATION_RULE,
  DEEP_ANALYSIS_BUSINESS_STATUS_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  "",
  "[결격(배제) 조건 canonical 매핑 — 반드시 아래 축으로 분해한다]",
  "- 세금·공과금 체납: dimension=tax_compliance, operator=in, kind=exclusion, value.flags=[국세=national_tax_delinquent, 지방세=local_tax_delinquent, 관세=customs_delinquent, 4대보험료=social_insurance_delinquent] 중 해당. 납부기한 연장·징수유예 예외→exceptions=[\"payment_deferral_approved\"], 세금·특수채무 변제 완료 후 증빙 가능→[\"tax_debt_repaid_with_proof\"], 재창업자금 지원 예외→[\"restart_funding_recipient\"], 재도전기업주 재기지원보증 예외→[\"retry_guarantee_recipient\"].",
  "- 신용·금융 상태: dimension=credit_status, operator=in, kind=exclusion, value.flags=[연체=credit_delinquency, 채무불이행=loan_default, 부도=bond_default, 회생·개인회생=rehabilitation_in_progress, 파산=bankruptcy_filed, 법정관리·청산=court_receivership, 금융질서문란=financial_misconduct, 압류=asset_seizure, 보증금지·보증제한=guarantee_restricted] 중 해당. 채무변제 완료 후 증빙 가능→exceptions=[\"credit_debt_repaid_with_proof\"], 채무조정합의 체결→[\"debt_adjustment_agreement\"], 법원 회생·변제계획 인가→[\"court_plan_approved\"], 파산 면책결정 확정→[\"bankruptcy_discharge_confirmed\"], 변제 정상이행 예외→[\"repayment_plan_in_good_standing\"], 시효소멸 예외→[\"statute_expired\"], 재창업자금 지원 예외→[\"restart_funding_recipient\"], 재도전기업주 재기지원보증 예외→[\"retry_guarantee_recipient\"].",
  "- 제재·참여제한: dimension=sanction, operator=in, kind=exclusion, value.flags=[참여제한=participation_restricted, 명시적 부정수급=subsidy_fraud, 보조금법위반·특수관계=subsidy_law_violation, 의무불이행=obligation_breach, 임금체불명단=wage_arrears_listed, 중대재해명단=serious_accident_listed, 협약·계약위반=agreement_breach] 중 해당.",
  DEEP_ANALYSIS_UNRESOLVED_REFUND_RULE,
  "- 재무건전성: dimension=financial_health, kind=exclusion, value.debt_ratio_pct_threshold={\"value\":숫자,\"inclusive\":이상=true/초과=false}, value.impairment_excluded=[\"partial\"|\"full\"](자본잠식만 언급 시 [\"partial\",\"full\"]), value.min_interest_coverage=숫자.",
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  "- 고용보험·피보험자: dimension=insured_workforce, value.employment_insurance_required=true / min_insured·max_insured 숫자 / no_layoff_within_months 숫자.",
  "- 투자유치 하한(이상): 기간·기관유형·형태 같은 추가 전제가 없는 단순 누적총액 하한만 dimension=investment, operator=gte, value.min_total_krw(원 단위 정수)로 구조화한다. rounds / tips_operator_required도 지원한다. 'N원 미만·이하' 같은 투자유치 상한 또는 현재 value가 전제를 모두 담지 못하는 복합 조건은 dimension=investment를 유지하되 operator=text_only, value={\"note\":\"근거문장\"}로 둔다. lte와 min_total_krw를 결합하지 마라.",
  "- 배제업종(유흥주점·사행시설·암호화자산·부동산·도박 등): dimension=industry, operator=not_in, kind=exclusion, value.tags=[업종명].",
  "",
  "[수혜·참여 이력 — prior_award]",
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  "- 동일·유사 지원 수행, 동일 과제 동시참여, 본 사업 과거 선정, 당해연도 타부처 중복은 dimension=prior_award, kind=exclusion, operator=exists, value={\"scope\":\"self\",\"self_kind\":\"current_similar|same_project|same_business_prior|same_year_other_support\",\"channel\":\"general\"}.",
  "- 특정 지원사업 참여·수혜·수료 이력은 operator=in, value={\"scope\":\"program\"|\"program_type\",\"programs\":[\"사업명\"],\"states\":[\"participating\"|\"completed\"|\"graduated\"]}. 최근 N년·개월 조건은 within={\"value\":N,\"unit\":\"year\"|\"month\"}.",
  "- 범위나 사업명을 특정할 수 없으면 other/text_only exclusion 으로 남긴다.",
  "",
  ...CONFIRMATION_PROMPT_RULES,
  "",
  "[value canonical 규칙]",
  "region={regions:[시도코드],nationwide?}, biz_age={min_months?,max_months?,include_preliminary?}, industry={tags:[문자열]}, size={sizes:[정규 규모]}, revenue={min_krw?,max_krw?}, employees={min?,max?}, founder_age={ranges:[{min?,max?,label}]}, founder_trait={traits:[문자열]}, certification={certs:[문자열]}, ip={types:[문자열]}, target_type={targets:[문자열],list_semantics:\"open\"|\"closed\"}.",
  "위 canonical value 를 채울 수 없으면 빈 배열·빈 객체를 내지 말고 operator=text_only, dimension=other, value={note:근거문장} 으로 둔다.",
  "현재 사업자 상태로 판정할 수 없는 포괄적 '기타 부적합' 재량 문구는 분석 주의사항으로만 보존하고 criterion으로 만들지 마라.",
  "premises(사업장·입주공간 조건)와 export_performance(수출실적 조건)도 누락하지 않는다. 현재 matcher의 canonical 값이 열리기 전까지 이 두 축은 해당 dimension을 유지하고 operator=text_only, value={\"note\":\"근거문장\"}로 추출한다. other로 강등하지 마라.",
  "모든 criteria 는 근거 문장만 담은 source_span 이 반드시 있어야 한다. 근거를 특정할 수 없으면 그 조건은 만들지 마라.",
  "",
  "[axis_assessments — 22축 전수 검사(premises·export_performance 포함, 각 축 정확히 한 번)]",
  "status=condition_found: 입력에서 해당 축 조건을 찾았고 criteria 로도 냈다.",
  "status=inspected_no_condition: 제공된 모든 입력 블록을 검사했지만 해당 축 조건이 없다.",
  "status=ambiguous: 관련 문구는 있으나 안전하게 구조화할 수 없다.",
  "status=input_missing: 공고가 첨부나 상세문을 가리키지만 해당 내용이 입력에 없어 검사할 수 없다.",
  "inspected_no_condition 과 input_missing 을 절대 혼동하지 마라. comment 에는 판단 근거를 짧게 남겨라.",
  "",
  "[taxonomy_proposals — 22축에 담기지 않는 반복 요건의 신규 축 제안]",
  "기존 축 어디에도 자연스럽게 들어가지 않는 요건 유형이 보이면 proposed_dimension(영문 snake_case), rationale(한국어 근거), example_span(원문 인용)으로 제안한다. 없으면 빈 배열.",
].join("\n");

// ── 공용 유틸 ─────────────────────────────────────────────────────

function stringEnum<T extends readonly string[]>(value: unknown, options: T): T[number] | null {
  if (typeof value !== "string") return null;
  return (options as readonly string[]).includes(value) ? value as T[number] : null;
}

function boundedConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function normalizeCriterionValue(input: {
  rawValue: unknown;
  dimension: CriterionDimension;
  kind: DeepAnalysisCriterionKind;
  operator: string;
  sourceSpan: string | null;
  spanVerified: boolean;
  note: string | null;
  inputText: string;
}): Record<string, unknown> {
  const value = isRecord(input.rawValue) ? { ...input.rawValue } : {};
  if (
    input.dimension !== "target_type"
    || input.kind !== "required"
    || input.operator !== "in"
    || !input.spanVerified
    || !input.sourceSpan
  ) {
    return value;
  }
  const targets = stringArray(value.targets);
  const normalizedSpan = normalizeEvidence(input.sourceSpan);
  if (
    targets.length === 0
    || !targets.every((target) => normalizedSpan.includes(normalizeEvidence(target)))
  ) {
    return value;
  }
  return {
    ...value,
    list_semantics: hasOpenTargetTypeListMarker(normalizedSpan)
      || hasDelegatedOpenTargetTypeEvidence({
        sourceSpan: normalizedSpan,
        note: input.note,
        inputText: input.inputText,
      })
      ? "open"
      : "closed",
  };
}

/**
 * K-Startup 통합공고의 신청대상 요약은 표면상 유한 목록이지만, 바로 이어지는
 * 상세 문구가 자격을 각 하위 공고에 위임한다. 모델이 이 위임을 근거로 open이라고
 * 명시한 경우 source_span 한 줄만 보고 closed로 되돌리지 않는다. note만으로는
 * 신뢰하지 않고 봉인 입력의 위임 문구와 요약 source를 함께 요구한다.
 */
function hasDelegatedOpenTargetTypeEvidence(input: {
  sourceSpan: string;
  note: string | null;
  inputText: string;
}): boolean {
  if (!/신청대상\s*요약/.test(input.sourceSpan)) return false;
  if (!input.note || !/(?:open|열린|완전열거가\s*아닌)\s*목록/i.test(input.note)) return false;
  const normalizedInput = normalizeEvidence(input.inputText);
  return /신청대상\s*상세\s*:\s*각\s*지원사업\s*모집\s*공고문\s*참고/.test(normalizedInput);
}

function hasOpenTargetTypeListMarker(sourceSpan: string): boolean {
  return /(?:^|[\s,·/])등(?:은|는|이|가|을|를|의|과|도|으로)?(?:$|[\s,.)])/.test(sourceSpan)
    || /예\s*:|예시|예컨대|일례/.test(sourceSpan)
    || /포함하되\s*이에\s*한정되지/.test(sourceSpan)
    || /포함(?:한|하는|하며|하고)/.test(sourceSpan)
    || /(?:주로|대표적으로|중심으로)/.test(sourceSpan);
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeEvidence(value: string): string {
  return normalizeEvidenceWithOffsets(value).text;
}

function normalizeEvidenceWithOffsets(
  value: string,
  decodeEscapedWhitespace = false,
): {
  text: string;
  starts: number[];
  ends: number[];
} {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  while (index < value.length) {
    if (evidenceWhitespaceWidth(value, index, decodeEscapedWhitespace) > 0) {
      const whitespaceStart = index;
      while (index < value.length) {
        const width = evidenceWhitespaceWidth(value, index, decodeEscapedWhitespace);
        if (width === 0) break;
        index += width;
      }
      if (characters.length > 0 && index < value.length) {
        characters.push(" ");
        starts.push(whitespaceStart);
        ends.push(index);
      }
      continue;
    }
    characters.push(value[index]!);
    starts.push(index);
    ends.push(index + 1);
    index += 1;
  }
  return { text: characters.join(""), starts, ends };
}

function evidenceWhitespaceWidth(
  value: string,
  index: number,
  decodeEscapedWhitespace: boolean,
): number {
  if (/\s/.test(value[index]!)) return 1;
  const htmlWhitespace = value.slice(index).match(
    /^(?:&nbsp;|&#160;|&#x0*a0;)/i,
  )?.[0];
  if (htmlWhitespace) return htmlWhitespace.length;
  if (
    decodeEscapedWhitespace
    && value[index] === "\\"
    && ["r", "n", "t"].includes(value[index + 1] ?? "")
  ) {
    return 2;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
