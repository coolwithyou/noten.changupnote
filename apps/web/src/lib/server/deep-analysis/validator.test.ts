import assert from "node:assert/strict";
import {
  CRITERION_DIMENSIONS,
  type DeepAnalysisAxisAssessment,
  type DeepAnalysisCriterion,
  type DeepAnalysisModelResult,
} from "@cunote/contracts";
import { sealDeepAnalysisInput } from "./inputManifest";
import {
  decideDeepAnalysisValidationRoute,
  validateDeepAnalysisResult,
} from "./validator";

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

const contradictoryTargetTypeValidation = validateDeepAnalysisResult({
  seal,
  result: result([criterion({
    dimension: "target_type",
    operator: "in",
    kind: "required",
    value: {
      targets: ["기업", "공공기관"],
      list_semantics: "closed",
    },
    note: "목록 밖 유형을 자동 탈락시키지 않도록 list_semantics=open으로 둔다.",
  })], axes(["target_type"])),
});
assert.equal(contradictoryTargetTypeValidation.valid, false);
assert.equal(
  contradictoryTargetTypeValidation.issues.some((issue) => (
    issue.code === "semantic_misattribution"
    && issue.path.endsWith(".value.list_semantics")
  )),
  true,
  "열린 목록이라고 설명하면서 closed 구조값을 내면 matcher 오탈락 전에 차단한다",
);

const compoundCertificationSpan =
  "방위사업법에 따라 지정된 방산업체 중 직접 연관 분야에서 방산물자 지정을 받은 중소기업 1.5%";
const compoundCertificationSeal = sealDeepAnalysisInput({
  grantId: "grant-compound-certification",
  sourceRevisionSha256: "e".repeat(64),
  structuredText: compoundCertificationSpan,
  attachments: [],
});
const compoundCertification = criterion({
  dimension: "certification",
  operator: "in",
  kind: "preferred",
  value: { certs: ["방산업체 지정", "직접 연관 분야 방산물자 지정"] },
  sourceSpan: compoundCertificationSpan,
});
const compoundCertificationValidation = validateDeepAnalysisResult({
  seal: compoundCertificationSeal,
  result: result([compoundCertification], axes(["certification"])),
});
assert.equal(compoundCertificationValidation.valid, false);
assert.equal(
  compoundCertificationValidation.issues.some((issue) => (
    issue.code === "canonical_contract_invalid"
    && issue.message.includes("certification/text_only")
  )),
  true,
  "복합 인증 AND를 OR certs로 내보내면 validator가 차단한다",
);
assert.equal(validateDeepAnalysisResult({
  seal: compoundCertificationSeal,
  result: result([{
    ...compoundCertification,
    operator: "text_only",
    value: { note: compoundCertificationSpan },
  }], axes(["certification"])),
}).valid, true, "복합 인증을 certification/text_only로 무손실 보존하면 통과한다");

const alternativeCertificationSpan = "벤처기업 또는 이노비즈 인증기업은 1점 가점";
const alternativeCertificationSeal = sealDeepAnalysisInput({
  grantId: "grant-alternative-certification",
  sourceRevisionSha256: "f".repeat(64),
  structuredText: alternativeCertificationSpan,
  attachments: [],
});
assert.equal(validateDeepAnalysisResult({
  seal: alternativeCertificationSeal,
  result: result([criterion({
    dimension: "certification",
    operator: "in",
    kind: "preferred",
    value: { certs: ["벤처기업", "이노비즈 인증기업"] },
    sourceSpan: alternativeCertificationSpan,
  })], axes(["certification"])),
}).valid, true, "명시적 OR 인증 목록은 정상 구조값으로 통과한다");
assert.equal(
  (openTargetTypeValidation.criteria[0]?.criterion.value as Record<string, unknown>).list_semantics,
  "open",
);

const industryBoundaryText = [
  "ㅇ 모집직무 : 경영·사무 / 광고·마케팅 / IT",
  "경영·사무 / 광고·마케팅 / IT 분야 고용보험 피보험자수 20인 이상 기업",
  "정보통신업을 영위하는 중소기업만 신청할 수 있다.",
].join("\n");
const industryBoundarySeal = sealDeepAnalysisInput({
  grantId: "grant-industry-boundary",
  sourceRevisionSha256: "d".repeat(64),
  structuredText: industryBoundaryText,
  attachments: [],
});
const explicitJobField = criterion({
  dimension: "industry",
  operator: "in",
  value: { tags: ["IT"] },
  sourceSpan: "ㅇ 모집직무 : 경영·사무 / 광고·마케팅 / IT",
});
const explicitJobFieldValidation = validateDeepAnalysisResult({
  seal: industryBoundarySeal,
  result: result([explicitJobField], axes(["industry"])),
});
assert.equal(explicitJobFieldValidation.valid, false);
assert.equal(
  explicitJobFieldValidation.issues.some((issue) => (
    issue.code === "non_matching_criterion"
    && issue.message.includes("job/placement field")
  )),
  true,
);

const unresolvedIndustryJobField = criterion({
  dimension: "industry",
  operator: "text_only",
  value: {
    note: "기업 업종 요건인지 청년 배치 직무분야인지 원문상 확정되지 않는다.",
  },
  sourceSpan: "경영·사무 / 광고·마케팅 / IT 분야 고용보험 피보험자수 20인 이상 기업",
});
const unresolvedIndustryJobValidation = validateDeepAnalysisResult({
  seal: industryBoundarySeal,
  result: result([unresolvedIndustryJobField], axes(["industry"])),
});
assert.equal(unresolvedIndustryJobValidation.valid, false);
assert.equal(
  unresolvedIndustryJobValidation.issues.some((issue) => (
    issue.code === "non_matching_criterion"
    && issue.message.includes("industry-vs-job-field")
  )),
  true,
);

const actualIndustry = criterion({
  dimension: "industry",
  operator: "in",
  value: { tags: ["정보통신업"] },
  sourceSpan: "정보통신업을 영위하는 중소기업만 신청할 수 있다.",
});
assert.equal(validateDeepAnalysisResult({
  seal: industryBoundarySeal,
  result: result([actualIndustry], axes(["industry"])),
}).valid, true, "명시적인 신청기업 업종 자격은 보존한다");

const locationTenureSpan = "☞ 영천시 소재 1년 이상, 종사자 수 20인 미만 제조 중소기업";
const locationTenureSeal = sealDeepAnalysisInput({
  grantId: "grant-location-tenure",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: locationTenureSpan,
  attachments: [],
});
const misattributedBusinessAge = validateDeepAnalysisResult({
  seal: locationTenureSeal,
  result: result([
    criterion({
      dimension: "biz_age",
      operator: "gte",
      value: { min_months: 12 },
      sourceSpan: locationTenureSpan,
    }),
  ], axes(["biz_age"])),
});
assert.equal(misattributedBusinessAge.valid, false, "소재 기간을 업력으로 추론할 수 없다");
assert.equal(
  misattributedBusinessAge.issues.some((issue) => (
    issue.code === "semantic_misattribution"
    && issue.message.includes("premises/text_only")
  )),
  true,
  "소재 기간의 올바른 축과 biz_age 제거 방법을 repair feedback에 남긴다",
);
assert.equal(validateDeepAnalysisResult({
  seal: locationTenureSeal,
  result: result([
    criterion({
      dimension: "premises",
      operator: "text_only",
      value: { note: locationTenureSpan },
      sourceSpan: locationTenureSpan,
    }),
  ], axes(["premises"])),
}).valid, true, "소재 기간을 premises/text_only로 무손실 보존하면 통과한다");

const explicitBusinessAgeSpan = "영천시 소재 기업 중 설립 후 1년 이상인 중소기업";
const explicitBusinessAgeSeal = sealDeepAnalysisInput({
  grantId: "grant-explicit-business-age",
  sourceRevisionSha256: "b".repeat(64),
  structuredText: explicitBusinessAgeSpan,
  attachments: [],
});
assert.equal(validateDeepAnalysisResult({
  seal: explicitBusinessAgeSeal,
  result: result([
    criterion({
      dimension: "biz_age",
      operator: "gte",
      value: { min_months: 12 },
      sourceSpan: explicitBusinessAgeSpan,
    }),
  ], axes(["biz_age"])),
}).valid, true, "별도의 설립 기간 근거가 명시된 실제 업력 조건은 보존한다");

const serviceRegionSpan = "지원지역: 대구";
const serviceRegionSeal = sealDeepAnalysisInput({
  grantId: "grant-service-region-metadata",
  sourceRevisionSha256: "6".repeat(64),
  structuredText: `${serviceRegionSpan} (source_field: supt_regin)`,
  attachments: [],
});
const serviceRegionValidation = validateDeepAnalysisResult({
  seal: serviceRegionSeal,
  result: result([
    criterion({
      dimension: "region",
      operator: "in",
      kind: "required",
      value: { regions: ["27"] },
      sourceSpan: serviceRegionSpan,
    }),
  ], axes(["region"])),
});
assert.equal(serviceRegionValidation.valid, false, "포털 지원지역만으로 신청기업 소재지를 제한할 수 없다");
assert.equal(
  serviceRegionValidation.issues.some((issue) => (
    issue.code === "semantic_misattribution" && issue.message.includes("supt_regin")
  )),
  true,
);

const collaborationThemeSpan =
  "참여기업 및 모집분야: 토스뱅크 포용금융, 현대홈쇼핑 혁신소재·기술 협업, 기타 협업 가능한 비즈니스";
const collaborationThemeSeal = sealDeepAnalysisInput({
  grantId: "grant-collaboration-theme",
  sourceRevisionSha256: "5".repeat(64),
  structuredText: collaborationThemeSpan,
  attachments: [],
});
const collaborationThemeValidation = validateDeepAnalysisResult({
  seal: collaborationThemeSeal,
  result: result([
    criterion({
      dimension: "industry",
      operator: "text_only",
      kind: "required",
      value: { note: "수요기업별 협업 제안 주제" },
      sourceSpan: collaborationThemeSpan,
    }),
  ], axes(["industry"])),
});
assert.equal(collaborationThemeValidation.valid, false, "협업 모집 주제는 신청기업 업종이 아니다");
assert.equal(
  collaborationThemeValidation.issues.some((issue) => (
    issue.code === "non_matching_criterion" && issue.message.includes("collaboration theme")
  )),
  true,
);

const alternativeApplicantSpan =
  "서울창업허브 창동 입주기업, 1인 창조기업, 졸업기업 및 기타 예비·초기 창업기업";
const alternativeApplicantSeal = sealDeepAnalysisInput({
  grantId: "grant-alternative-applicant-path",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: alternativeApplicantSpan,
  attachments: [],
});
const alternativeApplicantValidation = validateDeepAnalysisResult({
  seal: alternativeApplicantSeal,
  result: result([
    criterion({
      dimension: "target_type",
      operator: "in",
      kind: "required",
      value: {
        targets: ["서울창업허브 창동 입주기업", "1인 창조기업", "졸업기업", "예비·초기 창업기업"],
        list_semantics: "closed",
      },
      sourceSpan: alternativeApplicantSpan,
    }),
    criterion({
      dimension: "premises",
      operator: "text_only",
      kind: "required",
      value: { note: "서울창업허브 창동 입주기업" },
      sourceSpan: "서울창업허브 창동 입주기업",
    }),
    criterion({
      dimension: "biz_age",
      operator: "text_only",
      kind: "required",
      value: { note: "예비·초기 창업기업" },
      sourceSpan: "예비·초기 창업기업",
    }),
  ], axes(["target_type", "premises", "biz_age"])),
});
assert.deepEqual(
  alternativeApplicantValidation.issues
    .filter((issue) => issue.code === "semantic_misattribution")
    .map((issue) => issue.path),
  ["$.criteria[1]", "$.criteria[2]"],
  "OR 신청대상 중 입주·창업단계 한 경로를 전역 필수조건으로 분리할 수 없다",
);

const businessOrCreatorSpan =
  "콘텐츠 제작 사업자 또는 주민등록상 제주특별자치도에 거주하는 개인 창작자";
const businessOrCreatorSeal = sealDeepAnalysisInput({
  grantId: "grant-business-or-creator",
  sourceRevisionSha256: "b".repeat(64),
  structuredText: businessOrCreatorSpan,
  attachments: [],
});
const businessOrCreatorValidation = validateDeepAnalysisResult({
  seal: businessOrCreatorSeal,
  result: result([
    criterion({
      dimension: "industry",
      operator: "in",
      kind: "required",
      value: { tags: ["콘텐츠 제작업"] },
      sourceSpan: businessOrCreatorSpan,
    }),
  ], axes(["industry"])),
});
assert.equal(
  businessOrCreatorValidation.issues.some((issue) => (
    issue.code === "semantic_misattribution" && issue.message.includes("business-or-individual")
  )),
  true,
  "사업자 OR 개인 창작자 경로의 업종을 개인에게 전역 적용할 수 없다",
);

const certificateCheckSpan =
  "외국인이 업주인 경우 사후 유지관리의무 2년 준수여부 확인을 위하여 외국인증명서의 유효기간 등을 확인함";
const certificateCheckSeal = sealDeepAnalysisInput({
  grantId: "grant-certificate-check",
  sourceRevisionSha256: "4".repeat(64),
  structuredText: certificateCheckSpan,
  attachments: [],
});
const certificateCheckValidation = validateDeepAnalysisResult({
  seal: certificateCheckSeal,
  result: result([
    criterion({
      dimension: "founder_trait",
      operator: "text_only",
      kind: "required",
      value: { note: certificateCheckSpan },
      sourceSpan: certificateCheckSpan,
    }),
  ], axes(["founder_trait"])),
});
assert.equal(certificateCheckValidation.valid, false, "판정 기준 없는 증명서 확인 절차는 대표자 자격이 아니다");
assert.equal(
  certificateCheckValidation.issues.some((issue) => (
    issue.code === "semantic_misattribution" && issue.message.includes("application procedure")
  )),
  true,
);

const priorAwardCalendarSpan =
  "동일(유사) 아이템으로 ’20∼’25년도 물산업 창업대전 또는 ’26년도 타 기관 창업경진대회 수상자는 제외한다. 단, ’26년도 AX 아이디어 경진대회 물 관련 수상자는 참가할 수 있다.";
const priorAwardCalendarSeal = sealDeepAnalysisInput({
  grantId: "grant-prior-award-calendar-scope",
  sourceRevisionSha256: "3".repeat(64),
  structuredText: priorAwardCalendarSpan,
  attachments: [],
});
const lossyPriorAwardValidation = validateDeepAnalysisResult({
  seal: priorAwardCalendarSeal,
  result: result([
    criterion({
      dimension: "prior_award",
      operator: "in",
      kind: "exclusion",
      value: {
        scope: "program",
        programs: ["물산업 창업대전", "타 기관 창업경진대회"],
        states: ["completed"],
      },
      sourceSpan: priorAwardCalendarSpan,
    }),
  ], axes(["prior_award"])),
});
assert.equal(lossyPriorAwardValidation.valid, false, "달력연도·동일아이템·대회 예외를 programs만으로 축약할 수 없다");
assert.equal(
  lossyPriorAwardValidation.issues.some((issue) => (
    issue.code === "canonical_contract_invalid" && issue.message.includes("calendar-year scope")
  )),
  true,
);

const highRiskExclusionSpan =
  "참여제한: 협약예정일 기준 연구개발기관 등이 부도 및 금융기관 등의 채무 불이행 중이거나, 최근 재무제표 부채비율이 1,000% 이상이거나 완전자본 잠식상태인 경우. 단, 관리규정에 따른 예외 인정.";
const highRiskExclusionSeal = sealDeepAnalysisInput({
  grantId: "grant-high-risk-exclusion-gap",
  sourceRevisionSha256: "2".repeat(64),
  structuredText: highRiskExclusionSpan,
  attachments: [],
});
const highRiskExclusionValidation = validateDeepAnalysisResult({
  seal: highRiskExclusionSeal,
  result: result([], axes()),
});
assert.equal(highRiskExclusionValidation.valid, false, "명시적 신용·재무 결격을 빈 축으로 통과시킬 수 없다");
assert.deepEqual(
  new Set(highRiskExclusionValidation.issues
    .filter((issue) => issue.code === "high_risk_condition_gap")
    .map((issue) => issue.path)),
  new Set(["$.criteria.credit_status", "$.criteria.financial_health"]),
);
const lossyFinancialException = validateDeepAnalysisResult({
  seal: highRiskExclusionSeal,
  result: result([
    criterion({
      dimension: "credit_status",
      operator: "in",
      kind: "exclusion",
      value: { flags: ["bond_default", "loan_default"] },
      sourceSpan: highRiskExclusionSpan,
    }),
    criterion({
      dimension: "financial_health",
      operator: "gte",
      kind: "exclusion",
      value: {
        debt_ratio_pct_threshold: { value: 1_000, inclusive: true },
        impairment_excluded: ["full"],
      },
      sourceSpan: highRiskExclusionSpan,
    }),
  ], axes(["credit_status", "financial_health"])),
});
assert.equal(
  lossyFinancialException.issues.some((issue) => (
    issue.code === "high_risk_condition_gap" && issue.path === "$.criteria.financial_health"
  )),
  true,
  "비정형 규정 예외를 버린 구조화 재무결격은 통과할 수 없다",
);
const losslessHighRiskExclusion = validateDeepAnalysisResult({
  seal: highRiskExclusionSeal,
  result: result([
    criterion({
      dimension: "credit_status",
      operator: "text_only",
      kind: "exclusion",
      value: { note: highRiskExclusionSpan },
      sourceSpan: highRiskExclusionSpan,
    }),
    criterion({
      dimension: "financial_health",
      operator: "text_only",
      kind: "exclusion",
      value: { note: highRiskExclusionSpan },
      sourceSpan: highRiskExclusionSpan,
    }),
  ], axes(["credit_status", "financial_health"])),
});
assert.equal(
  losslessHighRiskExclusion.valid,
  true,
  `신용·재무 결격과 비정형 예외를 text_only로 무손실 보존하면 통과한다: ${JSON.stringify(losslessHighRiskExclusion.issues)}`,
);

const itemPurposeSpan = "신청 제외대상: 본 대회 추진 목적에 부합되지 않는 아이템";
const itemPurposeSeal = sealDeepAnalysisInput({
  grantId: "grant-item-purpose-gap",
  sourceRevisionSha256: "1".repeat(64),
  structuredText: itemPurposeSpan,
  attachments: [],
});
const itemPurposeGap = validateDeepAnalysisResult({
  seal: itemPurposeSeal,
  result: result([], axes()),
});
assert.equal(
  itemPurposeGap.issues.some((issue) => (
    issue.code === "high_risk_condition_gap" && issue.path === "$.criteria.other"
  )),
  true,
  "명시적 아이템 목적 부합 제외조건은 other/text_only로 보존해야 한다",
);
assert.equal(validateDeepAnalysisResult({
  seal: itemPurposeSeal,
  result: result([
    criterion({
      dimension: "other",
      operator: "text_only",
      kind: "exclusion",
      value: { note: itemPurposeSpan },
      sourceSpan: itemPurposeSpan,
    }),
  ], axes(["other"])),
}).valid, true, "아이템 목적 제외조건을 명시적으로 보존하면 통과한다");

const businessAgeEligibilitySpan = "사업자가 공고일 기준 설립일로부터 만 7년 이내인 국내 창업기업이다.";
const businessAgeScoringSpan =
  "입주신청일 기준 창업일: 3년 이내 20점, 3년 초과 5년 이내 10점, 5년 초과 7년 이내 5점";
const businessAgeScoringSeal = sealDeepAnalysisInput({
  grantId: "grant-business-age-ranking-gap",
  sourceRevisionSha256: "0".repeat(64),
  structuredText: `${businessAgeEligibilitySpan}\n${businessAgeScoringSpan}`,
  attachments: [],
});
const businessAgeRankingGap = validateDeepAnalysisResult({
  seal: businessAgeScoringSeal,
  result: result([
    criterion({
      dimension: "biz_age",
      operator: "lte",
      kind: "required",
      value: { max_months: 84 },
      sourceSpan: businessAgeEligibilitySpan,
      note: businessAgeScoringSpan,
    }),
  ], axes(["biz_age"])),
});
assert.equal(
  businessAgeRankingGap.issues.some((issue) => (
    issue.code === "high_risk_condition_gap" && issue.path === "$.criteria.biz_age"
  )),
  true,
  "필수 업력 상한 note에 배점 구간을 합쳐 preferred 추출을 생략할 수 없다",
);
const separatedBusinessAgeRanking = validateDeepAnalysisResult({
  seal: businessAgeScoringSeal,
  result: result([
    criterion({
      dimension: "biz_age",
      operator: "lte",
      kind: "required",
      value: { max_months: 84 },
      sourceSpan: businessAgeEligibilitySpan,
    }),
    criterion({
      dimension: "biz_age",
      operator: "lte",
      kind: "preferred",
      value: { max_months: 36 },
      sourceSpan: businessAgeScoringSpan,
      note: "3년 이내 20점",
    }),
    criterion({
      dimension: "biz_age",
      operator: "between",
      kind: "preferred",
      value: { min_months: 37, max_months: 60 },
      sourceSpan: businessAgeScoringSpan,
      note: "3년 초과 5년 이내 10점",
    }),
    criterion({
      dimension: "biz_age",
      operator: "between",
      kind: "preferred",
      value: { min_months: 61, max_months: 84 },
      sourceSpan: businessAgeScoringSpan,
      note: "5년 초과 7년 이내 5점",
    }),
  ], axes(["biz_age"])),
});
assert.equal(
  separatedBusinessAgeRanking.valid,
  true,
  `필수 업력과 preferred 배점 구간을 분리하면 통과한다: ${JSON.stringify(separatedBusinessAgeRanking.issues)}`,
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

const performerOnlySpan = "- 참여기관 : 정부출연연구기관, 대학 등";
const performerOnlySeal = sealDeepAnalysisInput({
  grantId: "grant-performer-only",
  sourceRevisionSha256: "a".repeat(64),
  structuredText: performerOnlySpan,
  attachments: [],
});
const performerStructured = validateDeepAnalysisResult({
  seal: performerOnlySeal,
  result: result([
    criterion({
      dimension: "target_type",
      operator: "in",
      kind: "required",
      value: { targets: ["정부출연연구기관", "대학"], list_semantics: "open" },
      sourceSpan: performerOnlySpan,
      note: "주관기관은 기업이며, 여기 열거된 유형은 컨소시엄 참여기관의 유형 요건이다.",
    }),
  ], axes(["target_type"])),
});
assert.equal(performerStructured.valid, false, "참여기관 유형을 신청기업 target_type으로 전역화할 수 없다");
assert.equal(
  performerStructured.issues.some((issue) => (
    issue.code === "semantic_misattribution"
    && issue.message.includes("actor/track scope")
  )),
  true,
  "역할 범위 손실을 validator가 구체적으로 차단한다",
);
assert.equal(validateDeepAnalysisResult({
  seal: performerOnlySeal,
  result: result([
    criterion({
      dimension: "other",
      operator: "text_only",
      kind: "required",
      value: { note: "참여기관은 정부출연연구기관, 대학 등이어야 한다." },
      sourceSpan: performerOnlySpan,
    }),
  ], axes(["other"])),
}).valid, true, "역할을 명시한 other/text_only는 안전하게 보존한다");

const leadApplicantSanctionSpan = "주관기관이 현재 정부지원사업 참여제한 조치 중이면 신청할 수 없다.";
const mixedApplicantRolesSpan = "주관기관과 참여기관은 공동으로 과제를 수행한다.";
const leadApplicantSanctionSeal = sealDeepAnalysisInput({
  grantId: "grant-lead-applicant-sanction",
  sourceRevisionSha256: "f".repeat(64),
  structuredText: `${leadApplicantSanctionSpan}\n${mixedApplicantRolesSpan}`,
  attachments: [],
});
const leadApplicantSanction = validateDeepAnalysisResult({
  seal: leadApplicantSanctionSeal,
  result: result([
    criterion({
      dimension: "sanction",
      operator: "in",
      kind: "exclusion",
      value: { flags: ["participation_restricted"] },
      sourceSpan: leadApplicantSanctionSpan,
    }),
    criterion({
      dimension: "other",
      operator: "text_only",
      kind: "required",
      value: { note: mixedApplicantRolesSpan },
      sourceSpan: mixedApplicantRolesSpan,
    }),
  ], axes(["sanction", "other"])),
});
assert.equal(
  leadApplicantSanction.issues.some((issue) => (
    issue.code === "semantic_misattribution" && issue.message.includes("actor/track scope")
  )),
  false,
  "주관기관은 주관기업과 같은 신청 주체이므로 역할 분리 공고에서도 전역 오귀속이 아니다",
);

const roleDuplicateBeneficiarySpan = "수혜기업 : 광주광역시 소재 기업";
const roleDuplicateProviderSpan = "디자인기업 : 광주광역시 소재 기업";
const roleDuplicateSeal = sealDeepAnalysisInput({
  grantId: "grant-role-duplicate",
  sourceRevisionSha256: "b".repeat(64),
  structuredText: `${roleDuplicateBeneficiarySpan}\n${roleDuplicateProviderSpan}`,
  attachments: [],
});
const roleDuplicate = validateDeepAnalysisResult({
  seal: roleDuplicateSeal,
  result: result([
    criterion({
      dimension: "region",
      operator: "in",
      kind: "required",
      value: { regions: ["29"] },
      sourceSpan: roleDuplicateBeneficiarySpan,
      note: "수혜기업 소재지",
    }),
    criterion({
      dimension: "region",
      operator: "in",
      kind: "required",
      value: { regions: ["29"] },
      sourceSpan: roleDuplicateProviderSpan,
      note: "디자인기업 소재지",
    }),
  ], axes(["region"])),
});
assert.equal(roleDuplicate.valid, false, "역할별 동일 값은 의미 중복으로 조용히 합치지 않는다");
assert.equal(
  roleDuplicate.issues.some((issue) => (
    issue.code === "semantic_duplicate"
    && issue.message.includes("different applicant/beneficiary/provider roles")
  )),
  true,
);

for (const testCase of [
  {
    label: "부채비율 이상 방향을 lte로 뒤집음",
    dimension: "financial_health" as const,
    operator: "lte" as const,
    value: { debt_ratio_pct_threshold: { value: 500, inclusive: true } },
    span: "부채비율이 500% 이상인 기업",
    message: "requires operator=gte",
  },
  {
    label: "복합 재무조건을 부채비율만 구조화",
    dimension: "financial_health" as const,
    operator: "gte" as const,
    value: { debt_ratio_pct_threshold: { value: 500, inclusive: true } },
    span: "최근 2년 결산 재무제표상 부채비율이 연속 500% 이상 또는 유동비율이 연속 50% 이하인 기업(단, 신용평가등급 BBB 이상은 예외)",
    message: "not losslessly representable",
  },
  {
    label: "과거 수혜 이력을 현재 유사지원으로 축소",
    dimension: "prior_award" as const,
    operator: "exists" as const,
    value: { scope: "self", self_kind: "current_similar", channel: "general" },
    span: "타 기관에서 유사사업으로 수혜 이력이 있는 경우",
    message: "cannot be narrowed to current_similar",
  },
  {
    label: "여성 종업원 비율을 대표자 특성으로 오귀속",
    dimension: "founder_trait" as const,
    operator: "in" as const,
    value: { traits: ["여성 종업원 20% 이상 기업"] },
    span: "여성 종업원 20% 이상인 기업 우대",
    message: "not a founder trait",
  },
] as const) {
  const scopedSeal = sealDeepAnalysisInput({
    grantId: `grant-structural-${testCase.dimension}`,
    sourceRevisionSha256: "c".repeat(64),
    structuredText: testCase.span,
    attachments: [],
  });
  const validation = validateDeepAnalysisResult({
    seal: scopedSeal,
    result: result([
      criterion({
        dimension: testCase.dimension,
        operator: testCase.operator,
        kind: testCase.dimension === "founder_trait" ? "preferred" : "exclusion",
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
    `${testCase.label}은 구체적 구조 손실 issue를 남긴다`,
  );
}

const ambiguousParticipationSpan = "리빙랩 프로젝트 참여자(사) 우대";
const ambiguousParticipationSeal = sealDeepAnalysisInput({
  grantId: "grant-ambiguous-participation",
  sourceRevisionSha256: "d".repeat(64),
  structuredText: ambiguousParticipationSpan,
  attachments: [],
});
assert.equal(validateDeepAnalysisResult({
  seal: ambiguousParticipationSeal,
  result: result([
    criterion({
      dimension: "prior_award",
      operator: "in",
      kind: "preferred",
      value: {
        scope: "program",
        programs: ["리빙랩 프로젝트"],
        states: ["participating"],
      },
      sourceSpan: ambiguousParticipationSpan,
    }),
  ], axes(["prior_award"])),
}).valid, false, "현재라는 근거 없는 참여자 이력을 participating으로만 축소할 수 없다");
assert.equal(validateDeepAnalysisResult({
  seal: ambiguousParticipationSeal,
  result: result([
    criterion({
      dimension: "prior_award",
      operator: "in",
      kind: "preferred",
      value: {
        scope: "program",
        programs: ["리빙랩 프로젝트"],
        states: ["participating", "completed"],
      },
      sourceSpan: ambiguousParticipationSpan,
    }),
  ], axes(["prior_award"])),
}).valid, true, "참여 중과 과거 참여를 함께 보존한 상태 범위는 통과한다");

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
const currentPremisesAlternativeSpan =
  "본사가 관외에 소재한 경우에도 성능개선 대상 공장이 안산시 관내에 소재하면 신청 가능";
const currentPremisesAlternativeSeal = sealDeepAnalysisInput({
  grantId: "grant-current-premises-alternative",
  sourceRevisionSha256: "e".repeat(64),
  structuredText: currentPremisesAlternativeSpan,
  attachments: [],
});
const unsafeCurrentPremisesRegion = validateDeepAnalysisResult({
  seal: currentPremisesAlternativeSeal,
  result: result([
    criterion({
      dimension: "region",
      operator: "in",
      kind: "required",
      value: { regions: ["41"] },
      sourceSpan: currentPremisesAlternativeSpan,
    }),
  ], axes(["region"])),
});
assert.equal(unsafeCurrentPremisesRegion.valid, false, "본사 밖·대상공장 관내 대안을 본사 region으로 선차단할 수 없다");
assert.equal(
  unsafeCurrentPremisesRegion.issues.some((issue) => (
    issue.code === "canonical_contract_invalid"
    && issue.message.includes("current premises alternative")
  )),
  true,
);
assert.equal(validateDeepAnalysisResult({
  seal: currentPremisesAlternativeSeal,
  result: result([
    criterion({
      dimension: "region",
      operator: "text_only",
      kind: "required",
      value: { note: currentPremisesAlternativeSpan },
      sourceSpan: currentPremisesAlternativeSpan,
    }),
  ], axes(["region"])),
}).valid, true, "본사·대상공장 OR 경로를 보존한 region/text_only는 통과한다");

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
const unresolvedValidation = validateDeepAnalysisResult({ seal, result: unresolved });
assert.equal(unresolvedValidation.valid, false);
assert.equal(
  decideDeepAnalysisValidationRoute({ result: unresolved, validation: unresolvedValidation }).route,
  "hold",
  "실제 ambiguous만 남으면 모델 오류가 아니라 hold",
);
assert.equal(
  decideDeepAnalysisValidationRoute({
    result: result([criterion()], axes(["region"])),
    validation: valid,
  }).route,
  "accept",
);

const mixedUnresolved = result([], axes());
mixedUnresolved.axisAssessments[0] = {
  ...mixedUnresolved.axisAssessments[0]!,
  status: "input_missing",
};
(mixedUnresolved.rawToolInput.axis_assessments as Array<Record<string, unknown>>)[0]!.status = "input_missing";
(mixedUnresolved.rawToolInput.criteria as Array<Record<string, unknown>>).push({
  dimension: "region",
  operator: "unknown_operator",
  kind: "required",
  value: {},
  source_span: sourceSpan,
});
const mixedValidation = validateDeepAnalysisResult({ seal, result: mixedUnresolved });
assert.equal(
  decideDeepAnalysisValidationRoute({ result: mixedUnresolved, validation: mixedValidation }).route,
  "repair",
  "hold와 실제 응답 계약 오류가 섞이면 repair 우선",
);

const malformedUnresolvedValidation = {
  ...unresolvedValidation,
  issues: unresolvedValidation.issues.map((issue, index) => index === 0
    ? { ...issue, path: "$.axis_assessments.unknown_axis" }
    : issue),
};
assert.equal(
  decideDeepAnalysisValidationRoute({
    result: unresolved,
    validation: malformedUnresolvedValidation,
  }).route,
  "repair",
  "해석 불가능한 unresolved path는 fail-closed repair",
);

const partiallyKnown = result([criterion()], axes(["region"]));
partiallyKnown.axisAssessments[0] = {
  ...partiallyKnown.axisAssessments[0]!,
  status: "input_missing",
  comment: "확정 지역 요건은 있으나 추가 상세 첨부가 누락됨",
};
(partiallyKnown.rawToolInput.axis_assessments as Array<Record<string, unknown>>)[0]!.status = "input_missing";
const partiallyKnownValidation = validateDeepAnalysisResult({ seal, result: partiallyKnown });
assert.deepEqual(
  new Set(partiallyKnownValidation.issues.map((issue) => issue.code)),
  new Set(["axis_criterion_mismatch", "unresolved_axis"]),
);
assert.equal(
  decideDeepAnalysisValidationRoute({
    result: partiallyKnown,
    validation: partiallyKnownValidation,
  }).route,
  "hold",
  "같은 축의 확정 criterion과 추가 입력 누락은 전체 재생성 없이 hold",
);

console.log("deep-analysis validator tests passed");
