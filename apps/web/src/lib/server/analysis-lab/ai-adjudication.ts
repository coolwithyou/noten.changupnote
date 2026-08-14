// 로컬 구독 전용 3차 판정: Fable 검수와 Sonnet 블라인드 감사가 충돌한 항목만
// Opus가 원문과 두 판정 근거를 다시 대조해 종결한다. 사람 판정 필드는 사용하지 않는다.
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";
import {
  isAiAdjudicationResolved,
  isAiAuditConcur,
  type LabAudit,
  type LabAuditItem,
  type LabMissedConditionImpact,
  type LabRun,
  type LabUsage,
} from "@/features/dev/analysis-lab/contract";
import {
  buildAiAuditSystemPrompt,
  buildAiAuditToolSchema,
  buildAiAuditUserMessage,
  validateAiAuditPayload,
} from "./ai-audit";
import {
  callAnthropicToolModel,
  computeAiReviewCostUsd,
  deriveEmptyAxes,
  loadGuideRubric,
  reassembleLabInputForRun,
} from "./ai-review";
import {
  saveLabAuditAiAdjudication,
  type LabAuditAiAdjudicationJudgment,
} from "./audit-store";
import { isPublishableLabRun } from "./run-outcome";

export const AI_ADJUDICATION_PROMPT_VERSION = "ai-adjudication-v1";
export const AI_ADJUDICATION_DEFAULT_MODEL = "claude-opus-5";

export function selectPendingAdjudicationItems(audit: LabAudit): LabAuditItem[] {
  return audit.items.filter((item) =>
    item.humanVerdict === null
    && item.aiAuditVerdict !== undefined
    && item.aiAuditVerdict !== null
    && !isAiAuditConcur(item)
    && !isAiAdjudicationResolved(item));
}

export function buildAiAdjudicationSystemPrompt(rubric: string): string {
  return [
    buildAiAuditSystemPrompt(rubric),
    "",
    "[3차 최종 판정 모드]",
    "- 1차 검수와 2차 블라인드 감사가 충돌한 항목만 판정한다.",
    "- 다수결이나 기존 모델의 권위가 아니라 봉인 원문과 매칭 계약을 기준으로 독립 결론을 낸다.",
    "- criterion은 correct, needs_edit, wrong 중 하나로 반드시 종결한다. unsure는 허용하지 않는다.",
    "- 빈 축은 confirmed_absent 또는 missed_condition으로 종결하고, 누락이면 eligibility/ranking 영향도를 확정한다.",
    "- 각 판정 note에는 어느 해석이 왜 원문·기계 판정 계약에 맞는지 구체적으로 적는다.",
  ].join("\n");
}

export function renderAdjudicationConflictContext(items: LabAuditItem[]): string {
  return [
    "[충돌한 두 독립 판정 — 정답이 아니라 대조할 주장]",
    ...items.map((item) => {
      const key = item.kind === "criterion" ? `criterion #${item.criterionIndex}` : `axis ${item.dimension}`;
      return [
        `- ${key}`,
        `  1차 검수: ${item.aiVerdict}${item.aiMatchImpact ? ` (${item.aiMatchImpact})` : ""}`,
        `  1차 근거: ${item.aiNote ?? "(없음)"}`,
        `  2차 감사: ${item.aiAuditVerdict}${item.aiAuditMatchImpact ? ` (${item.aiAuditMatchImpact})` : ""}`,
        `  2차 근거: ${item.aiAuditNote ?? "(없음)"}`,
      ].join("\n");
    }),
  ].join("\n");
}

export function buildAdjudicationJudgments(
  items: LabAuditItem[],
  payload: ReturnType<typeof validateAiAuditPayload>,
): LabAuditAiAdjudicationJudgment[] {
  if (!payload.ok) throw new Error(`3차 판정 응답 검증 실패: ${payload.reason}`);
  if (payload.criterionReviews.some((item) => item.verdict === "unsure")) {
    throw new Error("3차 판정은 criterion unsure로 종결할 수 없습니다.");
  }
  const itemKeys = new Set(items.map((item) =>
    item.kind === "criterion" ? `c:${item.criterionIndex}` : `a:${item.dimension}`));
  return [
    ...payload.criterionReviews.map((item): LabAuditAiAdjudicationJudgment => ({
      kind: "criterion",
      criterionIndex: item.criterionIndex,
      verdict: item.verdict,
      note: item.note ?? "봉인 원문과 매칭 계약을 대조해 최종 판정함.",
    })),
    ...payload.axisReviews.map((item): LabAuditAiAdjudicationJudgment => ({
      kind: "axis",
      dimension: item.dimension,
      verdict: item.verdict,
      note: item.note ?? "봉인 원문과 매칭 계약을 대조해 최종 판정함.",
      matchImpact: item.matchImpact ?? null,
    })),
  ].filter((item) => itemKeys.has(item.kind === "criterion" ? `c:${item.criterionIndex}` : `a:${item.dimension}`));
}

export type AiAdjudicationOutcome =
  | { status: "no_pending" }
  | { status: "input_drift"; expectedSha256: string; actualSha256: string }
  | { status: "refusal" }
  | {
      status: "adjudicated";
      applied: number;
      auditAfter: LabAudit;
      usage: LabUsage | null;
      costUsd: number | null;
      durationMs: number;
    };

export async function runAiAdjudication(options: {
  run: LabRun;
  audit: LabAudit;
  model?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  transport: "api" | "claude-cli";
}): Promise<AiAdjudicationOutcome> {
  const model = options.model ?? AI_ADJUDICATION_DEFAULT_MODEL;
  if (options.transport !== "claude-cli") {
    throw new Error("3차 판정은 추가 API 비용을 만들지 않도록 로컬 claude-cli 구독 전송만 허용합니다.");
  }
  if (model === options.audit.model || model === options.audit.aiAuditModel) {
    throw new Error(`3차 판정 모델(${model})은 1차 검수·2차 감사 모델과 달라야 합니다.`);
  }
  if (!isPublishableLabRun(options.run)) {
    throw new Error(`발행 가능한 런이 아닙니다 — 3차 판정 대상에서 제외합니다: ${options.run.runId}`);
  }
  if (options.run.runId !== options.audit.runId || options.run.grantId !== options.audit.grantId) {
    throw new Error("3차 판정의 런과 감사 파일이 일치하지 않습니다.");
  }
  const pending = selectPendingAdjudicationItems(options.audit);
  if (pending.length === 0) return { status: "no_pending" };

  const assembled = await reassembleLabInputForRun(options.run);
  if (assembled.inputSha256 !== options.run.inputSha256) {
    return { status: "input_drift", expectedSha256: options.run.inputSha256, actualSha256: assembled.inputSha256 };
  }
  const emptyAxes = deriveEmptyAxes(options.run);
  const targetIndexes = pending
    .filter((item) => item.kind === "criterion" && item.criterionIndex !== undefined)
    .map((item) => item.criterionIndex!)
    .sort((a, b) => a - b);
  const targetAxes = pending
    .filter((item) => item.kind === "axis" && item.dimension !== undefined)
    .map((item) => item.dimension!)
    .sort((a, b) => CRITERION_DIMENSIONS.indexOf(a) - CRITERION_DIMENSIONS.indexOf(b));
  validateTargets(options.run, emptyAxes, targetIndexes, targetAxes);

  const { rubric } = await loadGuideRubric();
  const system = buildAiAdjudicationSystemPrompt(rubric);
  const userText = [
    buildAiAuditUserMessage(assembled, options.run, emptyAxes, targetIndexes, targetAxes),
    "",
    renderAdjudicationConflictContext(pending),
  ].join("\n");
  const toolSchema = buildAiAuditToolSchema(targetIndexes, targetAxes);
  const startedMs = Date.now();
  let usage: LabUsage | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await callAnthropicToolModel({
      apiKey: options.apiKey,
      model,
      system,
      userText,
      toolSchema,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    usage = sumUsage(usage, response.usage);
    if (response.kind === "refusal") return { status: "refusal" };
    const checked = validateAiAuditPayload(response.input, targetIndexes, targetAxes);
    try {
      const judgments = buildAdjudicationJudgments(pending, checked);
      const saved = await saveLabAuditAiAdjudication({
        grantId: options.run.grantId,
        runId: options.run.runId,
        model: options.audit.model,
        adjudicationModel: model,
        promptVersion: AI_ADJUDICATION_PROMPT_VERSION,
        transport: options.transport,
        judgments,
      });
      if (saved.status !== "ok") {
        throw new Error(`3차 판정 저장 실패(${saved.status})${"message" in saved ? `: ${saved.message}` : ""}`);
      }
      return {
        status: "adjudicated",
        applied: saved.applied,
        auditAfter: saved.audit,
        usage,
        costUsd: computeAiReviewCostUsd(model, usage),
        durationMs: Date.now() - startedMs,
      };
    } catch (error) {
      if (attempt === 2) throw error;
      console.warn(`[ai-adjudicate] 응답 검증 실패 — 1회 재시도: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error("3차 판정 응답 처리의 도달 불가 경로");
}

function validateTargets(
  run: LabRun,
  emptyAxes: CriterionDimension[],
  indexes: number[],
  axes: CriterionDimension[],
): void {
  const emptySet = new Set(emptyAxes);
  for (const index of indexes) {
    if (index < 0 || index >= run.criteria.length) throw new Error(`3차 판정 criterion #${index}가 범위 밖입니다.`);
  }
  for (const axis of axes) {
    if (!emptySet.has(axis)) throw new Error(`3차 판정 axis ${axis}가 빈 축이 아닙니다.`);
  }
}

function sumUsage(left: LabUsage | null, right: LabUsage | null): LabUsage | null {
  if (!right) return left;
  if (!left) return right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
  };
}
