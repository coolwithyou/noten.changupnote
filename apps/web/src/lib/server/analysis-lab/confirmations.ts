// 공모 딥분석 실험실 — 확정 결격 질문 경량 보강 러너 코어 (dev 전용, 결과는 사이드카 파일).
// 확인 루프 Phase B-0(계획 docs/plans/2026-07-23-confirmation-loop-phase-b.md §0-1):
// 확대 실험의 기존 30건은 v2 런이라 confirmation(자가신고 확인 질문, lab-deep-v3)이 없고,
// 검수·감사 자산은 동결이라 전체 재분석은 기각됐다. 대신 **검수·감사로 확정(correct)된
// exclusion criterion 만** 대상으로 질문을 생성해 런 파일 옆 사이드카에 저장한다:
//   - 런 파일 불변 원칙 유지 — 런은 건드리지 않고 <runId>.confirmations.json 만 만든다
//     (기존 .review/.audit 사이드카 패턴). 조회 시 병합은 mergeConfirmationsIntoRun.
//   - 질문의 앵커는 감사 확정 criterion 이다(연구 문서 §4.1 — sourceSpan 특정성 유지).
//   - 판정이 아닌 카피 생성이라 감사 순환성 가드(§9) 무관 — 모델 제약 없음(기본 sonnet-5).
//   - 프롬프트 규칙·tool 스키마 조각·응답 정규화는 extractor.ts(v3 인라인 생성)의 것을
//     그대로 재사용한다(이중 관리 금지 — CONFIRMATION_PROMPT_RULES/CONFIRMATION_TOOL_SCHEMA/
//     normalizeConfirmation).
// Anthropic 호출·재조립·단가는 ai-review.ts 의 것을 재사용하되(중복 구현 금지), 이 모듈의
// 정적 import 는 가볍게 유지한다 — readLabRunWithConfirmations 가 GET run 라우트에서 쓰이므로
// ai-review(→ input.ts → R2 스토리지 체인)는 러너 실행 시점에만 동적 import 한다.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  LabCriterion,
  LabCriterionConfirmation,
  LabReview,
  LabRun,
  LabUsage,
} from "@/features/dev/analysis-lab/contract";
import type { AnthropicToolCallResult, AnthropicToolSchema } from "./ai-review";
import { DIMENSION_LABELS } from "./diff";
import { CONFIRMATION_PROMPT_RULES, CONFIRMATION_TOOL_SCHEMA, normalizeConfirmation } from "./extractor";
import type { LabAssembledInput } from "./input";
import { labRunFilePath, readLabRun } from "./run-store";

export const LAB_CONFIRMATIONS_SCHEMA = "lab-confirmations-v1";
/**
 * confirmations-v1 (2026-07-23): 보강 패스 최초판 — 생성 규칙은 lab-deep-v3 의
 * CONFIRMATION_PROMPT_RULES(extractor.ts 단일 원천)를 그대로 쓰고, 보강 모드 지시
 * (확정 exclusion 대상 한정·비해당 생략)만 덧붙인다.
 */
export const CONFIRMATIONS_PROMPT_VERSION = "confirmations-v1";
export const CONFIRMATIONS_TOOL_NAME = "emit_exclusion_confirmations";
export const CONFIRMATIONS_DEFAULT_MODEL = "claude-sonnet-5";

/** 보강 모델 해석 — 우선순위: CLI --model= > env ANALYSIS_LAB_CONFIRMATION_MODEL > 기본(sonnet-5). */
export function resolveConfirmationsModel(cliModel?: string | undefined): string {
  return cliModel?.trim() || process.env.ANALYSIS_LAB_CONFIRMATION_MODEL?.trim() || CONFIRMATIONS_DEFAULT_MODEL;
}

/** 사이드카 경로 — 런 파일(<runId>.json) 옆의 <runId>.confirmations.json. */
export function labConfirmationsFilePath(source: string, sourceId: string, runId: string): string {
  return labRunFilePath(source, sourceId, runId).replace(/\.json$/, ".confirmations.json");
}

export interface LabConfirmationsItem {
  criterionIndex: number;
  confirmation: LabCriterionConfirmation;
}

export interface LabConfirmationsFile {
  schema: typeof LAB_CONFIRMATIONS_SCHEMA;
  grantId: string;
  runId: string;
  model: string;
  promptVersion: string;
  createdAt: string;
  usage: LabUsage | null;
  costUsd: number | null;
  items: LabConfirmationsItem[];
}

// ---- 대상 선정 (순수 — 테스트 대상) --------------------------------------------------

export interface ConfirmationTarget {
  criterionIndex: number;
  criterion: LabCriterion;
}

/**
 * 질문 생성 대상 선정 — 검수(사람 review 또는 감사 병합 review)에서 verdict=correct 로
 * 확정된 criterion 중 kind=exclusion 만. v3 런이 이미 인라인 confirmation 을 가진
 * criterion 은 제외한다(보강 불필요). needs_edit/wrong/unsure 는 값 자체가 미확정이라
 * 질문의 앵커가 될 수 없다(연구 문서 §4.1 — 확정 criterion 앵커 원칙).
 */
export function selectConfirmationTargets(run: LabRun, review: LabReview): ConfirmationTarget[] {
  const targets: ConfirmationTarget[] = [];
  const seen = new Set<number>();
  for (const criterionReview of review.criterionReviews) {
    if (criterionReview.verdict !== "correct") continue;
    const index = criterionReview.criterionIndex;
    if (!Number.isInteger(index) || seen.has(index)) continue;
    const criterion = run.criteria[index];
    if (!criterion) continue; // 런 criteria 범위 밖 검수 항목 방어 — 대상 아님.
    if (criterion.kind !== "exclusion") continue;
    if (criterion.confirmation) continue; // v3 인라인 보유 — 보강 대상 아님.
    seen.add(index);
    targets.push({ criterionIndex: index, criterion });
  }
  targets.sort((a, b) => a.criterionIndex - b.criterionIndex);
  return targets;
}

// ---- 프롬프트 (extractor 규칙 공유 + 보강 모드 한정 지시) ----------------------------

export function buildConfirmationsSystemPrompt(): string {
  return [
    "너는 정부지원사업 공고의 확정된 결격(exclusion) 조건을 기업이 자가신고로 확인할 수 있는 질문으로 바꾸는 전문가다.",
    "아래는 딥분석 추출기(lab-deep-v3)의 confirmation 생성 규칙 원문이다 — 그대로 따른다.",
    "",
    ...CONFIRMATION_PROMPT_RULES,
    "",
    "[보강 모드 — 위 규칙의 적용 범위 한정]",
    "- 이번 작업은 추출이 아니라 질문 보강이다. 사용자 메시지의 [질문 생성 대상]에 지정된 criterion 만 다룬다.",
    "- 자가신고로 해소되는 항목에만 confirmation 을 생성하고, 규칙상 만들지 않는 항목(표준 플래그 결격 등)은 items 에서 생략한다.",
    "- 질문 문구는 각 criterion 의 source_span 원문 특정성을 그대로 유지한다(위 규칙의 일반화 금지 조항).",
  ].join("\n");
}

/** 대상 criterion 렌더 — 계획 명세 필드(criterionIndex·dimension·operator·value·sourceSpan)만. */
function renderTargetCriterion(target: ConfirmationTarget): string {
  return [
    `### criterion_index ${target.criterionIndex}`,
    `- dimension: ${target.criterion.dimension} (${DIMENSION_LABELS[target.criterion.dimension]})`,
    `- operator: ${target.criterion.operator}`,
    `- value: ${JSON.stringify(target.criterion.value ?? {})}`,
    `- source_span(근거 인용): ${target.criterion.sourceSpan ?? "(없음)"}`,
  ].join("\n");
}

export function buildConfirmationsUserMessage(input: LabAssembledInput, targets: ConfirmationTarget[]): string {
  return [
    "아래는 ① 공고 원문 입력 ② 검수·감사로 확정된 결격(exclusion) criteria 목록이다.",
    "규칙대로 자가신고로 해소되는 criterion 에만 confirmation 을 생성하라(나머지는 생략).",
    "",
    "[공고 원문 입력 — 질문 생성의 유일한 근거]",
    input.text,
    "",
    `[질문 생성 대상 — 확정 exclusion criteria ${targets.length}건]`,
    ...targets.map(renderTargetCriterion),
  ].join("\n");
}

// ---- tool 스키마·응답 정규화 (extractor 조각 재사용 — 응답 불신 원칙) -----------------

export function buildConfirmationsToolSchema(targetIndexes: number[]): AnthropicToolSchema {
  return {
    name: CONFIRMATIONS_TOOL_NAME,
    description: "확정 결격 criterion 별 자가신고 확인 질문을 반환한다(자가신고로 해소되지 않는 항목은 생략).",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          minItems: 0,
          maxItems: targetIndexes.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              // enum 은 빈 배열이 허용되지 않는다 — 대상 0건이면 maxItems 0 이 강제한다(ai-audit 관행).
              criterion_index:
                targetIndexes.length > 0 ? { type: "integer", enum: [...targetIndexes] } : { type: "integer" },
              // Phase A(v3 인라인)와 동일 구조 — extractor 의 스키마 조각 단일 원천.
              confirmation: CONFIRMATION_TOOL_SCHEMA,
            },
            required: ["criterion_index", "confirmation"],
          },
        },
      },
      required: ["items"],
    },
  };
}

/**
 * 응답 정규화 — 커버리지 강제는 하지 않는다(자가신고 비해당 항목은 생략이 정답).
 * 대상 인덱스 밖(런 criteria 범위 밖·비대상 criterion 포함)은 드롭, 중복은 첫 항목 유지,
 * confirmation 검증은 extractor 의 normalizeConfirmation 재사용(부적격 질문 드롭).
 */
export function normalizeConfirmationsPayload(input: unknown, targetIndexes: number[]): LabConfirmationsItem[] {
  if (!isRecord(input) || !Array.isArray(input.items)) return [];
  const allowed = new Set(targetIndexes);
  const seen = new Set<number>();
  const items: LabConfirmationsItem[] = [];
  for (const row of input.items) {
    if (!isRecord(row)) continue;
    const index = row.criterion_index;
    if (typeof index !== "number" || !Number.isInteger(index) || !allowed.has(index)) continue;
    if (seen.has(index)) continue;
    const confirmation = normalizeConfirmation(row.confirmation);
    if (!confirmation) continue;
    seen.add(index);
    items.push({ criterionIndex: index, confirmation });
  }
  items.sort((a, b) => a.criterionIndex - b.criterionIndex);
  return items;
}

// ---- 사이드카 파일 읽기·병합 ---------------------------------------------------------

/**
 * 저장본(camelCase)의 confirmation 을 extractor 검증으로 되돌려 확인한다 — 손편집·부분
 * 결함 사이드카가 조회 병합으로 흘러들지 않게 저장 형식도 같은 잣대로 불신한다.
 */
function parseStoredConfirmation(value: unknown): LabCriterionConfirmation | null {
  if (!isRecord(value)) return null;
  return normalizeConfirmation({
    prompt: value.prompt,
    options: value.options,
    answer_type: value.answerType,
    reusable: value.reusable,
    condition_key: value.conditionKey,
  });
}

/** 사이드카 관대 파싱(순수 — 테스트 대상). 형식이 깨졌으면 null, 결함 항목은 드롭. */
export function parseLabConfirmationsFile(value: unknown): LabConfirmationsFile | null {
  if (!isRecord(value)) return null;
  if (
    value.schema !== LAB_CONFIRMATIONS_SCHEMA ||
    typeof value.grantId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.model !== "string" ||
    typeof value.promptVersion !== "string" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const items: LabConfirmationsItem[] = [];
  const seen = new Set<number>();
  for (const row of value.items) {
    if (!isRecord(row)) continue;
    const index = row.criterionIndex;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || seen.has(index)) continue;
    const confirmation = parseStoredConfirmation(row.confirmation);
    if (!confirmation) continue;
    seen.add(index);
    items.push({ criterionIndex: index, confirmation });
  }
  const usage = value.usage;
  return {
    schema: LAB_CONFIRMATIONS_SCHEMA,
    grantId: value.grantId,
    runId: value.runId,
    model: value.model,
    promptVersion: value.promptVersion,
    createdAt: value.createdAt,
    usage:
      isRecord(usage) && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number"
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : null,
          }
        : null,
    costUsd: typeof value.costUsd === "number" ? value.costUsd : null,
    items,
  };
}

export async function readLabConfirmationsFile(path: string): Promise<LabConfirmationsFile | null> {
  try {
    return parseLabConfirmationsFile(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * 사이드카 병합(순수 — 테스트 대상) — 런 불변 원칙상 새 객체를 만든다.
 * 인라인(v3) confirmation 이 있으면 인라인 우선, criterionIndex 가 런 criteria 범위 밖이거나
 * 대상 exclusion 이 아니면 드롭한다(사이드카 손상·런 교체 대비 방어).
 */
export function mergeConfirmationsIntoRun(run: LabRun, sidecar: LabConfirmationsFile | null): LabRun {
  if (!sidecar || sidecar.items.length === 0) return run;
  // 짝 불일치(다른 런의 사이드카) — 병합하지 않고 원본 그대로.
  if (sidecar.runId !== run.runId || sidecar.grantId !== run.grantId) return run;
  const byIndex = new Map(sidecar.items.map((item) => [item.criterionIndex, item]));
  let merged = false;
  const criteria = run.criteria.map((criterion, index) => {
    const item = byIndex.get(index);
    if (!item) return criterion;
    if (criterion.confirmation) return criterion; // 인라인 우선.
    if (criterion.kind !== "exclusion") return criterion; // 대상 exclusion 아님 — 드롭.
    merged = true;
    return { ...criterion, confirmation: item.confirmation };
  });
  return merged ? { ...run, criteria } : run;
}

/**
 * 런 로드 + 사이드카 병합 — GET run 라우트 전용 로더. 실험실 UI(ConfirmationPreview)는
 * criteria[].confirmation 만 렌더하므로, 보강 질문을 여기서 병합해 내려주면 v2 런도
 * v3 런과 동일하게 표시된다(런 파일 자체는 불변 유지).
 */
export async function readLabRunWithConfirmations(grantId: string, runId: string): Promise<LabRun | null> {
  const run = await readLabRun(grantId, runId);
  if (!run || run.error !== null) return run;
  const sidecar = await readLabConfirmationsFile(
    labConfirmationsFilePath(run.source, run.sourceId, run.runId),
  );
  return mergeConfirmationsIntoRun(run, sidecar);
}

// ---- 메인: 한 런 질문 보강 -----------------------------------------------------------

/** LLM 의존 주입점 — 기본은 ai-review.ts(동적 import), 테스트는 페이크(실 API 호출 금지). */
export interface ConfirmationsLlmDeps {
  reassembleInput: (run: LabRun) => Promise<LabAssembledInput>;
  callModel: (options: {
    apiKey: string;
    model: string;
    system: string;
    userText: string;
    toolSchema: AnthropicToolSchema;
  }) => Promise<AnthropicToolCallResult>;
  computeCostUsd: (model: string, usage: LabUsage | null) => number | null;
}

/** ai-review 체인(input.ts → R2)은 실행 시점에만 로드한다 — 모듈 상단 주석의 경량 원칙. */
async function loadDefaultLlmDeps(): Promise<ConfirmationsLlmDeps> {
  const aiReview = await import("./ai-review");
  return {
    reassembleInput: aiReview.reassembleLabInputForRun,
    callModel: aiReview.callAnthropicToolModel,
    computeCostUsd: aiReview.computeAiReviewCostUsd,
  };
}

export type ConfirmationsOutcome =
  | {
      status: "created";
      file: LabConfirmationsFile;
      path: string;
      /** 확정 exclusion 대상 수 — 생성 수와의 차이가 "자가신고 비해당 생략" 분이다. */
      targetCount: number;
      generatedCount: number;
      durationMs: number;
    }
  /** 기존 사이드카 존재 — --force 없이는 재생성하지 않는다(멱등). */
  | { status: "exists"; path: string }
  /** 확정 exclusion 대상이 없다(정상 — LLM 호출 없음). */
  | { status: "no_targets" }
  /** 재조립 입력이 run.inputSha256 과 다름 — 다른 원문에 대한 질문은 무의미하므로 스킵. */
  | { status: "input_drift"; expectedSha256: string; actualSha256: string }
  /** 모델이 생성을 거부(stop_reason=refusal) — 기록 없이 스킵, 재시도 무의미. */
  | { status: "refusal" };

export async function runConfirmations(options: {
  run: LabRun;
  review: LabReview;
  model: string;
  apiKey: string;
  /** 저장 경로 — CLI 는 labConfirmationsFilePath, 테스트는 임시 경로를 준다. */
  sidecarPath: string;
  /** true 면 기존 사이드카를 덮어쓴다. 기본은 존재 시 스킵. */
  force?: boolean;
  /** 테스트 주입용 — 생략 시 ai-review 동적 로드. */
  deps?: ConfirmationsLlmDeps;
}): Promise<ConfirmationsOutcome> {
  const { run, review, model } = options;
  if (run.error !== null) {
    throw new Error(`실패한 런은 보강 대상이 아닙니다: ${run.runId}`);
  }
  if (run.runId !== review.runId || run.grantId !== review.grantId) {
    throw new Error(
      `보강 대상 불일치: run ${run.grantId}/${run.runId} vs review ${review.grantId}/${review.runId}`,
    );
  }

  if (!options.force && existsSync(options.sidecarPath)) {
    return { status: "exists", path: options.sidecarPath };
  }

  const targets = selectConfirmationTargets(run, review);
  if (targets.length === 0) return { status: "no_targets" };
  const targetIndexes = targets.map((target) => target.criterionIndex);

  const deps = options.deps ?? (await loadDefaultLlmDeps());

  // ── 입력 재조립·무결성(ai-review 동형): sha 불일치면 원문 드리프트 — 정직하게 스킵.
  const input = await deps.reassembleInput(run);
  if (input.inputSha256 !== run.inputSha256) {
    return { status: "input_drift", expectedSha256: run.inputSha256, actualSha256: input.inputSha256 };
  }

  const startedMs = Date.now();
  const result = await deps.callModel({
    apiKey: options.apiKey,
    model,
    system: buildConfirmationsSystemPrompt(),
    userText: buildConfirmationsUserMessage(input, targets),
    toolSchema: buildConfirmationsToolSchema(targetIndexes),
  });
  if (result.kind === "refusal") return { status: "refusal" };
  const items = normalizeConfirmationsPayload(result.input, targetIndexes);

  // 생성 0건도 기록한다 — "시도했으나 전건 자가신고 비해당"과 "미시도"를 구분해야
  // 재실행 스킵 판정(기존 파일 있으면 스킵)이 성립한다.
  const file: LabConfirmationsFile = {
    schema: LAB_CONFIRMATIONS_SCHEMA,
    grantId: run.grantId,
    runId: run.runId,
    model,
    promptVersion: CONFIRMATIONS_PROMPT_VERSION,
    createdAt: new Date().toISOString(),
    usage: result.usage,
    costUsd: deps.computeCostUsd(model, result.usage),
    items,
  };

  await mkdir(dirname(options.sidecarPath), { recursive: true });
  // 불변("wx") 쓰기 — 존재하면 실패. --force 만 덮어쓰기 허용(ai-review 저장 관행).
  await writeFile(options.sidecarPath, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
  });
  return {
    status: "created",
    file,
    path: options.sidecarPath,
    targetCount: targets.length,
    generatedCount: items.length,
    durationMs: Date.now() - startedMs,
  };
}

// ---- 공용 유틸 (extractor 동형 — 비export 사본) --------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
