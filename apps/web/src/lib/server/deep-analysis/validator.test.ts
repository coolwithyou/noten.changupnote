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

const nonCanonicalTargetType = criterion({
  dimension: "target_type",
  operator: "text_only",
  kind: "required",
  value: { note: "공동대표 전원이 신청자격을 충족해야 한다." },
});
const nonCanonicalTargetTypeValidation = validateDeepAnalysisResult({
  seal,
  result: result([nonCanonicalTargetType], axes(["target_type"])),
});
assert.equal(nonCanonicalTargetTypeValidation.valid, false);
assert.equal(
  nonCanonicalTargetTypeValidation.issues.some((issue) => (
    issue.code === "canonical_contract_invalid"
    && issue.message.includes("use other/text_only for non-type rules")
  )),
  true,
);

const openTargetTypeValidation = validateDeepAnalysisResult({
  seal,
  result: result([criterion({
    dimension: "target_type",
    operator: "in",
    kind: "required",
    value: { targets: ["기업", "공공기관"], list_semantics: "open" },
  })], axes(["target_type"])),
});
assert.equal(openTargetTypeValidation.valid, true);
assert.equal(
  (openTargetTypeValidation.criteria[0]?.criterion.value as Record<string, unknown>).list_semantics,
  "open",
);

const invalidTargetTypeListSemanticsValidation = validateDeepAnalysisResult({
  seal,
  result: result([criterion({
    dimension: "target_type",
    operator: "in",
    kind: "required",
    value: { targets: ["기업"], list_semantics: "examples" },
  })], axes(["target_type"])),
});
assert.equal(invalidTargetTypeListSemanticsValidation.valid, false);
assert.equal(
  invalidTargetTypeListSemanticsValidation.issues.some((issue) => (
    issue.code === "canonical_contract_invalid"
    && issue.path.endsWith(".value.list_semantics")
  )),
  true,
);

const startupEligibilityPhrase =
  "부산지역 예비 · 초기 창업패키지 및 창업중심대학에 선정된 예비창업자 및 초기창업자";
const startupDuplicateSeal = sealDeepAnalysisInput({
  grantId: "grant-startup-stage-duplicate",
  sourceRevisionSha256: "e".repeat(64),
  structuredText: [
    `${startupEligibilityPhrase} 중 17개 팀`,
    `신청자격 : ${startupEligibilityPhrase}`,
  ].join("\n"),
  attachments: [],
});
const startupPriorAward = criterion({
  dimension: "prior_award",
  operator: "in",
  kind: "required",
  value: {
    scope: "program",
    programs: ["예비창업패키지", "초기창업패키지", "창업중심대학"],
    states: ["completed"],
  },
  sourceSpan: `${startupEligibilityPhrase} 중 17개 팀`,
});
const duplicateStartupTarget = criterion({
  dimension: "target_type",
  operator: "in",
  kind: "required",
  value: { targets: ["예비창업자", "초기창업자"] },
  sourceSpan: `신청자격 : ${startupEligibilityPhrase}`,
});
const startupDuplicateValidation = validateDeepAnalysisResult({
  seal: startupDuplicateSeal,
  result: result(
    [startupPriorAward, duplicateStartupTarget],
    axes(["prior_award", "target_type"]),
  ),
});
assert.equal(startupDuplicateValidation.valid, false);
assert.equal(
  startupDuplicateValidation.issues.some((issue) => (
    issue.code === "semantic_duplicate"
    && issue.path === "$.criteria[1]"
    && issue.message.includes("Keep prior_award")
  )),
  true,
);

const standaloneStartupTargetSpan = "예비창업자만 신청 가능";
const standaloneStartupTargetSeal = sealDeepAnalysisInput({
  grantId: "grant-standalone-startup-stage",
  sourceRevisionSha256: "f".repeat(64),
  structuredText: standaloneStartupTargetSpan,
  attachments: [],
});
assert.equal(validateDeepAnalysisResult({
  seal: standaloneStartupTargetSeal,
  result: result([
    criterion({
      dimension: "target_type",
      operator: "in",
      kind: "required",
      value: { targets: ["예비창업자"] },
      sourceSpan: standaloneStartupTargetSpan,
    }),
  ], axes(["target_type"])),
}).valid, true, "독립적으로 명시된 예비창업자 신청조건은 target_type으로 유지한다");

const independentStageRulesSeal = sealDeepAnalysisInput({
  grantId: "grant-independent-stage-rules",
  sourceRevisionSha256: "2".repeat(64),
  structuredText: [
    "초기창업패키지 선정기업이어야 한다.",
    standaloneStartupTargetSpan,
  ].join("\n"),
  attachments: [],
});
assert.equal(validateDeepAnalysisResult({
  seal: independentStageRulesSeal,
  result: result([
    criterion({
      ...startupPriorAward,
      value: {
        scope: "program",
        programs: ["초기창업패키지"],
        states: ["completed"],
      },
      sourceSpan: "초기창업패키지 선정기업이어야 한다.",
    }),
    criterion({
      ...duplicateStartupTarget,
      value: { targets: ["예비창업자"] },
      sourceSpan: standaloneStartupTargetSpan,
    }),
  ], axes(["prior_award", "target_type"])),
}).valid, true, "한 공고 안에서도 서로 다른 문장의 prior_award와 창업단계 조건은 유지한다");

const studentTargetSpan = "대학생 또는 대학원생만 신청 가능";
const studentTargetSeal = sealDeepAnalysisInput({
  grantId: "grant-student-target",
  sourceRevisionSha256: "1".repeat(64),
  structuredText: studentTargetSpan,
  attachments: [],
});
assert.equal(validateDeepAnalysisResult({
  seal: studentTargetSeal,
  result: result([
    criterion({
      dimension: "target_type",
      operator: "in",
      kind: "required",
      value: { targets: ["대학생", "대학원생"] },
      sourceSpan: studentTargetSpan,
    }),
  ], axes(["target_type"])),
}).valid, true, "학생 역할 유형은 창업단계 중복 규칙의 대상이 아니다");

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

for (const testCase of [
  {
    label: "기간이 결합된 투자금 일부 구조화",
    dimension: "investment" as const,
    operator: "gte" as const,
    value: { min_total_krw: 10_000_000 },
    span: "사업 공고 마감일로부터 2년 이내(’24.8.10~’26.8.10) 투자기관으로부터 총 1천만원 이상 투자 받은 기업",
    message: "time window",
  },
  {
    label: "FIU 신고 전제를 버린 업종 배제",
    dimension: "industry" as const,
    operator: "not_in" as const,
    value: { tags: ["가상화폐 거래소업"] },
    span: "금융정보분석원의 신고·등록이 되지 않은 자(가상화폐 거래소업 등)",
    message: "registration-qualified",
  },
  {
    label: "휴업을 빠뜨린 휴폐업 배제",
    dimension: "business_status" as const,
    operator: "not_in" as const,
    value: { statuses: ["closed"], labels: ["휴폐업"] },
    span: "신청일 기준 사업자가 휴·폐업 중인 자",
    message: "suspended and closed",
  },
  {
    label: "중도포기를 빠뜨린 협약 이력",
    dimension: "prior_award" as const,
    operator: "in" as const,
    value: { scope: "program", programs: ["프리 팁스"], states: ["completed"] },
    span: "프리 팁스 사업에 선정되어 협약을 체결했던 이력이 있는 자(중단처분·중도포기자 포함)",
    message: "must omit states",
  },
  {
    label: "환수금 반환 미종결을 부정수급으로 축약",
    dimension: "sanction" as const,
    operator: "in" as const,
    value: { flags: ["subsidy_fraud"] },
    span: "창업진흥원으로부터 발생한 환수금 등의 반환이 종결되지 않은 자",
    message: "does not imply subsidy fraud",
  },
] as const) {
  const semanticSeal = sealDeepAnalysisInput({
    grantId: `grant-semantic-${testCase.dimension}`,
    sourceRevisionSha256: "7".repeat(64),
    structuredText: testCase.span,
    attachments: [],
  });
  const validation = validateDeepAnalysisResult({
    seal: semanticSeal,
    result: result([
      criterion({
        dimension: testCase.dimension,
        operator: testCase.operator,
        kind: "exclusion",
        value: testCase.value,
        sourceSpan: testCase.span,
      }),
    ], axes([testCase.dimension])),
  });
  assert.equal(validation.valid, false, `${testCase.label}은 운영 검증을 통과할 수 없다`);
  assert.equal(
    validation.issues.some((issue) => (
      issue.code === "canonical_contract_invalid"
      && issue.message.includes(testCase.message)
    )),
    true,
    `${testCase.label}은 구체적 의미 손실 issue를 남긴다`,
  );
}

const completeBusinessStatusSpan = "신청일 기준 사업자가 휴·폐업 중인 자";
const completeBusinessStatusSeal = sealDeepAnalysisInput({
  grantId: "grant-complete-business-status",
  sourceRevisionSha256: "8".repeat(64),
  structuredText: completeBusinessStatusSpan,
  attachments: [],
});
assert.equal(validateDeepAnalysisResult({
  seal: completeBusinessStatusSeal,
  result: result([
    criterion({
      dimension: "business_status",
      operator: "not_in",
      kind: "exclusion",
      value: { statuses: ["suspended", "closed"], labels: ["휴폐업"] },
      sourceSpan: completeBusinessStatusSpan,
    }),
  ], axes(["business_status"])),
}).valid, true, "휴업·폐업을 모두 보존한 status criterion은 통과한다");

const futureRegionAlternativeSpan =
  "협약체결 전까지 비수도권으로 주소지 이전 예정인 경우 확약서를 제출하여야 한다.";
const futureRegionAlternativeSeal = sealDeepAnalysisInput({
  grantId: "grant-future-region-alternative",
  sourceRevisionSha256: "9".repeat(64),
  structuredText: futureRegionAlternativeSpan,
  attachments: [],
});
const unsafeFutureRegionValidation = validateDeepAnalysisResult({
  seal: futureRegionAlternativeSeal,
  result: result([
    criterion({
      dimension: "region",
      operator: "in",
      kind: "required",
      value: { regions: ["비수도권"] },
      sourceSpan: futureRegionAlternativeSpan,
    }),
  ], axes(["region"])),
});
assert.equal(unsafeFutureRegionValidation.valid, false, "이전 예정 대안을 현재 소재지 조건으로 축약할 수 없다");
assert.equal(
  unsafeFutureRegionValidation.issues.some((issue) => (
    issue.code === "canonical_contract_invalid"
    && issue.message.includes("future relocation alternative")
  )),
  true,
  "이전 예정 대안의 의미 손실을 결정론적으로 차단한다",
);
assert.equal(validateDeepAnalysisResult({
  seal: futureRegionAlternativeSeal,
  result: result([
    criterion({
      dimension: "region",
      operator: "text_only",
      kind: "required",
      value: { note: futureRegionAlternativeSpan },
      sourceSpan: futureRegionAlternativeSpan,
    }),
  ], axes(["region"])),
}).valid, true, "이전 기한과 확약 조건을 보존한 region/text_only는 통과한다");

for (const [label, nonMatchingSpan] of [
  ["신청 진실성 서약", "허위 또는 과장된 정보 제출 시 선정 취소 및 향후 지원 제한 등의 불이익이 있을 수 있습니다."],
  ["서류 접수 절차", "접수 마감일까지 계획서 등 제반서류를 제출 완료하지 않은 경우"],
  ["선정 후 수행 일치 의무", "지원신청서 및 계획서 내용과 수행내용이 상이할 경우"],
  ["협약 이행 의무", "협약서 등 관련 문서의 명시사항을 2회 이상 위반하거나 시정요구에 응하지 않을 경우"],
] as const) {
  const nonMatchingSeal = sealDeepAnalysisInput({
    grantId: `grant-non-matching-${label}`,
    sourceRevisionSha256: "3".repeat(64),
    structuredText: nonMatchingSpan,
    attachments: [],
  });
  const validation = validateDeepAnalysisResult({
    seal: nonMatchingSeal,
    result: result([
      criterion({
        dimension: "other",
        operator: "text_only",
        kind: "exclusion",
        value: { note: nonMatchingSpan },
        sourceSpan: nonMatchingSpan,
      }),
    ], axes(["other"])),
  });
  assert.equal(validation.valid, false, `${label}은 매칭 criterion으로 승격할 수 없다`);
  assert.equal(
    validation.issues.some((issue) => issue.code === "non_matching_criterion"),
    true,
    `${label}은 결정론적 scope issue를 남긴다`,
  );
}

const currentSanctionSpan = "허위자료 제출로 현재 정부지원사업 참여제한 중인 기업은 신청할 수 없다.";
const currentSanctionSeal = sealDeepAnalysisInput({
  grantId: "grant-current-sanction",
  sourceRevisionSha256: "4".repeat(64),
  structuredText: currentSanctionSpan,
  attachments: [],
});
assert.equal(validateDeepAnalysisResult({
  seal: currentSanctionSeal,
  result: result([
    criterion({
      dimension: "sanction",
      operator: "in",
      kind: "exclusion",
      value: { flags: ["participation_restricted"] },
      sourceSpan: currentSanctionSpan,
    }),
  ], axes(["sanction"])),
}).valid, true, "현재 참여제한 상태는 신청 시점 결격으로 보존한다");

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

const explicitDischargeExceptionCoverage = validateDeepAnalysisResult({
  seal: creditSeal,
  result: result([
    criterion({
      dimension: "credit_status",
      kind: "exclusion",
      value: {
        flags: ["loan_default"],
        exceptions: [
          "credit_debt_repaid_with_proof",
          "debt_adjustment_agreement",
          "court_plan_approved",
          "bankruptcy_discharge_confirmed",
        ],
      },
      sourceSpan: creditSourceSpan,
    }),
  ], axes(["credit_status"])),
});
assert.equal(explicitDischargeExceptionCoverage.valid, true);

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
