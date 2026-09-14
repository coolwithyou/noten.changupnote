import {
  CRITERION_DIMENSIONS,
  type CriterionDimension,
  type DeepAnalysisEffort,
  type DeepAnalysisModelResult,
  type DeepAnalysisUsage,
  type GrantCriterion,
} from "@cunote/contracts";
import type { DeepAnalysisAuditAcceptedFinding } from "./auditAdjudication";
import type {
  DeepAnalysisDeterministicAxisRepair,
  DeepAnalysisDeterministicBizAgeBoundaryRepair,
  DeepAnalysisDeterministicEvidenceRepair,
  DeepAnalysisDeterministicMatchingScopeRepair,
  DeepAnalysisDeterministicOptionalMetadataRepair,
  DeepAnalysisDeterministicTargetTypeListRepair,
  DeepAnalysisExecution,
  DeepAnalysisModelPass,
} from "./analyzer";
import { sumDeepAnalysisActualCosts } from "./costPolicy";
import {
  DEEP_ANALYSIS_ALTERNATIVE_PATH_SCOPE_RULE,
  DEEP_ANALYSIS_BIZ_AGE_BOUNDARY_RULE,
  DEEP_ANALYSIS_CROSS_AXIS_TEXT_ONLY_RULE,
  DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
  DEEP_ANALYSIS_SCORING_TABLE_COMPLETENESS_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE,
  findExactEvidenceSpanCandidates,
  runDeepGrantAnalysis,
} from "./extractor";
import { resolveExclusiveBizAgeUpperBound } from "./biz-age-boundary";
import type { DeepAnalysisInputSeal } from "./inputManifest";
import { stableJson } from "./sourceRevision";
import { resolveTargetTypeListSemantics } from "./target-type-list-semantics";
import {
  decideDeepAnalysisValidationRoute,
  validateDeepAnalysisResult,
  type DeepAnalysisValidationResult,
} from "./validator";

export const DEEP_ANALYSIS_REPAIR_VERSION = "deep-analysis-repair-v10" as const;
export const DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION =
  "deep-analysis-audit-retry-feedback-v1" as const;

export interface DeepAnalysisEvidenceRepairHint {
  issuePath: string;
  criterionIndex: number;
  requestedSourceSpan: string;
  exactCandidates: string[];
  candidateCount: number;
  truncated: boolean;
}

export interface DeepAnalysisAuditRetryFeedback {
  version: typeof DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION;
  previousRunId: string;
  auditArtifactKey: string;
  findings: DeepAnalysisAuditAcceptedFinding[];
  taskInstruction: string;
}

const MAX_EVIDENCE_REPAIR_CANDIDATES = 8;
const MAX_DETERMINISTIC_REPAIR_EXTRA_CHARS = 128;
const MAX_DETERMINISTIC_REPAIR_LENGTH_RATIO = 2.5;
const SAFE_SCORE_LAYOUT_TOKENS = new Set([
  "점",
  "가점",
  "배점",
  "총점",
  "만점",
  "점수",
]);

/**
 * 사람이 dead-letter 작업을 명시적으로 재처리할 때, 직전 독립 감사에서 결정론적으로
 * 검증된 blocker만 다음 primary의 교정 맥락으로 돌려준다. 자유서술 disagreement나
 * uncertainty는 포함하지 않아 검수 모델의 추측이 primary에 학습되는 것을 막는다.
 */
export function buildDeepAnalysisAuditRetryFeedback(input: {
  previousRunId: string;
  auditArtifactKey: string;
  artifactText: string;
}): DeepAnalysisAuditRetryFeedback | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.artifactText);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed)
    || (
      parsed.schema !== "deep-analysis-blind-audit-v7"
      && parsed.schema !== "deep-analysis-blind-audit-v8"
    )
  ) return null;
  const adjudication = isRecord(parsed.adjudication) ? parsed.adjudication : null;
  const findingValidation = adjudication && isRecord(adjudication.findingValidation)
    ? adjudication.findingValidation
    : null;
  if (!findingValidation || !Array.isArray(findingValidation.accepted)) return null;
  const findings = findingValidation.accepted
    .map(parseAcceptedAuditFinding)
    .filter((finding): finding is DeepAnalysisAuditAcceptedFinding => finding !== null);
  if (findings.length === 0 || findings.length !== findingValidation.accepted.length) return null;
  const taskInstruction = [
    "이 실행은 관리자가 명시적으로 재처리한 동일 봉인 입력이다.",
    "직전 독립 감사와 결정론적 검증기가 아래 누락·오분류를 blocking finding으로 확정했다.",
    "각 finding의 source_span을 현재 원문에서 다시 확인하고, 원문이 그대로 뒷받침하면 해당 criterion과 axis 상태를 완전한 22축 결과에 반영하라.",
    "원문 밖 내용을 추가하거나 uncertainty·rejected finding을 교정 사실로 사용하지 마라.",
    "<<<VERIFIED_AUDIT_FINDINGS>>>",
    stableJson(findings),
    "<<<END_VERIFIED_AUDIT_FINDINGS>>>",
  ].join("\n");
  return {
    version: DEEP_ANALYSIS_AUDIT_RETRY_FEEDBACK_VERSION,
    previousRunId: input.previousRunId,
    auditArtifactKey: input.auditArtifactKey,
    findings,
    taskInstruction,
  };
}

/**
 * validator를 완화하지 않고 실패 사유를 primary model에 1회 되돌려 완전한 결과를 다시 받는다.
 * 교정 응답도 raw pass와 비용에 합산하며, 이후 동일 validator를 처음부터 다시 적용한다.
 */
export async function repairDeepAnalysisExecution(input: {
  seal: DeepAnalysisInputSeal;
  apiKey: string;
  model: string;
  effort?: DeepAnalysisEffort | null;
  signal?: AbortSignal;
  failedExecution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
  runModel?: typeof runDeepGrantAnalysis;
}): Promise<DeepAnalysisExecution> {
  input.signal?.throwIfAborted();
  const initialValidationToRepair = selectRepairableValidation({
    result: input.failedExecution.result,
    validation: input.validation,
  });
  const bizAgeBoundary = repairDeepAnalysisBizAgeBoundariesDeterministically({
    execution: input.failedExecution,
    validation: initialValidationToRepair,
  });
  const executionAfterBizAgeBoundary = bizAgeBoundary.execution;
  const fullValidationAfterBizAgeBoundary = bizAgeBoundary.repairs.length > 0
    ? validateDeepAnalysisResult({
      seal: input.seal,
      result: executionAfterBizAgeBoundary.result,
    })
    : input.validation;
  const validationAfterBizAgeBoundary = selectRepairableValidation({
    result: executionAfterBizAgeBoundary.result,
    validation: fullValidationAfterBizAgeBoundary,
  });
  const targetTypeList = repairDeepAnalysisTargetTypeListDeterministically({
    execution: executionAfterBizAgeBoundary,
    validation: validationAfterBizAgeBoundary,
  });
  const executionAfterTargetTypeList = targetTypeList.execution;
  const fullValidationAfterTargetTypeList = targetTypeList.repairs.length > 0
    ? validateDeepAnalysisResult({
      seal: input.seal,
      result: executionAfterTargetTypeList.result,
    })
    : fullValidationAfterBizAgeBoundary;
  const validationAfterTargetTypeList = selectRepairableValidation({
    result: executionAfterTargetTypeList.result,
    validation: fullValidationAfterTargetTypeList,
  });
  const optionalMetadata = repairDeepAnalysisOptionalMetadataDeterministically({
    execution: executionAfterTargetTypeList,
    validation: validationAfterTargetTypeList,
  });
  const executionAfterOptionalMetadata = optionalMetadata.execution;
  const fullValidationAfterOptionalMetadata = optionalMetadata.repairs.length > 0
    ? validateDeepAnalysisResult({
      seal: input.seal,
      result: executionAfterOptionalMetadata.result,
    })
    : fullValidationAfterTargetTypeList;
  const validationAfterOptionalMetadata = selectRepairableValidation({
    result: executionAfterOptionalMetadata.result,
    validation: fullValidationAfterOptionalMetadata,
  });
  const deterministic = repairDeepAnalysisEvidenceSpansDeterministically({
    execution: executionAfterOptionalMetadata,
    validation: validationAfterOptionalMetadata,
  });
  const executionToRepair = deterministic.execution;
  const fullValidationAfterEvidence = deterministic.repairs.length > 0
    ? validateDeepAnalysisResult({
      seal: input.seal,
      result: executionToRepair.result,
    })
    : fullValidationAfterOptionalMetadata;
  const validationToRepair = selectRepairableValidation({
    result: executionToRepair.result,
    validation: fullValidationAfterEvidence,
  });
  const matchingScope = repairDeepAnalysisMatchingScopeDeterministically({
    execution: executionToRepair,
    validation: validationToRepair,
  });
  const scopedExecutionToRepair = matchingScope.execution;
  const fullScopedValidation = matchingScope.repairs.length > 0
    ? validateDeepAnalysisResult({
      seal: input.seal,
      result: scopedExecutionToRepair.result,
    })
    : fullValidationAfterEvidence;
  const axisStatus = repairDeepAnalysisAxisStatusesDeterministically({
    execution: scopedExecutionToRepair,
    validation: fullScopedValidation,
  });
  const axisExecutionToRepair = axisStatus.execution;
  const fullAxisValidation = axisStatus.repairs.length > 0
    ? validateDeepAnalysisResult({
      seal: input.seal,
      result: axisExecutionToRepair.result,
    })
    : fullScopedValidation;
  const axisRoute = decideDeepAnalysisValidationRoute({
    result: axisExecutionToRepair.result,
    validation: fullAxisValidation,
  });
  if (
    (
      deterministic.repairs.length > 0
      || bizAgeBoundary.repairs.length > 0
      || targetTypeList.repairs.length > 0
      || optionalMetadata.repairs.length > 0
      || matchingScope.repairs.length > 0
      || axisStatus.repairs.length > 0
    )
    && axisRoute.route !== "repair"
  ) {
    return axisExecutionToRepair;
  }
  const scopedValidationToRepair = selectRepairableValidation({
    result: axisExecutionToRepair.result,
    validation: fullAxisValidation,
  });

  const runModel = input.runModel ?? runDeepGrantAnalysis;
  const evidenceRepairHints = buildDeepAnalysisEvidenceRepairHints({
    execution: axisExecutionToRepair,
    validation: scopedValidationToRepair,
  });
  const repairInput = [
    axisExecutionToRepair.evidenceText,
    "",
    "<<<FAILED_RESULT_TO_REPAIR>>>",
    stableJson({
      result: stripRaw(axisExecutionToRepair.result),
      validatorIssues: scopedValidationToRepair.issues,
      evidenceRepairHints,
    }),
    "<<<END_FAILED_RESULT_TO_REPAIR>>>",
  ].join("\n");
  const repaired = await runModel({
    apiKey: input.apiKey,
    inputText: repairInput,
    evidenceText: axisExecutionToRepair.evidenceText,
    model: input.model,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    taskInstruction: [
      "아래 원문과 직전 결과의 validator 실패 사유를 읽고 전체 22축 결과를 교정해서 다시 반환하라.",
      "validator 지적을 삭제하거나 무시하지 말고 원문 근거로 해결하라.",
      "criterion이 있는 축은 반드시 condition_found, condition_found 축은 criterion 1개 이상이어야 한다.",
      "ambiguous는 원문을 모두 읽어도 found/no_condition을 정말 결정할 수 없을 때만 사용한다.",
      "모든 source_span은 원문 영역에서 공백과 문장부호까지 글자 그대로 복사한다.",
      "evidenceRepairHints가 있는 source_span 오류는 해당 exactCandidates 중 criterion을 충분히 뒷받침하는 가장 짧은 후보 하나를 한 글자도 바꾸지 말고 사용하며, 서로 다른 후보를 합치거나 다시 쓰지 마라.",
      "axis_criterion_mismatch에서 실제 조건이 있으면 같은 축 criterion을 만들고 condition_found를 유지하며, 실제 조건이 없으면 criterion을 만들지 말고 inspected_no_condition으로 고쳐라.",
      `list_semantics 또는 포털 구조화 필드 관련 semantic_misattribution은 다음 계약으로 고쳐라: ${DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE}`,
      `업력 월 경계 관련 semantic_misattribution은 다음 계약으로 고쳐라: ${DEEP_ANALYSIS_BIZ_AGE_BOUNDARY_RULE}`,
      DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
      DEEP_ANALYSIS_SCORING_TABLE_COMPLETENESS_RULE,
      DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
      `신청자 대안 경로를 한 조건으로 평탄화하지 마라: ${DEEP_ANALYSIS_ALTERNATIVE_PATH_SCOPE_RULE}`,
      DEEP_ANALYSIS_CROSS_AXIS_TEXT_ONLY_RULE,
      "직전 결과에서 source_ref가 검증된 source_limitations는 이번 validator 지적의 대상이 아닌 한 빠뜨리거나 범위를 바꾸지 마라.",
      "직전 결과 일부만 패치하지 말고 완전한 tool 결과 전체를 다시 반환한다.",
    ].join(" "),
  });
  const repairedWithPreservedLimitations = preserveValidatedSourceLimitations({
    repaired,
    validated: fullAxisValidation.sourceLimitations,
  });
  const repairPass: DeepAnalysisModelPass = {
    kind: "repair",
    chunkId: null,
    inputChars: repairInput.length,
    result: repairedWithPreservedLimitations,
  };
  const passes = [...axisExecutionToRepair.passes, repairPass];
  return {
    evidenceText: axisExecutionToRepair.evidenceText,
    passes,
    ...(axisExecutionToRepair.deterministicEvidenceRepairs
      ? {
        deterministicEvidenceRepairs:
          axisExecutionToRepair.deterministicEvidenceRepairs,
      }
      : {}),
    ...(axisExecutionToRepair.deterministicMatchingScopeRepairs
      ? {
        deterministicMatchingScopeRepairs:
          axisExecutionToRepair.deterministicMatchingScopeRepairs,
      }
      : {}),
    ...(axisExecutionToRepair.deterministicAxisRepairs
      ? { deterministicAxisRepairs: axisExecutionToRepair.deterministicAxisRepairs }
      : {}),
    ...(axisExecutionToRepair.deterministicOptionalMetadataRepairs
      ? {
        deterministicOptionalMetadataRepairs:
          axisExecutionToRepair.deterministicOptionalMetadataRepairs,
      }
      : {}),
    ...(axisExecutionToRepair.deterministicTargetTypeListRepairs
      ? {
        deterministicTargetTypeListRepairs:
          axisExecutionToRepair.deterministicTargetTypeListRepairs,
      }
      : {}),
    ...(axisExecutionToRepair.deterministicBizAgeBoundaryRepairs
      ? {
        deterministicBizAgeBoundaryRepairs:
          axisExecutionToRepair.deterministicBizAgeBoundaryRepairs,
      }
      : {}),
    result: {
      ...repairedWithPreservedLimitations,
      usage: sumUsage(passes.map((pass) => pass.result.usage)),
      costUsd: sumDeepAnalysisActualCosts(passes.map((pass) => pass.result.costUsd)),
    },
  };
}

/**
 * 검증된 단일 `N년 미만` 인용에 모델이 흔한 `N * 12` 포함 상한을 낸 경우만
 * 정수 월 계약의 직전 달로 고친다. 더 큰 오차나 복합 기간은 모델 repair에 남긴다.
 */
export function repairDeepAnalysisBizAgeBoundariesDeterministically(input: {
  execution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
}): {
  execution: DeepAnalysisExecution;
  repairs: DeepAnalysisDeterministicBizAgeBoundaryRepair[];
} {
  const issueIndexes = new Map<number, string>();
  for (const issue of input.validation.issues) {
    if (issue.code !== "semantic_misattribution") continue;
    const match = /^\$\.criteria\[(\d+)\]\.value\.max_months$/.exec(issue.path);
    if (!match) continue;
    issueIndexes.set(Number.parseInt(match[1]!, 10), issue.path);
  }
  if (issueIndexes.size === 0) return { execution: input.execution, repairs: [] };

  const repairs: DeepAnalysisDeterministicBizAgeBoundaryRepair[] = [];
  const criteria = input.execution.result.criteria.map((criterion, criterionIndex) => {
    const issuePath = issueIndexes.get(criterionIndex);
    if (!issuePath || !isRecord(criterion.value)) return criterion;
    const resolution = resolveExclusiveBizAgeUpperBound({
      dimension: criterion.dimension,
      operator: criterion.operator,
      sourceSpan: criterion.sourceSpan,
      spanVerified: criterion.spanVerified,
      maxMonths: criterion.value.max_months,
    });
    if (
      !resolution
      || resolution.observedMaxMonths !== resolution.expectedMaxMonths + 1
      || !criterion.sourceSpan
    ) return criterion;
    repairs.push({
      issuePath,
      criterionIndex,
      years: resolution.years,
      previousMaxMonths: resolution.observedMaxMonths,
      correctedMaxMonths: resolution.expectedMaxMonths,
      sourceSpan: criterion.sourceSpan,
      strategy: "align_exclusive_year_upper_bound",
    });
    return {
      ...criterion,
      value: {
        ...criterion.value,
        max_months: resolution.expectedMaxMonths,
      },
    };
  });
  if (repairs.length === 0) return { execution: input.execution, repairs };

  const repairedIndexes = new Map(repairs.map((repair) => [repair.criterionIndex, repair]));
  const rawToolInput = { ...input.execution.result.rawToolInput };
  if (Array.isArray(rawToolInput.criteria)) {
    rawToolInput.criteria = rawToolInput.criteria.map((rawCriterion, criterionIndex) => {
      const repair = repairedIndexes.get(criterionIndex);
      if (!repair || !isRecord(rawCriterion) || !isRecord(rawCriterion.value)) return rawCriterion;
      if (rawCriterion.value.max_months !== repair.previousMaxMonths) return rawCriterion;
      return {
        ...rawCriterion,
        value: {
          ...rawCriterion.value,
          max_months: repair.correctedMaxMonths,
        },
      };
    });
  }
  return {
    repairs,
    execution: {
      ...input.execution,
      deterministicBizAgeBoundaryRepairs: [
        ...(input.execution.deterministicBizAgeBoundaryRepairs ?? []),
        ...repairs,
      ],
      result: {
        ...input.execution.result,
        criteria,
        rawToolInput,
      },
    },
  };
}

/**
 * 업체·농가처럼 법적 신청자 유형인지조차 확정할 수 없는 일반 표현은 open/closed 중
 * 하나로 꾸며내지 않는다. validator의 정확한 목록 의미 issue, 검증된 source span,
 * target_type/other 축 상태가 모두 기대한 경우에만 원문 조건을 other/text_only로
 * 보존하고 target_type을 ambiguous로 돌린다.
 */
export function repairDeepAnalysisTargetTypeListDeterministically(input: {
  execution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
}): {
  execution: DeepAnalysisExecution;
  repairs: DeepAnalysisDeterministicTargetTypeListRepair[];
} {
  const targetAxis = input.execution.result.axisAssessments.find((axis) => axis.dimension === "target_type");
  const otherAxis = input.execution.result.axisAssessments.find((axis) => axis.dimension === "other");
  if (
    targetAxis?.status !== "condition_found"
    || otherAxis?.status !== "inspected_no_condition"
    || input.execution.result.criteria.some((criterion) => criterion.dimension === "other")
  ) return { execution: input.execution, repairs: [] };

  const issueIndexes = new Map<number, string>();
  for (const issue of input.validation.issues) {
    if (issue.code !== "semantic_misattribution") continue;
    const match = /^\$\.criteria\[(\d+)\]\.value\.list_semantics$/.exec(issue.path);
    if (!match) continue;
    issueIndexes.set(Number.parseInt(match[1]!, 10), issue.path);
  }
  if (issueIndexes.size === 0) return { execution: input.execution, repairs: [] };

  const repairs: DeepAnalysisDeterministicTargetTypeListRepair[] = [];
  const criteria = input.execution.result.criteria.map((criterion, criterionIndex) => {
    const issuePath = issueIndexes.get(criterionIndex);
    if (
      !issuePath
      || criterion.dimension !== "target_type"
      || criterion.kind !== "required"
      || criterion.operator !== "in"
      || !criterion.spanVerified
      || !criterion.sourceSpan
      || !isRecord(criterion.value)
    ) return criterion;
    const targets = Array.isArray(criterion.value.targets)
      ? criterion.value.targets.filter((target): target is string => typeof target === "string")
      : [];
    const resolution = resolveTargetTypeListSemantics({
      dimension: criterion.dimension,
      kind: criterion.kind,
      operator: criterion.operator,
      sourceSpan: criterion.sourceSpan,
      spanVerified: criterion.spanVerified,
      targets,
      listSemantics: criterion.value.list_semantics,
      note: criterion.note,
      inputText: input.execution.evidenceText,
    });
    if (
      resolution.decision !== "unresolved"
      || resolution.reason !== "generic_applicant_description"
      || resolution.previousClaim === null
    ) {
      return criterion;
    }
    repairs.push({
      issuePath,
      criterionIndex,
      targets,
      previousListSemantics: resolution.previousClaim,
      sourceSpan: criterion.sourceSpan,
      reason: resolution.reason,
      strategy: "preserve_unresolved_target_type_as_text",
    });
    return {
      ...criterion,
      dimension: "other" as const,
      operator: "text_only" as const,
      value: { note: criterion.sourceSpan },
      note: "신청 대상 유형의 완전 열거 여부를 확인할 근거가 부족하여 구조화 대상 유형 필터로 사용하지 않는다.",
    };
  });
  if (repairs.length === 0) return { execution: input.execution, repairs };

  const repairedIndexes = new Set(repairs.map((repair) => repair.criterionIndex));
  const targetComment = "일반 신청자 표현만 있어 법적 대상 유형의 완전 열거 여부를 확인할 수 없음.";
  const otherComment = "목록 의미를 확정할 수 없는 신청 조건을 원문 text_only로 보존함.";
  const axisAssessments = input.execution.result.axisAssessments.map((axis) => {
    if (axis.dimension === "target_type") return { ...axis, status: "ambiguous" as const, comment: targetComment };
    if (axis.dimension === "other") return { ...axis, status: "condition_found" as const, comment: otherComment };
    return axis;
  });
  const rawToolInput = { ...input.execution.result.rawToolInput };
  if (Array.isArray(rawToolInput.criteria)) {
    rawToolInput.criteria = rawToolInput.criteria.map((rawCriterion, criterionIndex) => {
      const normalized = criteria[criterionIndex];
      if (!repairedIndexes.has(criterionIndex) || !normalized || !isRecord(rawCriterion)) return rawCriterion;
      return {
        ...rawCriterion,
        dimension: normalized.dimension,
        operator: normalized.operator,
        value: normalized.value,
        note: normalized.note,
      };
    });
  }
  if (Array.isArray(rawToolInput.axis_assessments)) {
    rawToolInput.axis_assessments = rawToolInput.axis_assessments.map((rawAxis) => {
      if (!isRecord(rawAxis)) return rawAxis;
      if (rawAxis.dimension === "target_type") return { ...rawAxis, status: "ambiguous", comment: targetComment };
      if (rawAxis.dimension === "other") return { ...rawAxis, status: "condition_found", comment: otherComment };
      return rawAxis;
    });
  }
  return {
    repairs,
    execution: {
      ...input.execution,
      deterministicTargetTypeListRepairs: [
        ...(input.execution.deterministicTargetTypeListRepairs ?? []),
        ...repairs,
      ],
      result: {
        ...input.execution.result,
        criteria,
        axisAssessments,
        rawToolInput,
      },
    },
  };
}

/**
 * 선택 메타데이터가 정확히 빈 배열이면 어떤 축도 주장하지 않는다. validator가 이미
 * 해당 경로를 지적했고 criterion이 허용된 other/text_only 형태일 때만 키를 생략한다.
 * null·문자열·잘못된/중복/혼합 축과 비어 있지 않은 배열은 의미 판단이 필요하므로
 * 기존 모델 repair 또는 held 경로에 그대로 남긴다.
 */
export function repairDeepAnalysisOptionalMetadataDeterministically(input: {
  execution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
}): {
  execution: DeepAnalysisExecution;
  repairs: DeepAnalysisDeterministicOptionalMetadataRepair[];
} {
  const issueIndexes = new Map<number, string>();
  for (const issue of input.validation.issues) {
    if (issue.code !== "canonical_contract_invalid") continue;
    const match = /^\$\.criteria\[(\d+)\]\.value\.covered_dimensions$/.exec(issue.path);
    if (!match) continue;
    issueIndexes.set(Number.parseInt(match[1]!, 10), issue.path);
  }
  if (issueIndexes.size === 0) return { execution: input.execution, repairs: [] };

  const repairs: DeepAnalysisDeterministicOptionalMetadataRepair[] = [];
  const criteria = input.execution.result.criteria.map((criterion, criterionIndex) => {
    const issuePath = issueIndexes.get(criterionIndex);
    if (
      !issuePath
      || criterion.dimension !== "other"
      || criterion.operator !== "text_only"
      || !isRecord(criterion.value)
      || !Array.isArray(criterion.value.covered_dimensions)
      || criterion.value.covered_dimensions.length !== 0
    ) return criterion;
    const value = { ...criterion.value };
    delete value.covered_dimensions;
    repairs.push({
      issuePath,
      criterionIndex,
      key: "covered_dimensions",
      strategy: "omit_empty_optional_covered_dimensions",
    });
    return { ...criterion, value };
  });
  if (repairs.length === 0) return { execution: input.execution, repairs };

  const repairedIndexes = new Set(repairs.map((repair) => repair.criterionIndex));
  const rawToolInput = { ...input.execution.result.rawToolInput };
  if (Array.isArray(rawToolInput.criteria)) {
    rawToolInput.criteria = rawToolInput.criteria.map((rawCriterion, criterionIndex) => {
      if (!repairedIndexes.has(criterionIndex) || !isRecord(rawCriterion)) return rawCriterion;
      const rawValue = isRecord(rawCriterion.value) ? { ...rawCriterion.value } : null;
      if (!rawValue || !Array.isArray(rawValue.covered_dimensions) || rawValue.covered_dimensions.length !== 0) {
        return rawCriterion;
      }
      delete rawValue.covered_dimensions;
      return { ...rawCriterion, value: rawValue };
    });
  }

  return {
    repairs,
    execution: {
      ...input.execution,
      deterministicOptionalMetadataRepairs: [
        ...(input.execution.deterministicOptionalMetadataRepairs ?? []),
        ...repairs,
      ],
      result: {
        ...input.execution.result,
        criteria,
        rawToolInput,
      },
    },
  };
}

/**
 * validator가 실제 criterion을 검증했는데 축만 inspected_no_condition으로 남은 경우에만
 * 정규화 결과와 raw tool input의 축 상태를 함께 condition_found로 맞춘다. 의미상 보류인
 * ambiguous/input_missing와 criterion 없는 반대 방향은 추측 교정하지 않는다.
 */
export function repairDeepAnalysisAxisStatusesDeterministically(input: {
  execution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
}): {
  execution: DeepAnalysisExecution;
  repairs: DeepAnalysisDeterministicAxisRepair[];
} {
  const candidateIssues = new Map<CriterionDimension, string>();
  for (const issue of input.validation.issues) {
    if (issue.code !== "axis_criterion_mismatch") continue;
    const match = /^\$\.criteria\.([a-z_]+)$/.exec(issue.path);
    const dimension = match?.[1];
    if (
      !dimension
      || !(CRITERION_DIMENSIONS as readonly string[]).includes(dimension)
    ) continue;
    candidateIssues.set(dimension as CriterionDimension, issue.path);
  }
  if (candidateIssues.size === 0) {
    return { execution: input.execution, repairs: [] };
  }

  const invalidCriterionIndexes = new Set<number>();
  for (const issue of input.validation.issues) {
    const match = /^\$\.criteria\[(\d+)\](?:\.|$)/.exec(issue.path);
    if (match) invalidCriterionIndexes.add(Number.parseInt(match[1]!, 10));
  }
  const validatedCriteriaByDimension = new Map<CriterionDimension, number>();
  for (const item of input.validation.criteria) {
    if (invalidCriterionIndexes.has(item.index)) continue;
    validatedCriteriaByDimension.set(
      item.criterion.dimension,
      (validatedCriteriaByDimension.get(item.criterion.dimension) ?? 0) + 1,
    );
  }

  const repairs: DeepAnalysisDeterministicAxisRepair[] = [];
  const axisAssessments = input.execution.result.axisAssessments.map((axis) => {
    const issuePath = candidateIssues.get(axis.dimension);
    const criterionCount = validatedCriteriaByDimension.get(axis.dimension) ?? 0;
    if (!issuePath || axis.status !== "inspected_no_condition" || criterionCount === 0) {
      return axis;
    }
    repairs.push({
      issuePath,
      dimension: axis.dimension,
      fromStatus: "inspected_no_condition",
      toStatus: "condition_found",
      criterionCount,
      strategy: "align_axis_with_validated_criteria",
    });
    return { ...axis, status: "condition_found" as const };
  });
  if (repairs.length === 0) {
    return { execution: input.execution, repairs };
  }

  const repairedDimensions = new Set(repairs.map((repair) => repair.dimension));
  const rawToolInput = { ...input.execution.result.rawToolInput };
  if (Array.isArray(rawToolInput.axis_assessments)) {
    rawToolInput.axis_assessments = rawToolInput.axis_assessments.map((rawAxis) => (
      isRecord(rawAxis)
      && typeof rawAxis.dimension === "string"
      && repairedDimensions.has(rawAxis.dimension as CriterionDimension)
        ? { ...rawAxis, status: "condition_found" }
        : rawAxis
    ));
  }

  return {
    repairs,
    execution: {
      ...input.execution,
      deterministicAxisRepairs: [
        ...(input.execution.deterministicAxisRepairs ?? []),
        ...repairs,
      ],
      result: {
        ...input.execution.result,
        axisAssessments,
        rawToolInput,
      },
    },
  };
}

function selectRepairableValidation(input: {
  result: DeepAnalysisModelResult;
  validation: DeepAnalysisValidationResult;
}): DeepAnalysisValidationResult {
  const route = decideDeepAnalysisValidationRoute(input);
  return route.route === "repair" && route.holdIssues.length > 0
    ? { ...input.validation, issues: route.repairIssues }
    : input.validation;
}

/**
 * validator가 신청 절차·선정 후 의무라고 확정한 criterion만 제거한다. 같은 축에 실제
 * 매칭 criterion이 하나도 남지 않으면 축 상태도 함께 닫아, 모델이 같은 비매칭 문구를
 * 교정 응답에서 반복해 전체 공고를 실패시키지 않게 한다.
 */
export function repairDeepAnalysisMatchingScopeDeterministically(input: {
  execution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
}): {
  execution: DeepAnalysisExecution;
  repairs: DeepAnalysisDeterministicMatchingScopeRepair[];
} {
  const issueIndexes = new Map<number, string>();
  for (const issue of input.validation.issues) {
    if (issue.code !== "non_matching_criterion") continue;
    const match = /^\$\.criteria\[(\d+)\]$/.exec(issue.path);
    if (!match) continue;
    issueIndexes.set(Number.parseInt(match[1]!, 10), issue.path);
  }
  if (issueIndexes.size === 0) {
    return { execution: input.execution, repairs: [] };
  }

  const repairs: DeepAnalysisDeterministicMatchingScopeRepair[] = [];
  const removedDimensions = new Set<CriterionDimension>();
  const criteria = input.execution.result.criteria.filter((criterion, index) => {
    const issuePath = issueIndexes.get(index);
    if (!issuePath) return true;
    removedDimensions.add(criterion.dimension);
    repairs.push({
      issuePath,
      criterionIndex: index,
      dimension: criterion.dimension,
      sourceSpan: criterion.sourceSpan,
      strategy: "remove_non_matching_application_criterion",
    });
    return false;
  });
  if (repairs.length === 0) {
    return { execution: input.execution, repairs };
  }

  const remainingDimensions = new Set(criteria.map((criterion) => criterion.dimension));
  const axisAssessments = input.execution.result.axisAssessments.map((axis) => (
    removedDimensions.has(axis.dimension)
    && !remainingDimensions.has(axis.dimension)
    && axis.status === "condition_found"
      ? {
        ...axis,
        status: "inspected_no_condition" as const,
        comment: [
          axis.comment,
          "신청 절차 또는 선정 후 의무만 확인되어 매칭 조건에서는 제외함.",
        ].filter(Boolean).join(" "),
      }
      : axis
  ));

  const rawToolInput = { ...input.execution.result.rawToolInput };
  if (Array.isArray(rawToolInput.criteria)) {
    rawToolInput.criteria = rawToolInput.criteria.filter((_, index) => !issueIndexes.has(index));
  }
  if (Array.isArray(rawToolInput.axis_assessments)) {
    const normalizedByDimension = new Map(
      axisAssessments.map((axis) => [axis.dimension, axis]),
    );
    rawToolInput.axis_assessments = rawToolInput.axis_assessments.map((rawAxis) => {
      if (!isRecord(rawAxis) || typeof rawAxis.dimension !== "string") return rawAxis;
      const normalized = normalizedByDimension.get(rawAxis.dimension as CriterionDimension);
      return normalized ? {
        ...rawAxis,
        status: normalized.status,
        comment: normalized.comment,
      } : rawAxis;
    });
  }

  return {
    repairs,
    execution: {
      ...input.execution,
      deterministicMatchingScopeRepairs: [
        ...(input.execution.deterministicMatchingScopeRepairs ?? []),
        ...repairs,
      ],
      result: {
        ...input.execution.result,
        criteria,
        axisAssessments,
        rawToolInput,
      },
    },
  };
}

/**
 * 의미를 다시 판단하지 않아도 되는 source_span 표기 차이만 모델 호출 전에 교정한다.
 * 후보가 유일하고, 원문 후보에 추가된 토큰이 점수표 레이아웃 표기뿐일 때만 적용한다.
 * 의미 토큰이 추가되거나 후보가 여러 개면 아무 것도 바꾸지 않고 기존 LLM repair로
 * 넘긴다.
 */
export function repairDeepAnalysisEvidenceSpansDeterministically(input: {
  execution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
}): {
  execution: DeepAnalysisExecution;
  repairs: DeepAnalysisDeterministicEvidenceRepair[];
} {
  const repairs: DeepAnalysisDeterministicEvidenceRepair[] = [];
  const criteria = [...input.execution.result.criteria];
  for (const issue of input.validation.issues) {
    if (issue.code !== "evidence_not_grounded") continue;
    const match = /^\$\.criteria\[(\d+)\]\.source_span$/.exec(issue.path);
    if (!match) continue;
    const criterionIndex = Number.parseInt(match[1]!, 10);
    const criterion = criteria[criterionIndex];
    const requestedSourceSpan = criterion?.sourceSpan?.trim() ?? "";
    if (!criterion || !requestedSourceSpan) continue;
    const candidates = findExactEvidenceSpanCandidates(
      requestedSourceSpan,
      input.execution.evidenceText,
    );
    const safeCandidates = candidates.filter((candidate) => (
      candidate !== requestedSourceSpan
      && isSafeDeterministicEvidenceCandidate(
        requestedSourceSpan,
        candidate,
      )
    ));
    if (safeCandidates.length !== 1) continue;
    const repairedSourceSpan = safeCandidates[0]!;
    const offset = input.execution.evidenceText.indexOf(repairedSourceSpan);
    criteria[criterionIndex] = {
      ...criterion,
      sourceSpan: repairedSourceSpan,
      spanVerified: true,
      spanOffsetRatio: offset >= 0 && input.execution.evidenceText.length > 0
        ? offset / input.execution.evidenceText.length
        : null,
    };
    repairs.push({
      issuePath: issue.path,
      criterionIndex,
      requestedSourceSpan,
      repairedSourceSpan,
      strategy: "unique_layout_or_score_candidate",
    });
  }
  if (repairs.length === 0) {
    return { execution: input.execution, repairs };
  }
  const cumulativeRepairs = [
    ...(input.execution.deterministicEvidenceRepairs ?? []),
    ...repairs,
  ];
  return {
    repairs,
    execution: {
      ...input.execution,
      deterministicEvidenceRepairs: cumulativeRepairs,
      result: {
        ...input.execution.result,
        criteria,
      },
    },
  };
}

export function buildDeepAnalysisEvidenceRepairHints(input: {
  execution: DeepAnalysisExecution;
  validation: DeepAnalysisValidationResult;
}): DeepAnalysisEvidenceRepairHint[] {
  const hints: DeepAnalysisEvidenceRepairHint[] = [];
  for (const issue of input.validation.issues) {
    if (issue.code !== "evidence_not_grounded") continue;
    const match = /^\$\.criteria\[(\d+)\]\.source_span$/.exec(issue.path);
    if (!match) continue;
    const criterionIndex = Number.parseInt(match[1]!, 10);
    const requestedSourceSpan =
      input.execution.result.criteria[criterionIndex]?.sourceSpan?.trim() ?? "";
    if (!requestedSourceSpan) continue;
    const candidates = findExactEvidenceSpanCandidates(
      requestedSourceSpan,
      input.execution.evidenceText,
    );
    if (candidates.length === 0) continue;
    hints.push({
      issuePath: issue.path,
      criterionIndex,
      requestedSourceSpan,
      exactCandidates: candidates.slice(0, MAX_EVIDENCE_REPAIR_CANDIDATES),
      candidateCount: candidates.length,
      truncated: candidates.length > MAX_EVIDENCE_REPAIR_CANDIDATES,
    });
  }
  return hints;
}

function isSafeDeterministicEvidenceCandidate(
  requestedSourceSpan: string,
  repairedSourceSpan: string,
): boolean {
  const extraChars = repairedSourceSpan.length - requestedSourceSpan.length;
  if (
    extraChars < 0
    || extraChars > MAX_DETERMINISTIC_REPAIR_EXTRA_CHARS
    || repairedSourceSpan.length
      > requestedSourceSpan.length * MAX_DETERMINISTIC_REPAIR_LENGTH_RATIO
  ) return false;
  const requestedTokens = evidenceTokens(requestedSourceSpan);
  const repairedTokens = evidenceTokens(repairedSourceSpan);
  if (requestedTokens.length < 3 || repairedTokens.length < requestedTokens.length) {
    return false;
  }
  let requestedIndex = 0;
  const extraTokens: string[] = [];
  for (const token of repairedTokens) {
    if (token === requestedTokens[requestedIndex]) {
      requestedIndex += 1;
    } else {
      extraTokens.push(token);
    }
  }
  const includesNumericExtra = extraTokens.some((token) => /^\d+$/.test(token));
  const includesScoreMarker = extraTokens.some((token) => (
    SAFE_SCORE_LAYOUT_TOKENS.has(token)
  ));
  return requestedIndex === requestedTokens.length
    && extraTokens.every(isSafeScoreLayoutToken)
    && (!includesNumericExtra || includesScoreMarker);
}

function evidenceTokens(value: string): string[] {
  return [...value.matchAll(/[\p{Letter}\p{Number}%~]+/gu)]
    .map((match) => match[0]);
}

function isSafeScoreLayoutToken(value: string): boolean {
  return /^\d+$/.test(value) || SAFE_SCORE_LAYOUT_TOKENS.has(value);
}

function stripRaw(result: DeepAnalysisModelResult) {
  const { rawResponseText: _response, rawToolInput: _input, ...value } = result;
  return value;
}

function preserveValidatedSourceLimitations(input: {
  repaired: DeepAnalysisModelResult;
  validated: ReadonlyArray<
    NonNullable<DeepAnalysisModelResult["sourceLimitations"]>[number]
  >;
}): DeepAnalysisModelResult {
  if (input.validated.length === 0) return input.repaired;
  const sourceLimitations = [...(input.repaired.sourceLimitations ?? [])];
  const identities = new Set(sourceLimitations.map((item) => stableJson(item)));
  const missing = input.validated.filter((item) => !identities.has(stableJson(item)));
  if (missing.length === 0) return input.repaired;

  const rawToolInput = { ...input.repaired.rawToolInput };
  if (rawToolInput.source_limitations === undefined) {
    rawToolInput.source_limitations = missing.map(rawSourceLimitation);
  } else if (Array.isArray(rawToolInput.source_limitations)) {
    rawToolInput.source_limitations = [
      ...rawToolInput.source_limitations,
      ...missing.map(rawSourceLimitation),
    ];
  }
  return {
    ...input.repaired,
    sourceLimitations: [...sourceLimitations, ...missing],
    rawToolInput,
  };
}

function rawSourceLimitation(
  value: NonNullable<DeepAnalysisModelResult["sourceLimitations"]>[number],
): Record<string, unknown> {
  return {
    scope: value.scope,
    kind: value.kind,
    source_ref: {
      source_kind: value.sourceRef.sourceKind,
      source_id: value.sourceRef.sourceId,
      source_sha256: value.sourceRef.sourceSha256,
      source_span: value.sourceRef.sourceSpan,
    },
    affected_dimensions: value.affectedDimensions,
    explanation: value.explanation,
  };
}

function parseAcceptedAuditFinding(value: unknown): DeepAnalysisAuditAcceptedFinding | null {
  if (!isRecord(value)) return null;
  const candidateKey = typeof value.candidateKey === "string" ? value.candidateKey : "";
  const dimension = isCriterionDimension(value.dimension) ? value.dimension : null;
  const findingType = value.findingType;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  const criterion = parseGrantCriterion(value.criterion);
  if (
    !/^[0-9a-f]{64}$/.test(candidateKey)
    || !dimension
    || (findingType !== "missing_eligibility" && findingType !== "misclassified_eligibility")
    || !reason
    || !criterion
    || criterion.dimension !== dimension
  ) {
    return null;
  }
  return {
    candidateKey,
    dimension,
    findingType,
    reason,
    criterion,
  };
}

function parseGrantCriterion(value: unknown): GrantCriterion | null {
  if (
    !isRecord(value)
    || !isCriterionDimension(value.dimension)
    || typeof value.operator !== "string"
    || typeof value.kind !== "string"
    || !("value" in value)
    || typeof value.confidence !== "number"
    || typeof value.source_span !== "string"
    || value.source_span.trim().length === 0
  ) {
    return null;
  }
  return value as unknown as GrantCriterion;
}

function isCriterionDimension(value: unknown): value is CriterionDimension {
  return typeof value === "string"
    && CRITERION_DIMENSIONS.includes(value as CriterionDimension);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sumUsage(values: Array<DeepAnalysisUsage | null>): DeepAnalysisUsage | null {
  const present = values.filter((value): value is DeepAnalysisUsage => value !== null);
  if (present.length === 0) return null;
  const cache = present.map((value) => value.cacheReadTokens);
  return {
    inputTokens: present.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: present.reduce((sum, value) => sum + value.outputTokens, 0),
    cacheReadTokens: cache.every((value) => value === null)
      ? null
      : cache.reduce<number>((sum, value) => sum + (value ?? 0), 0),
  };
}
