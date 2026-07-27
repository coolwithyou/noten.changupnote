import type {
  DeepAnalysisModelResult,
} from "@cunote/contracts";
import {
  type LabAudit,
  type LabCurrentCriterion,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import { computeLabDimensionDiffs } from "../analysis-lab/diff";
import {
  applyPublishGuards,
  planGrantPromotion,
  type GrantPromotionPlan,
} from "../analysis-lab/promote";
import { stableJson } from "./sourceRevision";

type NormalizedDeepAnalysisResult = Omit<
  DeepAnalysisModelResult,
  "rawToolInput" | "rawResponseText"
>;

export interface DeepAnalysisNormalizedOutput {
  schema: "deep-analysis-normalized-output-v1";
  result: NormalizedDeepAnalysisResult;
  validation: {
    valid: boolean;
    responseContractValid: boolean;
    axisCoverageComplete: boolean;
    evidenceGrounded: boolean;
  };
}

export interface DeepPromotionRunIdentity {
  runId: string;
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  model: string;
  promptVersion: string;
  startedAt: Date;
  completedAt: Date | null;
  inputChars: number;
  inputSha256: string;
  costUsd: number | null;
}

export function parseDeepAnalysisNormalizedOutput(
  value: unknown,
): DeepAnalysisNormalizedOutput {
  if (!value || typeof value !== "object") {
    throw new Error("딥분석 normalized output이 객체가 아닙니다.");
  }
  const output = value as Partial<DeepAnalysisNormalizedOutput>;
  if (
    output.schema !== "deep-analysis-normalized-output-v1"
    || !output.result
    || !Array.isArray(output.result.criteria)
    || !Array.isArray(output.result.axisAssessments)
    || !output.validation
    || output.validation.valid !== true
    || output.validation.responseContractValid !== true
    || output.validation.axisCoverageComplete !== true
    || output.validation.evidenceGrounded !== true
  ) {
    throw new Error("딥분석 normalized output이 S7~S9 통과 계약과 일치하지 않습니다.");
  }
  return output as DeepAnalysisNormalizedOutput;
}

export function buildDeepAnalysisPromotionPlan(input: {
  run: DeepPromotionRunIdentity;
  output: DeepAnalysisNormalizedOutput;
  currentCriteria: LabCurrentCriterion[];
  audit: {
    model: string;
    promptVersion: string;
    completedAt: Date;
    verdict: string;
  };
}): { labRun: LabRun; plan: GrantPromotionPlan } {
  if (input.audit.verdict !== "concur") {
    throw new Error("독립 감사 concur가 아닌 run은 자동 승격 계획을 만들 수 없습니다.");
  }
  const result = input.output.result;
  assertNoRequiredExclusionConflict(result.criteria);
  const labRun: LabRun = {
    runId: input.run.runId,
    grantId: input.run.grantId,
    source: input.run.source,
    sourceId: input.run.sourceId,
    title: input.run.title,
    model: input.run.model,
    promptVersion: input.run.promptVersion,
    startedAt: input.run.startedAt.toISOString(),
    durationMs: Math.max(
      0,
      (input.run.completedAt ?? input.audit.completedAt).getTime() - input.run.startedAt.getTime(),
    ),
    inputBlocks: [],
    inputTotalChars: input.run.inputChars,
    inputSha256: input.run.inputSha256,
    usage: result.usage,
    costUsd: input.run.costUsd,
    analysisMarkdown: result.analysisMarkdown,
    programIntent: result.programIntent,
    criteria: result.criteria,
    axisAssessments: result.axisAssessments,
    taxonomyProposals: result.taxonomyProposals,
    dimensionDiffs: computeLabDimensionDiffs({
      current: input.currentCriteria,
      proposed: result.criteria,
      assessments: result.axisAssessments,
    }),
    error: null,
  };
  const audit: LabAudit = {
    schema: "lab-audit-v1",
    grantId: input.run.grantId,
    runId: input.run.runId,
    model: input.audit.model,
    aiPromptVersion: input.audit.promptVersion,
    auditorEmail: null,
    createdAt: input.audit.completedAt.toISOString(),
    updatedAt: input.audit.completedAt.toISOString(),
    items: labRun.criteria.map((_, criterionIndex) => ({
      kind: "criterion",
      criterionIndex,
      reason: "correct_sample",
      aiVerdict: "correct",
      aiNote: "프로덕션 blind independent audit가 전체 semantic set에 concur",
      humanVerdict: null,
      note: null,
      aiAuditVerdict: "correct",
      aiAuditNote: "프로덕션 deep-analysis audit concur",
    })),
    overallNote: "프로덕션 S10 independent_audit_passed receipt에서 파생한 승격 adapter",
    aiAuditModel: input.audit.model,
    aiAuditPromptVersion: input.audit.promptVersion,
    aiAuditedAt: input.audit.completedAt.toISOString(),
  };
  const plan = planGrantPromotion({
    run: labRun,
    audit,
    origin: "audited",
    sidecar: null,
  });
  const guarded = applyPublishGuards([plan]);
  if (guarded.refused[0]) {
    throw new Error(
      `딥분석 승격 가드 거부: ${guarded.refused[0].reason} · ${guarded.refused[0].detail}`,
    );
  }
  if (
    plan.conversion.dropped > 0
    || plan.conversion.error
    || plan.droppedQuestionCandidates > 0
    || plan.resolutions.some((resolution) => resolution.state !== "confirmed_correct")
    || plan.criteria.some((criterion) => criterion.needs_review === true)
  ) {
    throw new Error(
      "딥분석 자동 승격 계획에 변환 드롭·강등·미확정·질문 앵커 상실이 있어 fail-closed 차단했습니다.",
    );
  }
  return { labRun, plan };
}

function assertNoRequiredExclusionConflict(
  criteria: DeepAnalysisModelResult["criteria"],
): void {
  const required = new Set(
    criteria
      .filter((criterion) => criterion.kind === "required")
      .map((criterion) => stableJson({
        dimension: criterion.dimension,
        operator: polarityNeutralOperator(criterion.operator),
        value: criterion.value,
      })),
  );
  const conflict = criteria.find((criterion) =>
    criterion.kind === "exclusion" &&
    required.has(stableJson({
      dimension: criterion.dimension,
      operator: polarityNeutralOperator(criterion.operator),
      value: criterion.value,
    })));
  if (conflict) {
    throw new Error(
      `딥분석 자동 승격 계획의 ${conflict.dimension} 조건이 동일한 값으로 required/exclusion에 동시에 존재합니다.`,
    );
  }
}

function polarityNeutralOperator(operator: string): string {
  return operator === "in" || operator === "not_in" ? "membership" : operator;
}
