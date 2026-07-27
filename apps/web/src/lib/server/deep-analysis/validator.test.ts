import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisCriterion,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import { sealDeepAnalysisInput } from "./inputManifest";
import { validateDeepAnalysisResult } from "./validator";

const sourceSpan = "본 사업은 서울 소재 중소기업만 신청할 수 있다.";
const seal = sealDeepAnalysisInput({
  grantId: "grant-validator",
  sourceRevisionSha256: "c".repeat(64),
  structuredText: `공고 제목\n${sourceSpan}\n`,
  attachments: [],
});

function axes(found: string[] = []): DeepAnalysisAxisAssessment[] {
  return CRITERION_DIMENSIONS.map((dimension) => ({
    dimension,
    status: found.includes(dimension) ? "condition_found" : "inspected_no_condition",
    confidence: 0.9,
    comment: "전문 검사",
  }));
}

function criterion(overrides: Partial<DeepAnalysisCriterion> = {}): DeepAnalysisCriterion {
  return {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["11"] },
    confidence: 0.95,
    sourceSpan,
    spanVerified: true,
    note: null,
    ...overrides,
  };
}

function rawCriterion(row: DeepAnalysisCriterion): Record<string, unknown> {
  return {
    dimension: row.dimension,
    operator: row.operator,
    kind: row.kind,
    value: row.value,
    confidence: row.confidence,
    source_span: row.sourceSpan,
  };
}

function result(
  criteria: DeepAnalysisCriterion[],
  assessments: DeepAnalysisAxisAssessment[],
): DeepAnalysisModelResult {
  return {
    model: "claude-opus-4-8",
    analysisMarkdown: "# 분석",
    programIntent: null,
    criteria,
    axisAssessments: assessments,
    taxonomyProposals: [],
    usage: null,
    costUsd: null,
    rawToolInput: {
      criteria: criteria.map(rawCriterion),
      axis_assessments: assessments.map((axis) => ({
        dimension: axis.dimension,
        status: axis.status,
        confidence: axis.confidence,
        comment: axis.comment,
      })),
    },
    rawResponseText: "{}",
    stopReason: "tool_use",
  };
}

const valid = validateDeepAnalysisResult({
  seal,
  result: result([criterion()], axes(["region"])),
});
assert.equal(valid.valid, true);
assert.equal(valid.criteria[0]?.evidenceRefs[0]?.sourceKind, "structured");
assert.equal(valid.axisCriterionSemanticHashes.region.length, 1);

const reserved = criterion({
  dimension: "premises",
  operator: "text_only",
  value: { note: sourceSpan },
});
assert.equal(validateDeepAnalysisResult({
  seal,
  result: result([reserved], axes(["premises"])),
}).valid, true, "예약 축도 dimension을 보존한 안전 text_only이면 분석 계약을 통과한다");

const badReserved = criterion({
  dimension: "export_performance",
  operator: "gte",
  value: { min_krw: 10 },
});
assert.equal(validateDeepAnalysisResult({
  seal,
  result: result([badReserved], axes(["export_performance"])),
}).issues.some((issue) => issue.code === "canonical_contract_invalid"), true);

const badInvestment = criterion({
  dimension: "investment",
  operator: "lte",
  value: { min_total_krw: 3_000_000_000 },
});
assert.equal(validateDeepAnalysisResult({
  seal,
  result: result([badInvestment], axes(["investment"])),
}).issues.some((issue) => (
  issue.code === "canonical_contract_invalid" && issue.path.endsWith(".operator")
)), true);

const mismatch = validateDeepAnalysisResult({
  seal,
  result: result([criterion()], axes()),
});
assert.equal(mismatch.axisCoverageComplete, false);
assert.equal(mismatch.issues.some((issue) => issue.code === "axis_criterion_mismatch"), true);

const ungrounded = criterion({
  sourceSpan: "원문에 없는 문장",
  spanVerified: false,
});
assert.equal(validateDeepAnalysisResult({
  seal,
  result: result([ungrounded], axes(["region"])),
}).evidenceGrounded, false);

const duplicate = validateDeepAnalysisResult({
  seal,
  result: result([criterion(), criterion()], axes(["region"])),
});
assert.equal(duplicate.valid, true);
assert.equal(duplicate.criteria.length, 1);
assert.equal(duplicate.axisCriterionSemanticHashes.region.length, 1);

const requiredExclusionConflict = validateDeepAnalysisResult({
  seal,
  result: result([
    criterion({
      dimension: "target_type",
      operator: "in",
      kind: "required",
      value: { target_types: ["대학생", "대학원생"] },
    }),
    criterion({
      dimension: "target_type",
      operator: "not_in",
      kind: "exclusion",
      value: { target_types: ["대학원생", "대학생"] },
    }),
  ], axes(["target_type"])),
});
assert.equal(requiredExclusionConflict.valid, false);
assert.equal(requiredExclusionConflict.responseContractValid, false);
assert.equal(
  requiredExclusionConflict.issues.some((issue) => issue.code === "logical_conflict"),
  true,
);

const creditSourceSpan = "파산 또는 회생절차 개시 신청 기업은 제외한다.";
const creditSeal = sealDeepAnalysisInput({
  grantId: "grant-credit-order",
  sourceRevisionSha256: "d".repeat(64),
  structuredText: creditSourceSpan,
  attachments: [],
});
const creditCriteria = [
  criterion({
    dimension: "credit_status",
    kind: "exclusion",
    value: {
      flags: ["rehabilitation_in_progress", "bankruptcy_filed"],
      exceptions: ["repayment_plan_in_good_standing"],
    },
    sourceSpan: creditSourceSpan,
  }),
  criterion({
    dimension: "credit_status",
    kind: "exclusion",
    value: {
      flags: ["bankruptcy_filed", "rehabilitation_in_progress"],
      exceptions: ["repayment_plan_in_good_standing"],
    },
    sourceSpan: creditSourceSpan,
  }),
];
const creditOrder = validateDeepAnalysisResult({
  seal: creditSeal,
  result: result(creditCriteria, axes(["credit_status"])),
});
assert.equal(creditOrder.valid, true);
assert.equal(creditOrder.criteria.length, 1);
assert.equal(creditOrder.axisCriterionSemanticHashes.credit_status.length, 1);

const wrongExceptionCoverage = validateDeepAnalysisResult({
  seal: creditSeal,
  result: result([
    criterion({
      dimension: "credit_status",
      kind: "exclusion",
      value: {
        flags: ["asset_seizure"],
        exceptions: ["repayment_plan_in_good_standing"],
      },
      sourceSpan: creditSourceSpan,
    }),
  ], axes(["credit_status"])),
});
assert.equal(wrongExceptionCoverage.valid, false);
assert.equal(
  wrongExceptionCoverage.issues.some((issue) =>
    issue.message.includes("repayment_plan_in_good_standing does not cover")),
  true,
);

const restartExceptionCoverage = validateDeepAnalysisResult({
  seal: creditSeal,
  result: result([
    criterion({
      dimension: "credit_status",
      kind: "exclusion",
      value: {
        flags: ["loan_default"],
        exceptions: ["restart_funding_recipient", "retry_guarantee_recipient"],
      },
      sourceSpan: creditSourceSpan,
    }),
  ], axes(["credit_status"])),
});
assert.equal(restartExceptionCoverage.valid, true);

const structuredNoteOrder = validateDeepAnalysisResult({
  seal: creditSeal,
  result: result([
    criterion({
      dimension: "financial_health",
      kind: "exclusion",
      operator: "gte",
      value: {
        debt_ratio_pct_threshold: { value: 500, inclusive: true },
        impairment_excluded: ["partial", "full"],
      },
      sourceSpan: creditSourceSpan,
    }),
    criterion({
      dimension: "financial_health",
      kind: "exclusion",
      operator: "gte",
      value: {
        impairment_excluded: ["full", "partial"],
        debt_ratio_pct_threshold: { inclusive: true, value: 500 },
        note: "같은 구조화 조건에 대한 설명",
      },
      sourceSpan: creditSourceSpan,
    }),
  ], axes(["financial_health"])),
});
assert.equal(structuredNoteOrder.valid, true);
assert.equal(structuredNoteOrder.criteria.length, 1);
assert.equal(structuredNoteOrder.axisCriterionSemanticHashes.financial_health.length, 1);

const droppedRaw = result([criterion()], axes(["region"]));
(droppedRaw.rawToolInput.criteria as unknown[]).push({
  dimension: "region",
  operator: "unknown_operator",
  kind: "required",
  value: {},
  source_span: sourceSpan,
});
const dropped = validateDeepAnalysisResult({ seal, result: droppedRaw });
assert.equal(dropped.responseContractValid, false);
assert.equal(dropped.issues.some((issue) => issue.code === "normalization_drop"), true);

const unresolved = result([], axes());
unresolved.axisAssessments[0] = {
  ...unresolved.axisAssessments[0]!,
  status: "ambiguous",
};
(unresolved.rawToolInput.axis_assessments as Array<Record<string, unknown>>)[0]!.status = "ambiguous";
assert.equal(validateDeepAnalysisResult({ seal, result: unresolved }).valid, false);

console.log("deep-analysis validator tests passed");
