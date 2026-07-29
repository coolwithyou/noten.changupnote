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

export const DEEP_ANALYSIS_PROMOTION_READINESS_SCHEMA =
  "deep-analysis-promotion-readiness-v1" as const;

export type DeepAnalysisReadinessState = "passed" | "blocked" | "not_assessed";

export type DeepAnalysisPromotionReadinessBlockerCode =
  | "audit_not_concur"
  | "required_exclusion_conflict"
  | "conversion_error"
  | "empty_criteria"
  | "conversion_dropped"
  | "conversion_downgraded"
  | "question_anchor_lost"
  | "resolution_unconfirmed";

export interface DeepAnalysisPromotionReadinessBlocker {
  code: DeepAnalysisPromotionReadinessBlockerCode;
  stage: "audit_complete" | "matcher_representable";
  count: number;
  detail: string;
}

/**
 * 분석 완료 이후의 서로 다른 운영 질문을 한 PASS로 뭉치지 않는다.
 *
 * 이 seam은 parseDeepAnalysisNormalizedOutput을 통과한 결과만 받으므로
 * analysisComplete는 항상 passed다. auditComplete는 독립 감사 합의,
 * matcherRepresentable은 현재 발행 adapter의 무손실 변환 가능성,
 * autoPromotable은 두 단계를 모두 통과했는지를 뜻한다.
 */
export interface DeepAnalysisPromotionReadiness {
  schema: typeof DEEP_ANALYSIS_PROMOTION_READINESS_SCHEMA;
  analysisComplete: "passed";
  auditComplete: DeepAnalysisReadinessState;
  matcherRepresentable: DeepAnalysisReadinessState;
  autoPromotable: DeepAnalysisReadinessState;
  humanReviewRequired: boolean;
  terminalRoute: "auto_promotable" | "human_review_required";
  blockers: DeepAnalysisPromotionReadinessBlocker[];
}

export class DeepAnalysisPromotionReadinessError extends Error {
  readonly readiness: DeepAnalysisPromotionReadiness;

  constructor(readiness: DeepAnalysisPromotionReadiness) {
    const codes = readiness.blockers.map((blocker) => blocker.code).join(", ");
    const detail = readiness.blockers.map((blocker) => blocker.detail).join(" · ");
    super(`딥분석 자동 승격 불가 [${codes}]: ${detail}`);
    this.name = "DeepAnalysisPromotionReadinessError";
    this.readiness = readiness;
  }
}

export function assessDeepAnalysisPromotionReadiness(input: {
  auditVerdict: string | null;
  requiredExclusionConflictCount?: number;
  plan?: GrantPromotionPlan | null;
}): DeepAnalysisPromotionReadiness {
  const blockers: DeepAnalysisPromotionReadinessBlocker[] = [];
  if (input.auditVerdict !== "concur") {
    blockers.push({
      code: "audit_not_concur",
      stage: "audit_complete",
      count: 1,
      detail: "독립 감사 concur가 아니므로 자동 승격할 수 없습니다.",
    });
  }

  const conflictCount = input.requiredExclusionConflictCount ?? 0;
  if (conflictCount > 0) {
    blockers.push({
      code: "required_exclusion_conflict",
      stage: "matcher_representable",
      count: conflictCount,
      detail: `동일 조건의 required/exclusion 충돌 ${conflictCount}건`,
    });
  }

  if (input.plan) {
    const guarded = applyPublishGuards([input.plan]);
    const refusal = guarded.refused[0];
    if (refusal?.reason === "conversion_error") {
      blockers.push({
        code: "conversion_error",
        stage: "matcher_representable",
        count: 1,
        detail: refusal.detail,
      });
    } else if (refusal?.reason === "empty_criteria") {
      blockers.push({
        code: "empty_criteria",
        stage: "matcher_representable",
        count: 1,
        detail: refusal.detail,
      });
    }
    if (input.plan.conversion.dropped > 0) {
      blockers.push({
        code: "conversion_dropped",
        stage: "matcher_representable",
        count: input.plan.conversion.dropped,
        detail: `발행 변환에서 criterion ${input.plan.conversion.dropped}건이 탈락했습니다.`,
      });
    }
    if (input.plan.conversion.downgraded > 0) {
      blockers.push({
        code: "conversion_downgraded",
        stage: "matcher_representable",
        count: input.plan.conversion.downgraded,
        detail: `matcher가 무손실 소비할 수 없어 criterion ${input.plan.conversion.downgraded}건이 강등됐습니다.`,
      });
    }
    if (input.plan.droppedQuestionCandidates > 0) {
      blockers.push({
        code: "question_anchor_lost",
        stage: "matcher_representable",
        count: input.plan.droppedQuestionCandidates,
        detail: `확인 질문 anchor ${input.plan.droppedQuestionCandidates}건이 발행 criterion을 잃었습니다.`,
      });
    }
    const unconfirmedCount = input.plan.resolutions.filter(
      (resolution) => resolution.state !== "confirmed_correct",
    ).length;
    if (unconfirmedCount > 0) {
      blockers.push({
        code: "resolution_unconfirmed",
        stage: "matcher_representable",
        count: unconfirmedCount,
        detail: `확정되지 않은 criterion resolution ${unconfirmedCount}건`,
      });
    }
  }

  const auditComplete: DeepAnalysisReadinessState =
    input.auditVerdict === "concur" ? "passed" : "blocked";
  const matcherBlockers = blockers.filter(
    (blocker) => blocker.stage === "matcher_representable",
  );
  const matcherRepresentable: DeepAnalysisReadinessState =
    input.plan || conflictCount > 0
      ? matcherBlockers.length === 0 ? "passed" : "blocked"
      : "not_assessed";
  const autoPromotable =
    auditComplete === "passed" && matcherRepresentable === "passed";
  return {
    schema: DEEP_ANALYSIS_PROMOTION_READINESS_SCHEMA,
    analysisComplete: "passed",
    auditComplete,
    matcherRepresentable,
    autoPromotable: autoPromotable ? "passed" : "blocked",
    humanReviewRequired: !autoPromotable,
    terminalRoute: autoPromotable ? "auto_promotable" : "human_review_required",
    blockers,
  };
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
}): {
  labRun: LabRun;
  plan: GrantPromotionPlan;
  readiness: DeepAnalysisPromotionReadiness;
} {
  if (input.audit.verdict !== "concur") {
    throw new DeepAnalysisPromotionReadinessError(
      assessDeepAnalysisPromotionReadiness({
        auditVerdict: input.audit.verdict,
      }),
    );
  }
  const result = input.output.result;
  const requiredExclusionConflicts = findRequiredExclusionConflicts(result.criteria);
  if (requiredExclusionConflicts.length > 0) {
    throw new DeepAnalysisPromotionReadinessError(
      assessDeepAnalysisPromotionReadiness({
        auditVerdict: input.audit.verdict,
        requiredExclusionConflictCount: requiredExclusionConflicts.length,
      }),
    );
  }
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
  const readiness = assessDeepAnalysisPromotionReadiness({
    auditVerdict: input.audit.verdict,
    plan,
  });
  if (readiness.terminalRoute !== "auto_promotable") {
    throw new DeepAnalysisPromotionReadinessError(readiness);
  }
  return { labRun, plan, readiness };
}

function findRequiredExclusionConflicts(
  criteria: DeepAnalysisModelResult["criteria"],
): DeepAnalysisModelResult["criteria"] {
  const required = new Set(
    criteria
      .filter((criterion) => criterion.kind === "required")
      .map((criterion) => stableJson({
        dimension: criterion.dimension,
        operator: polarityNeutralOperator(criterion.operator),
        value: criterion.value,
      })),
  );
  return criteria.filter((criterion) =>
    criterion.kind === "exclusion" &&
    required.has(stableJson({
      dimension: criterion.dimension,
      operator: polarityNeutralOperator(criterion.operator),
      value: criterion.value,
    })));
}

function polarityNeutralOperator(operator: string): string {
  return operator === "in" || operator === "not_in" ? "membership" : operator;
}
