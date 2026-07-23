// 공모 딥분석 실험실 — Opus 딥분석 추출기 (dev 전용, DB 미기록).
// Anthropic Messages API 직접 fetch(packages/core/src/bizinfo/llm-criteria.ts 관행).
//
// [Opus 4.8 필수 규칙 — 어기면 400]
//   - temperature / top_p / top_k 를 절대 보내지 않는다(파라미터 제거됨).
//   - thinking 파라미터도 보내지 않는다(생략). budget_tokens 금지.
//
// [비용 계산 — 크레딧/metering 래퍼 사용 금지]
//   운영 원가수집(metering)과 섞이면 실험 비용이 서비스 원가로 오염되므로 여기서 직접 계산만 한다.
//   Opus 4.8 단가: input $5/1M · output $25/1M · cache_read $0.5/1M.
//
// [응답 불신 원칙 — llm-criteria.ts 동형]
//   dimension/kind enum 밖 값은 드롭, confidence 는 0~1 클램프, source_span 은 최종 입력 텍스트에
//   부분문자열로 실재하는지 서버가 검증한다(spanVerified). 결과는 파일로만 저장하고 DB에 쓰지 않는다.
import { CRITERION_DIMENSIONS, CRITERION_KINDS, CRITERION_OPERATORS } from "@cunote/contracts";
import type { CriterionDimension } from "@cunote/contracts";
import {
  ANALYSIS_LAB_DEFAULT_MODEL,
  type LabAxisAssessment,
  type LabAxisStatus,
  type LabConfirmationOption,
  type LabConfirmationReusable,
  type LabCriterion,
  type LabCriterionConfirmation,
  type LabCriterionKind,
  type LabProgramIntent,
  type LabTaxonomyProposal,
  type LabUsage,
} from "@/features/dev/analysis-lab/contract";

export const ANALYSIS_LAB_TOOL_NAME = "emit_deep_grant_analysis";

const DEFAULT_MAX_TOKENS = 12_000;
const DEFAULT_TIMEOUT_MS = 540_000;

// Opus 4.8 단가(USD / 1M tokens).
const USD_PER_INPUT_TOKEN = 5 / 1e6;
const USD_PER_OUTPUT_TOKEN = 25 / 1e6;
const USD_PER_CACHE_READ_TOKEN = 0.5 / 1e6;

// 예약 2축(premises/export_performance)은 criteria 에서 제외하는 기존 관행 유지(M4).
// axis_assessments 는 22축 전수 허용 — 예약 축도 "공고에 조건이 있는지" 관찰 자체는 수집한다.
const RESERVED_DIMENSIONS = new Set<CriterionDimension>(["premises", "export_performance"]);
const CRITERIA_EMITTABLE_DIMENSIONS = CRITERION_DIMENSIONS.filter(
  (dimension) => !RESERVED_DIMENSIONS.has(dimension),
);

export function resolveLabModel(): string {
  return process.env.ANALYSIS_LAB_MODEL?.trim() || ANALYSIS_LAB_DEFAULT_MODEL;
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

export interface DeepAnalysisResult {
  model: string;
  analysisMarkdown: string;
  programIntent: LabProgramIntent | null;
  criteria: LabCriterion[];
  axisAssessments: LabAxisAssessment[];
  taxonomyProposals: LabTaxonomyProposal[];
  usage: LabUsage | null;
  costUsd: number | null;
}

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
  fetchImpl?: typeof fetch;
}): Promise<DeepAnalysisResult> {
  const model = resolveLabModel();
  const maxTokens = resolveMaxTokens();
  const requestBody = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: DEEP_ANALYSIS_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        "아래 공고 입력(구조화 필드 + 첨부 공고문 전문)만 근거로 공고를 깊게 분석해라.",
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
  const usage = normalizeUsage(payload.usage);
  return {
    model,
    analysisMarkdown: typeof input.analysis_markdown === "string" ? input.analysis_markdown : "",
    programIntent: normalizeProgramIntent(input.program_intent),
    criteria: normalizeCriteria(input.criteria, options.inputText),
    axisAssessments: normalizeAxisAssessments(input.axis_assessments),
    taxonomyProposals: normalizeTaxonomyProposals(input.taxonomy_proposals),
    usage,
    costUsd: usage
      ? usage.inputTokens * USD_PER_INPUT_TOKEN +
        usage.outputTokens * USD_PER_OUTPUT_TOKEN +
        (usage.cacheReadTokens ?? 0) * USD_PER_CACHE_READ_TOKEN
      : null,
  };
}

// ── tool 스키마(손으로 쓴 JSON Schema — pilot/llm-criteria 스타일) ─────

/**
 * v3 confirmation tool 스키마 조각 — buildDeepAnalysisToolSchema 의 criteria[].confirmation
 * 정의이자, 경량 보강 CLI(confirmations.ts, promptVersion confirmations-v1)가 재사용하는
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
      required: ["analysis_markdown", "program_intent", "criteria", "axis_assessments", "taxonomy_proposals"],
    },
  };
}

// ── 응답 정규화(응답 불신 — DB 미기록) ─────────────────────────────

/** export 는 검증 스크립트용(런타임 사용처는 runDeepGrantAnalysis 뿐). */
export function normalizeCriteria(rows: unknown, inputText: string): LabCriterion[] {
  if (!Array.isArray(rows)) return [];
  const normalizedInput = normalizeEvidence(inputText);
  const inputLines = buildNormalizedInputLines(inputText);
  const criteria: LabCriterion[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const dimension = stringEnum(row.dimension, CRITERIA_EMITTABLE_DIMENSIONS);
    const kind = stringEnum(row.kind, CRITERION_KINDS) as LabCriterionKind | null;
    if (!dimension || !kind) continue; // enum 밖 값은 드롭.
    const operator = typeof row.operator === "string" &&
      (CRITERION_OPERATORS as readonly string[]).includes(row.operator)
      ? row.operator
      : "text_only";
    const sourceSpan = cleanString(row.source_span);
    const spanCheck = verifySpan(sourceSpan, normalizedInput, inputLines, inputText.length);
    const confirmation = normalizeConfirmation(row.confirmation);
    criteria.push({
      dimension,
      kind,
      operator,
      value: isRecord(row.value) ? row.value : {},
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
const CONFIRMATION_REUSABLES: readonly LabConfirmationReusable[] = ["company_fact", "per_notice"];

/**
 * confirmation 정규화(v3) — 응답 불신 원칙. 부분 결함은 옵션 단위로 드롭하되,
 * 질문으로 성립하지 않으면(프롬프트 없음·옵션 2~4개 밖·결격/비결격 극성 결손·reusable
 * 어휘 밖) confirmation 전체를 드롭한다 — criterion 은 유지된다(질문 없는 결격 추출).
 * export 는 검증 스크립트용.
 */
export function normalizeConfirmation(value: unknown): LabCriterionConfirmation | null {
  if (!isRecord(value)) return null;
  const prompt = cleanString(value.prompt);
  if (!prompt) return null;

  if (!Array.isArray(value.options)) return null;
  const options: LabConfirmationOption[] = [];
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

const AXIS_STATUSES: readonly LabAxisStatus[] = [
  "condition_found",
  "inspected_no_condition",
  "ambiguous",
  "input_missing",
];

function normalizeAxisAssessments(rows: unknown): LabAxisAssessment[] {
  if (!Array.isArray(rows)) return [];
  const byDimension = new Map<CriterionDimension, LabAxisAssessment>();
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

function normalizeTaxonomyProposals(rows: unknown): LabTaxonomyProposal[] {
  if (!Array.isArray(rows)) return [];
  const proposals: LabTaxonomyProposal[] = [];
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

function normalizeProgramIntent(value: unknown): LabProgramIntent | null {
  if (!isRecord(value)) return null;
  return {
    oneLiner: cleanString(value.one_liner) ?? "",
    targetProfile: cleanString(value.target_profile) ?? "",
    evaluationFocus: stringArray(value.evaluation_focus),
    benefitSummary: cleanString(value.benefit_summary) ?? "",
    cautionNotes: stringArray(value.caution_notes),
  };
}

function normalizeUsage(usage: Record<string, unknown> | undefined): LabUsage | null {
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
 * 조인 결과 불변)이자, 경량 보강 CLI(confirmations.ts, promptVersion confirmations-v1)가
 * 그대로 공유하는 단일 원천이다(이중 관리 금지). 문구 수정은 곧 프롬프트 개정이다 —
 * 양쪽 promptVersion 을 함께 재고할 것.
 */
export const CONFIRMATION_PROMPT_RULES = [
  "[confirmation — 자가신고 확인 질문(결격 전용)]",
  "kind=exclusion 인 criterion 중 소싱 가능한 기업 데이터로 충족 여부를 판정할 수 없고 기업의 자가신고로만 해소되는 항목에는 confirmation 객체를 함께 생성한다.",
  "대상 예: prior_award 의 수혜·참여 이력 조건, other/text_only 의 절차·자격 조건. tax_compliance/credit_status/sanction 의 표준 플래그 결격에는 만들지 않는다(공용 확인 절차가 따로 있다). 표준 플래그로 담기지 않는 특수 조건이면 예외로 생성한다.",
  "prompt 는 source_span 원문의 특정성을 그대로 유지한 존댓말 객관식 질문 문장으로 쓴다. canonical 값 기준으로 일반화하지 마라. 예: 원문이 '타 정부지원사업에서 체계적합성시험비를 기 지원받은 경우'라면 '다른 정부지원사업에서 체계적합성시험비를 지원받은 적이 있나요?' 로 묻는다 — '올해 다른 지원사업 수혜를 받은 적이 있나요?' 같은 일반화 금지.",
  "options 는 2~4개. value 는 영문 snake_case, label 은 한국어. 결격에 해당하는 선택지는 disqualifies=true 로 표시하고, disqualifies true/false 선택지가 각각 최소 1개씩 있어야 한다. '잘 모르겠어요' 선택지는 만들지 마라(확인 UI가 공통 제공한다).",
  "reusable: 답이 이 공고와 무관하게 성립하는 기업의 사실(특정 항목 수혜 이력, 사업 참여 이력 등)이면 company_fact, 이 공고에서만 유효한 선언(서류 허위 없음, 주관기업으로 참여 등)이면 per_notice.",
  "company_fact 이면 condition_key 에 그 사실을 식별하는 안정적인 영문 snake_case 키를 쓴다(예: prior_award_system_conformity_test_fee). per_notice 면 condition_key 를 생략한다.",
];

const DEEP_ANALYSIS_SYSTEM_PROMPT = [
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
  "[criteria — 22축 자격조건 분해(예약 2축 제외 20축)]",
  "필수조건은 required, 제외대상은 exclusion, 우대조건은 preferred 로 분리한다.",
  "지역 코드는 한국 시도 행정코드 2자리(서울 11, 부산 26, 대구 27, 인천 28, 광주 29, 대전 30, 울산 31, 세종 36, 경기 41, 강원 42, 충북 43, 충남 44, 전북 45, 전남 46, 경북 47, 경남 48, 제주 50)를 사용한다.",
  "규모 값은 예비, 소상공인, 소기업, 중소기업, 중견기업, 대기업 중에서만 사용한다.",
  "업종은 dimension=industry 의 value.tags 배열에 짧은 한국어 정책 태그로 추출한다. 모호하면 text_only 로 남긴다.",
  "휴폐업 제외는 dimension=business_status, operator=not_in, kind=exclusion, value={\"statuses\":[\"closed\"],\"labels\":[\"휴폐업\"]} 로 추출한다.",
  "",
  "[결격(배제) 조건 canonical 매핑 — 반드시 아래 축으로 분해한다]",
  "- 세금·공과금 체납: dimension=tax_compliance, operator=in, kind=exclusion, value.flags=[국세=national_tax_delinquent, 지방세=local_tax_delinquent, 관세=customs_delinquent, 4대보험료=social_insurance_delinquent] 중 해당. 납부기한 연장·징수유예 예외 문구가 있으면 value.exceptions=[\"payment_deferral_approved\"].",
  "- 신용·금융 상태: dimension=credit_status, operator=in, kind=exclusion, value.flags=[연체=credit_delinquency, 채무불이행=loan_default, 부도=bond_default, 회생·개인회생=rehabilitation_in_progress, 파산=bankruptcy_filed, 법정관리·청산=court_receivership, 금융질서문란=financial_misconduct, 압류=asset_seizure, 보증금지·보증제한=guarantee_restricted] 중 해당. 변제 정상이행 예외→exceptions=[\"repayment_plan_in_good_standing\"], 시효소멸 예외→[\"statute_expired\"].",
  "- 제재·참여제한: dimension=sanction, operator=in, kind=exclusion, value.flags=[참여제한=participation_restricted, 부정수급·환수=subsidy_fraud, 보조금법위반·특수관계=subsidy_law_violation, 의무불이행=obligation_breach, 임금체불명단=wage_arrears_listed, 중대재해명단=serious_accident_listed, 협약·계약위반=agreement_breach] 중 해당.",
  "- 재무건전성: dimension=financial_health, kind=exclusion, value.debt_ratio_pct_threshold={\"value\":숫자,\"inclusive\":이상=true/초과=false}, value.impairment_excluded=[\"partial\"|\"full\"](자본잠식만 언급 시 [\"partial\",\"full\"]), value.min_interest_coverage=숫자.",
  "- 고용보험·피보험자: dimension=insured_workforce, value.employment_insurance_required=true / min_insured·max_insured 숫자 / no_layoff_within_months 숫자.",
  "- 투자유치: dimension=investment, value.min_total_krw(원 단위 정수) / rounds / tips_operator_required.",
  "- 배제업종(유흥주점·사행시설·암호화자산·부동산·도박 등): dimension=industry, operator=not_in, kind=exclusion, value.tags=[업종명].",
  "",
  "[수혜·참여 이력 — prior_award]",
  "- 동일·유사 지원 수행, 동일 과제 동시참여, 본 사업 과거 선정, 당해연도 타부처 중복은 dimension=prior_award, kind=exclusion, operator=exists, value={\"scope\":\"self\",\"self_kind\":\"current_similar|same_project|same_business_prior|same_year_other_support\",\"channel\":\"general\"}.",
  "- 특정 지원사업 참여·수혜·수료 이력은 operator=in, value={\"scope\":\"program\"|\"program_type\",\"programs\":[\"사업명\"],\"states\":[\"participating\"|\"completed\"|\"graduated\"]}. 최근 N년·개월 조건은 within={\"value\":N,\"unit\":\"year\"|\"month\"}.",
  "- 범위나 사업명을 특정할 수 없으면 other/text_only exclusion 으로 남긴다.",
  "",
  ...CONFIRMATION_PROMPT_RULES,
  "",
  "[value canonical 규칙]",
  "region={regions:[시도코드],nationwide?}, biz_age={min_months?,max_months?,include_preliminary?}, industry={tags:[문자열]}, size={sizes:[정규 규모]}, revenue={min_krw?,max_krw?}, employees={min?,max?}, founder_age={ranges:[{min?,max?,label}]}, founder_trait={traits:[문자열]}, certification={certs:[문자열]}, ip={types:[문자열]}, target_type={targets:[문자열]}.",
  "위 canonical value 를 채울 수 없으면 빈 배열·빈 객체를 내지 말고 operator=text_only, dimension=other, value={note:근거문장} 으로 둔다.",
  "서류 허위·미제출·표절·기타 부적합 같은 절차·재량 조건은 other/text_only exclusion 으로 둔다.",
  "premises 와 export_performance 는 예약 축이므로 criteria 에는 내지 않는다(axis_assessments 에서는 검사한다).",
  "모든 criteria 는 근거 문장만 담은 source_span 이 반드시 있어야 한다. 근거를 특정할 수 없으면 그 조건은 만들지 마라.",
  "",
  "[axis_assessments — 22축 전수 검사(premises·export_performance 포함, 각 축 정확히 한 번)]",
  "status=condition_found: 입력에서 해당 축 조건을 찾았다(criteria 로도 냈다 — 예약 2축은 제외).",
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
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
