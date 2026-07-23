// 공모 딥분석 실험실 — AI 블라인드 감사 러너 코어 (dev 전용, DB read-only, 결과는 감사 파일 병합).
// §9 완화 개정(2026-07-23 사용자 승인): "사람 표본 감사"를 AI 2차 판정으로 자동화한다 —
// 단, 순환성 가드는 유지한다:
//   1. 감사 모델 === 추출 모델(run.model) 이면 즉시 throw (자기 채점 순환 차단).
//   2. 감사 모델 === AI 검수 모델(audit.model) 이면 즉시 throw (자기 확인 순환 차단).
//   3. 일치(concur)만 자동 확정 — 불일치·unsure 는 사람 큐에 남는다(isAiAuditConcur,
//      contract.ts 단일 원천). 사람 review.json 은 절대 건드리지 않는다.
//
// [블라인드 원칙 — ai-review.ts 상단 금지 목록 승계 + 감사 고유 금지 1건]
//   - 기존 AI 검수의 aiVerdict/aiNote(감사 파일의 스냅샷)는 프롬프트에 **절대 넣지 않는다**
//     — 2차 판정이 1차 판정에 앵커링되면 감사가 무의미해진다.
//   - 허용 입력은 ai-review 와 동일 3종: ① assembleLabInput 재조립 원문(inputSha256 검증)
//     ② run.criteria(인덱스+dimension/kind/operator/value/sourceSpan/note — confidence 등 제외)
//     ③ 빈 축 목록. 여기에 [판정 대상](감사 항목의 인덱스·축 지정)만 추가된다.
//   - 전체 criteria·빈 축 목록은 참고 컨텍스트로 제공한다 — §2 "빈 축 중복 배제"(다른 축
//     criterion 으로 포착된 조건) 판정에 전체 목록이 필요하기 때문이다.
//
// Anthropic 호출·재시도·가격표·rubric 추출은 ai-review.ts 의 것을 재사용한다(중복 구현 금지).
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";
import type {
  LabAudit,
  LabAuditItem,
  LabCriterionVerdict,
  LabEmptyAxisVerdict,
  LabRun,
  LabUsage,
} from "@/features/dev/analysis-lab/contract";
import type { AiAxisReview, AiCriterionReview } from "./ai-review-compare";
import {
  buildSystemPrompt,
  callAnthropicToolModel,
  computeAiReviewCostUsd,
  deriveEmptyAxes,
  loadGuideRubric,
  reassembleLabInputForRun,
  renderCriterionForPrompt,
  type AnthropicToolSchema,
} from "./ai-review";
import { saveLabAuditAiJudgments, type LabAuditAiJudgment } from "./audit-store";
import { DIMENSION_LABELS } from "./diff";
import type { LabAssembledInput } from "./input";

/**
 * ai-audit-v1 (2026-07-23): §9 완화 개정 최초판 — ai-review-v2 시스템 프롬프트(동결 가이드
 * rubric + 판정 지시)를 그대로 공유하고, 감사 모드 지시(판정 대상 한정)만 덧붙인다.
 */
export const AI_AUDIT_PROMPT_VERSION = "ai-audit-v1";
export const AI_AUDIT_TOOL_NAME = "emit_deep_analysis_audit";
export const AI_AUDIT_DEFAULT_MODEL = "claude-sonnet-5";

const CRITERION_VERDICTS: readonly LabCriterionVerdict[] = ["correct", "needs_edit", "wrong", "unsure"];
const AXIS_VERDICTS: readonly LabEmptyAxisVerdict[] = ["confirmed_absent", "missed_condition"];

/** 감사 모델 해석 — 우선순위: CLI --model= > env ANALYSIS_LAB_AUDIT_MODEL > 기본(sonnet-5). */
export function resolveAiAuditModel(cliModel?: string | undefined): string {
  return cliModel?.trim() || process.env.ANALYSIS_LAB_AUDIT_MODEL?.trim() || AI_AUDIT_DEFAULT_MODEL;
}

/**
 * 판정 대기 항목 선정 — humanVerdict 없는 항목 중 aiAudit 미기록분(force 면 기록분도 재판정).
 * humanVerdict 보유 항목은 어떤 경우에도 대상이 아니다(사람 판정 우선 — 저장측도 스킵).
 */
export function selectPendingAuditItems(audit: LabAudit, force = false): LabAuditItem[] {
  return audit.items.filter(
    (item) =>
      item.humanVerdict === null &&
      (force || item.aiAuditVerdict === undefined || item.aiAuditVerdict === null),
  );
}

// ---- 프롬프트 (ai-review 프레이밍 공유 + 감사 모드 한정 지시) -----------------------

export function buildAiAuditSystemPrompt(rubric: string): string {
  return [
    buildSystemPrompt(rubric),
    "",
    "[감사 모드 — 위 지시의 판정 범위 한정]",
    "- 이번 작업은 표본 감사(독립 2차 판정)다. 사용자 메시지의 [판정 대상]에 지정된",
    "  criterion 인덱스와 빈 축만 판정하라.",
    "- [판정 대상]에 없는 criteria·빈 축 목록은 대조·중복 배제(빈 축 중복 배제 규칙 등)를",
    "  위한 참고 컨텍스트다 — 판정 결과에 포함하지 마라.",
  ].join("\n");
}

export function buildAiAuditUserMessage(
  input: LabAssembledInput,
  run: LabRun,
  emptyAxes: CriterionDimension[],
  targetIndexes: number[],
  targetAxes: CriterionDimension[],
): string {
  return [
    "아래는 ① 공고 원문 입력 ② 다른 모델이 추출한 criteria 전체(참고) ③ 빈 축 전체 목록(참고)",
    "④ 판정 대상이다. 기준서대로 [판정 대상]의 criterion 인덱스와 빈 축만 판정하라.",
    "",
    "[공고 원문 입력 — 판정의 유일한 근거]",
    input.text,
    "",
    `[참고 — 추출된 criteria ${run.criteria.length}건 전체 (criterion_index 0~${Math.max(0, run.criteria.length - 1)})]`,
    ...run.criteria.map((criterion, index) => renderCriterionForPrompt(index, criterion)),
    "",
    `[참고 — 빈 축 ${emptyAxes.length}축 전체]`,
    ...emptyAxes.map((dimension) => `- ${dimension} (${DIMENSION_LABELS[dimension]})`),
    "",
    `[판정 대상 — 이것만 판정하라]`,
    `- criterion 인덱스 ${targetIndexes.length}건: ${targetIndexes.length > 0 ? targetIndexes.join(", ") : "(없음)"}`,
    `- 빈 축 ${targetAxes.length}축: ${
      targetAxes.length > 0
        ? targetAxes.map((dimension) => `${dimension}(${DIMENSION_LABELS[dimension]})`).join(", ")
        : "(없음)"
    }`,
  ].join("\n");
}

// ---- tool 스키마·응답 검증 (ai-review 동형 — 대상 부분집합 강제) ---------------------

export function buildAiAuditToolSchema(
  targetIndexes: number[],
  targetAxes: CriterionDimension[],
): AnthropicToolSchema {
  return {
    name: AI_AUDIT_TOOL_NAME,
    description: "감사 대상 criterion·빈 축의 독립 재판정 결과를 반환한다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        criterion_reviews: {
          type: "array",
          minItems: targetIndexes.length,
          maxItems: targetIndexes.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              // enum 은 빈 배열이 허용되지 않는다 — 대상 0건이면 min/maxItems 0 이 강제한다.
              criterion_index:
                targetIndexes.length > 0 ? { type: "integer", enum: [...targetIndexes] } : { type: "integer" },
              verdict: { type: "string", enum: [...CRITERION_VERDICTS] },
              note: { type: "string", description: "correct 가 아니면 필수 — 무엇을 어떻게 고칠지/원문 근거" },
            },
            required: ["criterion_index", "verdict"],
          },
        },
        axis_reviews: {
          type: "array",
          minItems: targetAxes.length,
          maxItems: targetAxes.length,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: targetAxes.length > 0 ? { type: "string", enum: [...targetAxes] } : { type: "string" },
              verdict: { type: "string", enum: [...AXIS_VERDICTS] },
              note: { type: "string", description: "missed_condition 이면 필수 — 누락 요건의 원문 문구 인용" },
            },
            required: ["dimension", "verdict"],
          },
        },
      },
      required: ["criterion_reviews", "axis_reviews"],
    },
  };
}

export type AiAuditPayloadCheck =
  | { ok: true; criterionReviews: AiCriterionReview[]; axisReviews: AiAxisReview[] }
  | { ok: false; reason: string };

/** 응답 불신 원칙(ai-review 동형) — 대상 부분집합을 정확히 한 번씩 커버해야 통과. */
export function validateAiAuditPayload(
  input: unknown,
  targetIndexes: number[],
  targetAxes: CriterionDimension[],
): AiAuditPayloadCheck {
  if (!isRecord(input)) return { ok: false, reason: "tool 입력이 객체가 아님" };
  const rawCriteria = input.criterion_reviews;
  const rawAxes = input.axis_reviews;
  if (!Array.isArray(rawCriteria) || !Array.isArray(rawAxes)) {
    return { ok: false, reason: "criterion_reviews/axis_reviews 배열 누락" };
  }

  const allowedIndexes = new Set(targetIndexes);
  const criterionReviews: AiCriterionReview[] = [];
  const seenIndexes = new Set<number>();
  for (const row of rawCriteria) {
    if (!isRecord(row)) return { ok: false, reason: "criterion_reviews 항목이 객체가 아님" };
    const index = row.criterion_index;
    if (typeof index !== "number" || !Number.isInteger(index) || !allowedIndexes.has(index)) {
      return { ok: false, reason: `판정 대상 밖 criterion_index: ${String(index)}` };
    }
    if (seenIndexes.has(index)) return { ok: false, reason: `criterion_index ${index} 중복` };
    seenIndexes.add(index);
    const verdict = row.verdict;
    if (typeof verdict !== "string" || !(CRITERION_VERDICTS as readonly string[]).includes(verdict)) {
      return { ok: false, reason: `criterion verdict 어휘 밖: ${String(verdict)}` };
    }
    const note = cleanString(row.note);
    if (verdict !== "correct" && !note) {
      return { ok: false, reason: `criterion_index ${index}: 비-correct(${verdict}) 판정에 note 없음` };
    }
    criterionReviews.push({ criterionIndex: index, verdict: verdict as LabCriterionVerdict, note });
  }
  if (criterionReviews.length !== targetIndexes.length) {
    return { ok: false, reason: `criterion 커버리지 미달: ${criterionReviews.length}/${targetIndexes.length}` };
  }

  const allowedAxes = new Set<string>(targetAxes);
  const axisReviews: AiAxisReview[] = [];
  const seenAxes = new Set<string>();
  for (const row of rawAxes) {
    if (!isRecord(row)) return { ok: false, reason: "axis_reviews 항목이 객체가 아님" };
    const dimension = row.dimension;
    if (typeof dimension !== "string" || !allowedAxes.has(dimension)) {
      return { ok: false, reason: `판정 대상 밖 dimension: ${String(dimension)}` };
    }
    if (seenAxes.has(dimension)) return { ok: false, reason: `축 ${dimension} 판정 중복` };
    seenAxes.add(dimension);
    const verdict = row.verdict;
    if (typeof verdict !== "string" || !(AXIS_VERDICTS as readonly string[]).includes(verdict)) {
      return { ok: false, reason: `빈 축 verdict 어휘 밖: ${String(verdict)}` };
    }
    const note = cleanString(row.note);
    if (verdict === "missed_condition" && !note) {
      return { ok: false, reason: `축 ${dimension}: missed_condition 판정에 원문 인용 note 없음` };
    }
    axisReviews.push({ dimension: dimension as CriterionDimension, verdict: verdict as LabEmptyAxisVerdict, note });
  }
  if (axisReviews.length !== targetAxes.length) {
    return { ok: false, reason: `빈 축 커버리지 미달: ${axisReviews.length}/${targetAxes.length}` };
  }
  criterionReviews.sort((a, b) => a.criterionIndex - b.criterionIndex);
  axisReviews.sort(
    (a, b) => CRITERION_DIMENSIONS.indexOf(a.dimension) - CRITERION_DIMENSIONS.indexOf(b.dimension),
  );
  return { ok: true, criterionReviews, axisReviews };
}

// ---- 판정 비교 (순수 — 테스트 대상) --------------------------------------------------

export interface AiAuditComparison {
  judgments: LabAuditAiJudgment[];
  /** 자체 판정 == 기존 aiVerdict 정확 일치(unsure 제외) — 자동 확정분. */
  concurCount: number;
  /** 불일치 — 사람 큐 잔류. */
  disagreeCount: number;
  /** 자체 판정 unsure — 일치 여부와 무관하게 사람 큐 잔류. */
  unsureCount: number;
}

/**
 * 감사 판정 ↔ 기존 AI 검수 판정(감사 파일 스냅샷) 비교 — missed_condition_flag 항목도
 * 같은 축 어휘(confirmed_absent/missed_condition)로 재판정되므로 동형 비교다.
 * 판정은 전건 기록하고(불일치 포함 — 사람 감사 화면의 근거), 일치 집계만 분리한다.
 */
export function compareAiAuditVerdicts(
  pendingItems: LabAuditItem[],
  criterionReviews: AiCriterionReview[],
  axisReviews: AiAxisReview[],
): AiAuditComparison {
  const byIndex = new Map(criterionReviews.map((review) => [review.criterionIndex, review]));
  const byDimension = new Map(axisReviews.map((review) => [review.dimension, review]));

  const judgments: LabAuditAiJudgment[] = [];
  let concurCount = 0;
  let disagreeCount = 0;
  let unsureCount = 0;
  for (const item of pendingItems) {
    const review =
      item.kind === "criterion" && item.criterionIndex !== undefined
        ? byIndex.get(item.criterionIndex)
        : item.kind === "axis" && item.dimension !== undefined
          ? byDimension.get(item.dimension)
          : undefined;
    if (!review) {
      // 커버리지 검증(validateAiAuditPayload)을 통과했으면 도달 불가 — 정직하게 실패한다.
      throw new Error(`감사 판정 누락: ${item.kind} ${item.criterionIndex ?? item.dimension ?? "?"}`);
    }
    judgments.push({
      kind: item.kind,
      ...(item.criterionIndex !== undefined ? { criterionIndex: item.criterionIndex } : {}),
      ...(item.dimension !== undefined ? { dimension: item.dimension } : {}),
      aiAuditVerdict: review.verdict,
      aiAuditNote: review.note,
    });
    if (review.verdict === "unsure") unsureCount += 1;
    else if (review.verdict === item.aiVerdict) concurCount += 1;
    else disagreeCount += 1;
  }
  return { judgments, concurCount, disagreeCount, unsureCount };
}

// ---- 메인: 한 감사 파일 AI 감사 ------------------------------------------------------

export type AiAuditOutcome =
  | {
      status: "audited";
      applied: number;
      skippedHuman: number;
      concurCount: number;
      disagreeCount: number;
      unsureCount: number;
      /** 병합 저장 직후의 감사 파일 — 완료 판정(isLabAuditComplete) 등 후속 집계용. */
      auditAfter: LabAudit;
      usage: LabUsage | null;
      costUsd: number | null;
      durationMs: number;
    }
  /** 판정할 항목이 없다(전건 humanVerdict 보유 또는 aiAudit 기록 완료). */
  | { status: "no_pending" }
  /** 재조립 입력이 run.inputSha256 과 다름 — 다른 텍스트에 대한 판정은 무의미하므로 스킵. */
  | { status: "input_drift"; expectedSha256: string; actualSha256: string }
  /** 모델이 판정을 거부(stop_reason=refusal) — 기록 없이 스킵, 재시도 무의미. */
  | { status: "refusal" };

export async function runAiAudit(options: {
  run: LabRun;
  audit: LabAudit;
  auditModel: string;
  apiKey: string;
  /** true 면 aiAudit 기록이 있는 항목도 재판정한다(humanVerdict 보유 항목은 불변). */
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<AiAuditOutcome> {
  const { run, audit, auditModel } = options;

  // [하드 가드 2중 — §9 유지 조항] 추출 모델·검수 모델과의 순환을 각각 차단한다.
  if (auditModel === run.model) {
    throw new Error(
      `감사 모델(${auditModel})이 추출 모델(run.model=${run.model})과 같습니다 — 자기 채점 순환 금지(§9). 다른 모델을 지정하세요.`,
    );
  }
  if (auditModel === audit.model) {
    throw new Error(
      `감사 모델(${auditModel})이 AI 검수 모델(audit.model=${audit.model})과 같습니다 — 자기 확인 순환 금지(§9). 다른 모델을 지정하세요.`,
    );
  }
  if (run.error !== null) {
    throw new Error(`실패한 런은 감사 대상이 아닙니다: ${run.runId}`);
  }
  if (run.runId !== audit.runId || run.grantId !== audit.grantId) {
    throw new Error(`감사 대상 불일치: run ${run.grantId}/${run.runId} vs audit ${audit.grantId}/${audit.runId}`);
  }

  const pending = selectPendingAuditItems(audit, options.force ?? false);
  if (pending.length === 0) return { status: "no_pending" };

  const targetIndexes = pending
    .filter((item) => item.kind === "criterion" && item.criterionIndex !== undefined)
    .map((item) => item.criterionIndex!)
    .sort((a, b) => a - b);
  const targetAxes = pending
    .filter((item) => item.kind === "axis" && item.dimension !== undefined)
    .map((item) => item.dimension!)
    .sort((a, b) => CRITERION_DIMENSIONS.indexOf(a) - CRITERION_DIMENSIONS.indexOf(b));

  // ── 입력 재조립·무결성(ai-review 동형): sha 불일치면 원문 드리프트 — 정직하게 스킵.
  const input = await reassembleLabInputForRun(run);
  if (input.inputSha256 !== run.inputSha256) {
    return { status: "input_drift", expectedSha256: run.inputSha256, actualSha256: input.inputSha256 };
  }

  const emptyAxes = deriveEmptyAxes(run);
  // 감사 축 대상은 빈 축의 부분집합이어야 한다(ai-review 가 빈 축만 판정했으므로).
  const emptySet = new Set(emptyAxes);
  for (const dimension of targetAxes) {
    if (!emptySet.has(dimension)) {
      throw new Error(`감사 축 대상 ${dimension} 이 빈 축이 아닙니다 — 감사 파일·런 정합을 확인하세요(${run.runId}).`);
    }
  }
  for (const index of targetIndexes) {
    if (index < 0 || index >= run.criteria.length) {
      throw new Error(`감사 criterion 대상 #${index} 가 런 criteria 범위 밖입니다(${run.runId}).`);
    }
  }

  const { rubric } = await loadGuideRubric();
  const system = buildAiAuditSystemPrompt(rubric);
  const userText = buildAiAuditUserMessage(input, run, emptyAxes, targetIndexes, targetAxes);
  const toolSchema = buildAiAuditToolSchema(targetIndexes, targetAxes);

  const startedMs = Date.now();
  let totalUsage: LabUsage | null = null;
  const accumulateUsage = (usage: LabUsage | null) => {
    if (!usage) return;
    totalUsage = totalUsage
      ? {
          inputTokens: totalUsage.inputTokens + usage.inputTokens,
          outputTokens: totalUsage.outputTokens + usage.outputTokens,
          cacheReadTokens: (totalUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
        }
      : usage;
  };

  // 검증 실패 시 1회 재시도 — ai-review 동형.
  let checked: AiAuditPayloadCheck | null = null;
  for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
    const result = await callAnthropicToolModel({
      apiKey: options.apiKey,
      model: auditModel,
      system,
      userText,
      toolSchema,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    accumulateUsage(result.usage);
    if (result.kind === "refusal") return { status: "refusal" };
    checked = validateAiAuditPayload(result.input, targetIndexes, targetAxes);
    if (checked.ok) break;
    if (attemptNo === 2) {
      throw new Error(`AI 감사 응답 검증 실패(재시도 후에도): ${checked.reason}`);
    }
    console.warn(`[ai-audit] 응답 검증 실패 — 1회 재시도: ${checked.reason}`);
  }
  if (!checked?.ok) throw new Error("AI 감사 응답 검증 실패(도달 불가 경로)");

  const comparison = compareAiAuditVerdicts(pending, checked.criterionReviews, checked.axisReviews);
  const saved = await saveLabAuditAiJudgments({
    grantId: run.grantId,
    runId: run.runId,
    model: audit.model,
    aiAuditModel: auditModel,
    aiAuditPromptVersion: AI_AUDIT_PROMPT_VERSION,
    judgments: comparison.judgments,
  });
  if (saved.status !== "ok") {
    throw new Error(
      `AI 감사 판정 저장 실패(${saved.status}): ${"message" in saved ? saved.message : run.runId}`,
    );
  }

  return {
    status: "audited",
    applied: saved.applied,
    skippedHuman: saved.skippedHuman,
    concurCount: comparison.concurCount,
    disagreeCount: comparison.disagreeCount,
    unsureCount: comparison.unsureCount,
    auditAfter: saved.audit,
    usage: totalUsage,
    costUsd: computeAiReviewCostUsd(auditModel, totalUsage),
    durationMs: Date.now() - startedMs,
  };
}

// ---- 공용 유틸 (ai-review 동형 — 비export 사본) --------------------------------------

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
