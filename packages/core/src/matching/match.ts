import type {
  BizAgeCriterionValue,
  CompanyProfile,
  CriterionDimension,
  CriterionResult,
  Eligibility,
  FounderAgeCriterionValue,
  GrantCriterion,
  ListCriterionValue,
  MatchReviewGate,
  MatchReviewReason,
  MatchResult,
  NextQuestion,
  RegionCriterionValue,
  RuleTraceEntry,
} from "@cunote/contracts";
import { REGION_LABELS } from "../kstartup/constants.js";
import { industryCodeMatches } from "../industry/ksic.js";
import { certsMatch } from "../certification/certs.js";

export const RULESET_VERSION = "ruleset-kstartup-spine-v2";
export const SCORING_VERSION = "scoring-fit-v2-trust-gate";

const CORE_GATE_DIMENSIONS = new Set<CriterionDimension>([
  "industry",
  "certification",
  "business_status",
  "target_type",
  "other",
]);

const HIGH_RISK_DOMAIN_PATTERN =
  /원전|원자력|SMR|핵심부품|로봇|서비스로봇|실증로봇|반도체|팹리스|바이오|의료기기|헬스케어|방산|우주|항공|해양|수소|이차전지|배터리|소부장|KEPIC|ASME|(?:최근\s*\d+\s*년.{0,24}(?:매출|실적|납품|기술개발|수행).{0,24}(?:원전|원자력|로봇|반도체|바이오|의료기기|분야))|(?:(?:매출|실적|납품|기술개발|수행).{0,24}(?:원전|원자력|로봇|반도체|바이오|의료기기|분야))/i;

export function matchGrantCriteria(
  criteria: GrantCriterion[],
  company: CompanyProfile,
): MatchResult {
  // 공고에서 구조화된 조건을 아직 추출하지 못한 경우(criteria 0건)는 적격으로 오인하지 않도록
  // 조건부(conditional)로 강등하고 적합도를 미산정(0)으로 둔다.
  if (criteria.length === 0) {
    return unstructuredCriteriaResult();
  }

  const ruleTrace = criteria.map((criterion) => evaluateCriterion(criterion, company));
  const hardFail = ruleTrace.some(
    (entry) => entry.result === "fail" && (entry.kind === "required" || entry.kind === "exclusion"),
  );
  const hasUnknown = ruleTrace.some(
    (entry) => entry.result === "unknown" && (entry.kind === "required" || entry.kind === "exclusion"),
  );
  const eligibility: Eligibility = hardFail ? "ineligible" : hasUnknown ? "conditional" : "eligible";
  const unknown_fields = unique(
    ruleTrace.filter((entry) => entry.result === "unknown").map((entry) => entry.dimension),
  );
  const reviewGate = buildReviewGate({
    eligibility,
    traceEntries: ruleTrace,
    criteria,
    criteriaExtracted: true,
  });

  const result: MatchResult = {
    eligibility,
    fit_score: scoreFit(eligibility, ruleTrace),
    rule_trace: ruleTrace,
    unknown_fields,
    ruleset_ver: RULESET_VERSION,
    scoring_ver: SCORING_VERSION,
    criteria_extracted: true,
    review_gate: reviewGate,
  };
  const question = nextQuestion(unknown_fields);
  if (question) result.next_question = question;
  return result;
}

function unstructuredCriteriaResult(): MatchResult {
  const entry: RuleTraceEntry = {
    dimension: "other",
    kind: "required",
    operator: "exists",
    result: "unknown",
    message: "공고 자격조건이 아직 구조화되지 않았어요. 원문 확인이 필요해요.",
  };
  const result: MatchResult = {
    eligibility: "conditional",
    fit_score: 0,
    rule_trace: [entry],
    unknown_fields: ["other"],
    ruleset_ver: RULESET_VERSION,
    scoring_ver: SCORING_VERSION,
    criteria_extracted: false,
    review_gate: buildReviewGate({
      eligibility: "conditional",
      traceEntries: [entry],
      criteria: [],
      criteriaExtracted: false,
    }),
  };
  const question = nextQuestion(["other"]);
  if (question) result.next_question = question;
  return result;
}

function evaluateCriterion(criterion: GrantCriterion, company: CompanyProfile): RuleTraceEntry {
  if (criterion.operator === "text_only") {
    return trace(criterion, "unknown", textOnlyMessage(criterion));
  }

  switch (criterion.dimension) {
    case "region":
      return evaluateRegion(criterion, company);
    case "biz_age":
      return evaluateBizAge(criterion, company);
    case "founder_age":
      return evaluateFounderAge(criterion, company);
    case "industry":
      return evaluateIndustry(criterion, company);
    case "size":
      return evaluateSingleValueCriterion(criterion, company.size ?? null, "sizes", "기업규모");
    case "revenue":
      return evaluateNumericCriterion(criterion, company.revenue_krw ?? null, {
        label: "매출",
        unit: "원",
        minKeys: ["min_krw", "min"],
        maxKeys: ["max_krw", "max"],
      });
    case "employees":
      return evaluateNumericCriterion(criterion, company.employees_count ?? null, {
        label: "상시근로자 수",
        unit: "명",
        minKeys: ["min"],
        maxKeys: ["max"],
      });
    case "certification":
      return evaluateCertification(criterion, company);
    case "founder_trait":
      return evaluateListCriterion(criterion, company.traits, "traits", "대표자 속성", isKnownListField(company, "founder_trait"));
    case "prior_award":
      return evaluateListCriterion(criterion, company.prior_awards, "programs", "기수혜", isKnownListField(company, "prior_award"));
    case "ip":
      return evaluateListCriterion(criterion, company.ip, "types", "지식재산", isKnownListField(company, "ip"));
    case "target_type":
      return evaluateListCriterion(criterion, company.target_types, "targets", "신청대상", isKnownListField(company, "target_type"));
    case "business_status":
      return evaluateBusinessStatus(criterion, company);
    default:
      return trace(criterion, "unknown", `${labelFor(criterion.dimension)} 조건 확인 필요`);
  }
}

function evaluateRegion(criterion: GrantCriterion, company: CompanyProfile): RuleTraceEntry {
  const value = criterion.value as RegionCriterionValue;
  const companyRegion = company.region?.code;
  if (!companyRegion) {
    return trace(criterion, "unknown", "기업 소재지 확인 필요");
  }

  const regions = value.regions ?? [];
  if (criterion.kind === "exclusion" || criterion.operator === "not_in") {
    const excluded = regions.includes(companyRegion);
    const group = value.region_group ?? value.labels?.join(", ") ?? "제외 지역";
    return trace(
      criterion,
      excluded ? "fail" : "pass",
      excluded
        ? `${group} 제외 - 귀사 ${regionLabel(companyRegion)} 해당`
        : `${group} 제외 조건 미해당 - 귀사 ${regionLabel(companyRegion)}`,
      company.region,
    );
  }

  if (value.nationwide || regions.length === 0) {
    return trace(criterion, "pass", "전국 대상", company.region);
  }

  const ok = regions.includes(companyRegion);
  return trace(
    criterion,
    ok ? "pass" : "fail",
    `${value.labels?.join(", ") ?? regions.join(", ")} 대상 - 귀사 ${regionLabel(companyRegion)}`,
    company.region,
  );
}

function evaluateBizAge(criterion: GrantCriterion, company: CompanyProfile): RuleTraceEntry {
  const value = criterion.value as BizAgeCriterionValue;
  if (company.is_preliminary && value.include_preliminary) {
    return trace(criterion, "pass", "예비창업자 허용", { is_preliminary: true });
  }

  const minMonths = value.min_months ?? null;
  const maxMonths = value.max_months ?? null;
  if (minMonths === null && maxMonths === null) {
    return trace(
      criterion,
      company.is_preliminary ? "pass" : "fail",
      value.include_preliminary ? "예비창업자 전용" : "업력 기준 확인 필요",
      { is_preliminary: company.is_preliminary ?? false },
    );
  }

  if (company.biz_age_months === null || company.biz_age_months === undefined) {
    return trace(criterion, "unknown", "업력 확인 필요");
  }

  if (minMonths !== null && company.biz_age_months < minMonths) {
    return trace(
      criterion,
      "fail",
      `${formatMonths(minMonths)} 이상 대상 - 귀사 ${formatMonths(company.biz_age_months)}`,
      { biz_age_months: company.biz_age_months, unlock_at_months: minMonths },
    );
  }

  if (maxMonths !== null && company.biz_age_months > maxMonths) {
    return trace(
      criterion,
      "fail",
      `${formatMonths(maxMonths)} 이내${value.include_preliminary ? "/예비 허용" : ""} - 귀사 ${formatMonths(company.biz_age_months)}`,
      { biz_age_months: company.biz_age_months },
    );
  }

  return trace(
    criterion,
    "pass",
    `${bizAgeBoundsLabel(minMonths, maxMonths)}${value.include_preliminary ? "/예비 허용" : ""} - 귀사 ${formatMonths(company.biz_age_months)}`,
    {
      biz_age_months: company.biz_age_months,
      ...(maxMonths !== null ? { lock_after_months: maxMonths + 1 } : {}),
    },
  );
}

function evaluateFounderAge(criterion: GrantCriterion, company: CompanyProfile): RuleTraceEntry {
  const value = criterion.value as FounderAgeCriterionValue;
  const ranges = Array.isArray(value.ranges) ? value.ranges : [];
  if (ranges.length === 0) {
    return trace(criterion, "unknown", "대표자 연령 조건 확인 필요");
  }
  if (company.founder_age === null || company.founder_age === undefined) {
    return trace(criterion, "unknown", "대표자 연령 확인 필요");
  }
  const labels = Array.isArray(value.labels) && value.labels.length > 0
    ? value.labels
    : ranges.map((range) => range.label).filter(Boolean);
  const ok = ranges.some((range) => {
    const minOk = range.min === null || range.min === undefined || company.founder_age! >= range.min;
    const maxOk = range.max === null || range.max === undefined || company.founder_age! <= range.max;
    return minOk && maxOk;
  });
  return trace(
    criterion,
    ok ? "pass" : "fail",
    `대표 ${company.founder_age}세 - 허용 구간 ${labels.join(", ") || "확인 필요"}`,
    { founder_age: company.founder_age },
  );
}

/**
 * 업종/분야 평가. criterion.value.codes(KSIC)가 있으면 회사 industry_codes와 prefix 매칭하고,
 * 라벨(industries/labels/tags)은 기존 문자열 매칭으로 fallback한다. 기존 구조화 criteria 형식
 * ({tags}, {industries,labels}, {codes,labels})을 모두 수용한다.
 */
function evaluateIndustry(criterion: GrantCriterion, company: CompanyProfile): RuleTraceEntry {
  const value = criterion.value as Record<string, unknown>;
  const known = isKnownListField(company, "industry");
  const label = "업종/분야";
  const critCodes = toStringArray(value.codes);
  const critLabels = unique([
    ...toStringArray(value.industries),
    ...toStringArray(value.labels),
    ...toStringArray(value.tags),
  ]);
  const companyLabels = company.industries ?? [];
  const companyCodes = company.industry_codes ?? [];
  const companyDisplay = companyLabels.length > 0 ? companyLabels : companyCodes;
  const requiredDisplay = critLabels.length > 0 ? critLabels : critCodes;

  if (criterion.operator === "exists") {
    const present = companyLabels.length > 0 || companyCodes.length > 0;
    if (!present && known) return trace(criterion, "fail", `기업 ${label} 없음`, companyLabels);
    return trace(
      criterion,
      present ? "pass" : "unknown",
      present ? `${label} 보유 확인 - 귀사 ${companyDisplay.join(", ")}` : `기업 ${label} 입력 필요`,
      present ? companyDisplay : undefined,
    );
  }

  if (critCodes.length === 0 && critLabels.length === 0) {
    return trace(criterion, "unknown", `${label} 조건 확인 필요`);
  }

  if (companyLabels.length === 0 && companyCodes.length === 0) {
    if (!known) return trace(criterion, "unknown", `기업 ${label} 입력 필요`);
    return trace(
      criterion,
      criterion.operator === "not_in" || criterion.kind === "exclusion" ? "pass" : "fail",
      `${label} ${requiredDisplay.join(", ")} - 귀사 해당 없음`,
      companyLabels,
    );
  }

  const codeHit = critCodes.length > 0 && industryCodeMatches(critCodes, companyCodes);
  const labelHit = critLabels.length > 0 && critLabels.some((entry) => companyLabels.includes(entry));
  const overlaps = codeHit || labelHit;
  const matched = criterion.operator === "not_in" ? !overlaps : overlaps;
  const result = criterion.kind === "exclusion" && criterion.operator !== "not_in" ? !matched : matched;
  return trace(
    criterion,
    result ? "pass" : "fail",
    `${label} ${requiredDisplay.join(", ")} - 귀사 ${companyDisplay.join(", ")}`,
    companyDisplay,
  );
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

/**
 * 인증 평가 — 공고 요구 인증과 기업 보유 인증을 canonical 교집합(certsMatch)으로 비교한다.
 * 회사 "여성기업확인서"·"벤처기업, 이노비즈"(자유텍스트) vs 공고 "여성기업"·"벤처기업"(canonical) 을 정합시킨다.
 * 요구 인증은 여러 키에서 수집해 기존 구조화 형식과 하위호환한다: certs(현행)·certifications(bizinfo 기존)·labels(표기).
 */
function evaluateCertification(criterion: GrantCriterion, company: CompanyProfile): RuleTraceEntry {
  const value = criterion.value as Record<string, unknown>;
  const label = "인증";
  const known = isKnownListField(company, "certification");
  const companyValues = company.certs ?? [];
  const required = unique([
    ...toStringArray(value.certs),
    ...toStringArray(value.certifications),
    ...toStringArray(value.labels),
  ]);

  if (criterion.operator === "exists") {
    if (companyValues.length === 0 && known) return trace(criterion, "fail", `기업 ${label} 없음`, companyValues);
    return trace(
      criterion,
      companyValues.length > 0 ? "pass" : "unknown",
      companyValues.length > 0 ? `${label} 보유 확인 - 귀사 ${companyValues.join(", ")}` : `기업 ${label} 입력 필요`,
      companyValues.length > 0 ? companyValues : undefined,
    );
  }

  if (required.length === 0) return trace(criterion, "unknown", `${label} 조건 확인 필요`);
  if (companyValues.length === 0) {
    if (!known) return trace(criterion, "unknown", `기업 ${label} 입력 필요`);
    return trace(
      criterion,
      criterion.operator === "not_in" || criterion.kind === "exclusion" ? "pass" : "fail",
      `${label} ${required.join(", ")} - 귀사 해당 없음`,
      companyValues,
    );
  }

  const overlaps = certsMatch(companyValues, required);
  const matched = criterion.operator === "not_in" ? !overlaps : overlaps;
  const result = criterion.kind === "exclusion" && criterion.operator !== "not_in" ? !matched : matched;
  return trace(
    criterion,
    result ? "pass" : "fail",
    `${label} ${required.join(", ")} - 귀사 ${companyValues.join(", ")}`,
    companyValues,
  );
}

function evaluateListCriterion(
  criterion: GrantCriterion,
  companyValuesInput: string[] | undefined,
  valueKey: keyof ListCriterionValue,
  label: string,
  known: boolean,
): RuleTraceEntry {
  const companyValues = companyValuesInput ?? [];
  const required = ((criterion.value as ListCriterionValue)[valueKey] ?? []) as string[];
  if (criterion.operator === "exists") {
    if (companyValues.length === 0 && known) {
      return trace(criterion, "fail", `기업 ${label} 없음`, companyValues);
    }
    return trace(
      criterion,
      companyValues.length > 0 ? "pass" : "unknown",
      companyValues.length > 0 ? `${label} 보유 확인 - 귀사 ${companyValues.join(", ")}` : `기업 ${label} 입력 필요`,
      companyValues.length > 0 ? companyValues : undefined,
    );
  }
  if (required.length === 0) return trace(criterion, "unknown", `${label} 조건 확인 필요`);
  if (companyValues.length === 0) {
    if (!known) return trace(criterion, "unknown", `기업 ${label} 입력 필요`);
    return trace(
      criterion,
      criterion.operator === "not_in" || criterion.kind === "exclusion" ? "pass" : "fail",
      `${label} ${required.join(", ")} - 귀사 해당 없음`,
      companyValues,
    );
  }
  const overlaps = required.some((value) => companyValues.includes(value));
  const matched = criterion.operator === "not_in" ? !overlaps : overlaps;
  const result = criterion.kind === "exclusion" && criterion.operator !== "not_in" ? !matched : matched;
  return trace(
    criterion,
    result ? "pass" : "fail",
    `${label} ${required.join(", ")} - 귀사 ${companyValues.join(", ")}`,
    companyValues,
  );
}

function isKnownListField(company: CompanyProfile, dimension: CriterionDimension): boolean {
  return typeof company.confidence?.[dimension] === "number";
}

function evaluateNumericCriterion(
  criterion: GrantCriterion,
  companyValue: number | null,
  options: {
    label: string;
    unit: string;
    minKeys: string[];
    maxKeys: string[];
  },
): RuleTraceEntry {
  if (companyValue === null || companyValue === undefined) {
    return trace(criterion, "unknown", `${options.label} 입력 필요`);
  }

  if (criterion.operator === "exists") {
    return trace(criterion, "pass", `${options.label} 확인 - 귀사 ${formatNumber(companyValue)}${options.unit}`, companyValue);
  }

  const value = criterion.value as Record<string, unknown>;
  const min = firstNumber(value, options.minKeys);
  const max = firstNumber(value, options.maxKeys);
  let ok: boolean | null = null;
  if (criterion.operator === "gte" && min !== null) ok = companyValue >= min;
  if (criterion.operator === "lte" && max !== null) ok = companyValue <= max;
  if (criterion.operator === "between" && (min !== null || max !== null)) {
    ok = (min === null || companyValue >= min) && (max === null || companyValue <= max);
  }

  if (ok === null) return trace(criterion, "unknown", `${options.label} 조건 확인 필요`, companyValue);
  return trace(
    criterion,
    ok ? "pass" : "fail",
    `${options.label} ${numericBoundsLabel(min, max, options.unit)} - 귀사 ${formatNumber(companyValue)}${options.unit}`,
    companyValue,
  );
}

function evaluateSingleValueCriterion(
  criterion: GrantCriterion,
  companyValue: string | null,
  valueKey: keyof ListCriterionValue,
  label: string,
): RuleTraceEntry {
  const required = ((criterion.value as ListCriterionValue)[valueKey] ?? []) as string[];
  if (required.length === 0) return trace(criterion, "unknown", `${label} 조건 확인 필요`);
  if (!companyValue) return trace(criterion, "unknown", `기업 ${label} 입력 필요`);
  const overlaps = required.includes(companyValue);
  const result = criterion.operator === "not_in" ? !overlaps : overlaps;
  return trace(
    criterion,
    result ? "pass" : "fail",
    `${label} ${required.join(", ")} - 귀사 ${companyValue}`,
    companyValue,
  );
}

function evaluateBusinessStatus(criterion: GrantCriterion, company: CompanyProfile): RuleTraceEntry {
  const status = company.business_status;
  if (status?.active === undefined) {
    return trace(criterion, "unknown", "휴폐업 상태 확인 필요");
  }

  const value = criterion.value as { statuses?: string[]; labels?: string[] };
  const statuses = value.statuses ?? [];
  const isClosedExcluded = statuses.includes("closed") || /휴.?폐업|폐업/.test(criterion.source_span ?? "");
  if (!isClosedExcluded) {
    return trace(criterion, "unknown", "영업상태 조건 원문 확인 필요", status);
  }

  if (criterion.kind === "exclusion" || criterion.operator === "not_in") {
    return trace(
      criterion,
      status.active ? "pass" : "fail",
      status.active ? "휴폐업 제외 조건 미해당 - 팝빌 정상 상태" : "휴폐업 제외 조건 해당 가능",
      status,
    );
  }

  return trace(
    criterion,
    status.active ? "pass" : "fail",
    status.active ? "정상 영업 상태 확인" : "정상 영업 상태 확인 필요",
    status,
  );
}

function scoreFit(eligibility: Eligibility, traceEntries: RuleTraceEntry[]): number {
  if (eligibility === "ineligible") return 0;
  if (eligibility === "eligible") return 100;

  const required = traceEntries.filter((entry) => entry.kind === "required");
  if (required.length === 0) return 70;
  const passCount = required.filter((entry) => entry.result === "pass").length;
  return Math.round(60 + (passCount / required.length) * 35);
}

function buildReviewGate(input: {
  eligibility: Eligibility;
  traceEntries: RuleTraceEntry[];
  criteria: GrantCriterion[];
  criteriaExtracted: boolean;
}): MatchReviewGate {
  if (!input.criteriaExtracted) {
    return {
      tier: "needs_core_review",
      scoreDisplay: "hidden",
      reasons: [{
        code: "unstructured_criteria",
        dimension: "other",
        label: "공고 자격조건이 아직 구조화되지 않아 원문 확인이 필요해요.",
      }],
    };
  }

  const hardFails = input.traceEntries.filter(isHardFailTrace);
  if (hardFails.length > 0) {
    return {
      tier: "not_recommended",
      scoreDisplay: "hidden",
      reasons: uniqueReasons(hardFails.map((entry) =>
        reviewReason("hard_fail", entry, "필수 조건을 충족하지 못했어요."),
      )),
    };
  }

  const coreUnknowns = input.traceEntries
    .map((entry, index) => ({ entry, criterion: input.criteria[index] }))
    .filter(({ entry, criterion }) => isHardUnknownTrace(entry) && isCoreReviewTrace(entry, criterion));
  if (coreUnknowns.length > 0) {
    return {
      tier: "needs_core_review",
      scoreDisplay: "hidden",
      reasons: uniqueReasons(coreUnknowns.map(({ entry }) =>
        reviewReason("core_dimension_unknown", entry, "핵심 자격 조건을 원문으로 확인해야 해요."),
      )),
    };
  }

  const unverifiedCoreCriteria = input.criteria
    .map((criterion, index) => ({ criterion, entry: input.traceEntries[index] }))
    .filter(({ criterion, entry }) => isUnverifiedCoreCriterion(criterion, entry));
  if (unverifiedCoreCriteria.length > 0) {
    return {
      tier: "needs_core_review",
      scoreDisplay: "hidden",
      reasons: uniqueReasons(unverifiedCoreCriteria.map(({ criterion, entry }) =>
        unverifiedReviewReason(criterion, entry),
      )),
    };
  }

  const requiredCount = input.traceEntries.filter((entry) => entry.kind === "required").length;
  const highRiskCriterion = input.criteria.find((criterion) => hasHighRiskSignal(criterion));
  if (requiredCount <= 1 && highRiskCriterion) {
    return {
      tier: "needs_core_review",
      scoreDisplay: "hidden",
      reasons: [{
        code: "criteria_under_extracted",
        dimension: highRiskCriterion.dimension,
        label: "특수 분야 자격 조건이 충분히 구조화되지 않아 원문 확인이 필요해요.",
        ...(highRiskCriterion.source_span ? { sourceSpan: highRiskCriterion.source_span } : {}),
      }],
    };
  }

  const profileUnknowns = input.traceEntries.filter(isHardUnknownTrace);
  if (profileUnknowns.length > 0) {
    return {
      tier: "needs_profile_input",
      scoreDisplay: "hidden",
      reasons: uniqueReasons(profileUnknowns.map((entry) =>
        reviewReason("profile_missing", entry, "기업 정보를 입력하면 판정을 확정할 수 있어요."),
      )),
    };
  }

  if (input.eligibility === "eligible") {
    return { tier: "recommendable", scoreDisplay: "numeric", reasons: [] };
  }

  return { tier: "needs_core_review", scoreDisplay: "hidden", reasons: [] };
}

function isHardFailTrace(entry: RuleTraceEntry): boolean {
  return entry.result === "fail" && (entry.kind === "required" || entry.kind === "exclusion");
}

function isHardUnknownTrace(entry: RuleTraceEntry): boolean {
  return (
    (entry.result === "unknown" || entry.operator === "text_only") &&
    (entry.kind === "required" || entry.kind === "exclusion")
  );
}

function isCoreReviewTrace(entry: RuleTraceEntry, criterion: GrantCriterion | undefined): boolean {
  return CORE_GATE_DIMENSIONS.has(entry.dimension) || hasHighRiskSignal(criterion, entry);
}

function isUnverifiedCoreCriterion(
  criterion: GrantCriterion,
  entry: RuleTraceEntry | undefined,
): boolean {
  return criterion.needs_review === true &&
    (criterion.kind === "required" || criterion.kind === "exclusion") &&
    entry?.result === "pass" &&
    (CORE_GATE_DIMENSIONS.has(criterion.dimension) || hasHighRiskSignal(criterion, entry));
}

function hasHighRiskSignal(criterion?: GrantCriterion, entry?: RuleTraceEntry): boolean {
  const values = [
    criterion?.source_span,
    criterion?.raw_text,
    criterion?.source_field,
    criterionValueText(criterion?.value),
    entry?.source_span,
    entry?.message,
  ];
  return values.some((value) => typeof value === "string" && HIGH_RISK_DOMAIN_PATTERN.test(value));
}

function criterionValueText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return ["note", "label", "labels", "tags", "industries", "certs", "certifications"]
    .map((key) => record[key])
    .flatMap((item) => Array.isArray(item) ? item : [item])
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

function reviewReason(
  code: MatchReviewReason["code"],
  entry: RuleTraceEntry,
  fallbackLabel: string,
): MatchReviewReason {
  return {
    code,
    dimension: entry.dimension,
    label: entry.message || fallbackLabel,
    ...(entry.source_span ? { sourceSpan: entry.source_span } : {}),
  };
}

function unverifiedReviewReason(
  criterion: GrantCriterion,
  entry: RuleTraceEntry | undefined,
): MatchReviewReason {
  const reason: MatchReviewReason = {
    code: "criteria_under_extracted",
    dimension: criterion.dimension,
    label: `${labelFor(criterion.dimension)} 조건은 검수 전 구조화 결과라 원문 확인이 필요해요.`,
  };
  const sourceSpan = criterion.source_span ?? entry?.source_span;
  if (sourceSpan) reason.sourceSpan = sourceSpan;
  return reason;
}

function uniqueReasons(reasons: MatchReviewReason[]): MatchReviewReason[] {
  const seen = new Set<string>();
  const result: MatchReviewReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.code}:${reason.dimension}:${reason.sourceSpan ?? reason.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reason);
  }
  return result;
}

function nextQuestion(fields: CriterionDimension[]): NextQuestion | undefined {
  const priority: CriterionDimension[] = [
    "industry",
    "size",
    "revenue",
    "employees",
    "region",
    "biz_age",
    "founder_age",
    "founder_trait",
    "certification",
    "ip",
    "target_type",
    "prior_award",
    "business_status",
    "other",
  ];
  const field = priority.find((candidate) => fields.includes(candidate));
  if (!field) return undefined;
  const prompts: Record<CriterionDimension, string> = {
    region: "본사 외 지사, 연구소, 공장 소재지가 있나요?",
    biz_age: "사업자등록 기준 개업일 또는 법인 설립일을 입력해 주세요.",
    industry: "주요 업종이나 서비스 분야를 선택해 주세요.",
    size: "기업 규모, 매출, 고용 정보를 입력해 주세요.",
    revenue: "최근 매출 정보를 입력해 주세요.",
    employees: "상시근로자 수를 입력해 주세요.",
    founder_age: "대표자 생년월일 또는 연령대를 입력해 주세요.",
    founder_trait: "대표자 우대 속성에 해당하는지 확인해 주세요.",
    certification: "보유 인증이나 특허가 있나요?",
    prior_award: "동일하거나 유사한 정부지원사업 선정 이력이 있나요?",
    ip: "보유한 특허나 지식재산권이 있나요?",
    target_type: "신청 주체 유형을 확인해 주세요.",
    business_status: "휴폐업 및 과세 상태를 확인해 주세요.",
    // 공고매칭 차원 확장 축 — 문항 카피·우선순위는 P2/P3에서 확정.
    tax_compliance: "국세·지방세·4대보험 체납 여부를 확인해 주세요.",
    credit_status: "신용 연체·채무불이행·회생·파산 등 신용 상태를 확인해 주세요.",
    sanction: "정부지원사업 참여제한·부정수급 등 제재 이력을 확인해 주세요.",
    financial_health: "부채비율·자본잠식 등 재무 상태를 확인해 주세요.",
    insured_workforce: "고용보험 피보험자 수 등 고용 정보를 확인해 주세요.",
    investment: "투자 유치 이력을 확인해 주세요.",
    premises: "사업장·입지 요건에 해당하는지 확인해 주세요.",
    export_performance: "수출 실적이 있는지 확인해 주세요.",
    other: "제외대상이나 특수 조건에 해당하는지 확인해 주세요.",
  };

  return {
    field,
    prompt: prompts[field],
    reason: "조건부 공고의 unknown 판정을 확정 또는 제외하는 데 필요합니다.",
  };
}

function trace(
  criterion: GrantCriterion,
  result: CriterionResult,
  message: string,
  companyValue?: unknown,
): RuleTraceEntry {
  const entry: RuleTraceEntry = {
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    result,
    message,
  };
  if (criterion.id) entry.criterion_id = criterion.id;
  if (criterion.source_span) entry.source_span = criterion.source_span;
  if (companyValue !== undefined) entry.company_value = companyValue;
  return entry;
}

function textOnlyMessage(criterion: GrantCriterion): string {
  if (criterion.kind === "exclusion") return "제외대상 원문 확인 필요";
  return `${labelFor(criterion.dimension)} 원문 확인 필요`;
}

function labelFor(dimension: CriterionDimension): string {
  const labels: Record<CriterionDimension, string> = {
    region: "지역",
    biz_age: "업력",
    industry: "업종/분야",
    size: "기업규모",
    revenue: "매출",
    employees: "고용",
    founder_age: "대표자 연령",
    founder_trait: "대표자 속성",
    certification: "인증",
    prior_award: "기수혜",
    ip: "지식재산",
    target_type: "신청대상",
    business_status: "영업상태",
    tax_compliance: "세금 체납",
    credit_status: "신용 상태",
    sanction: "제재·참여제한",
    financial_health: "재무 건전성",
    insured_workforce: "고용보험 피보험자",
    investment: "투자 유치",
    premises: "사업장·입지",
    export_performance: "수출 실적",
    other: "기타",
  };
  return labels[dimension];
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) return item;
  }
  return null;
}

function numericBoundsLabel(min: number | null, max: number | null, unit: string): string {
  if (min !== null && max !== null) return `${formatNumber(min)}${unit} 이상 ${formatNumber(max)}${unit} 이하`;
  if (min !== null) return `${formatNumber(min)}${unit} 이상`;
  if (max !== null) return `${formatNumber(max)}${unit} 이하`;
  return "기준";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function regionLabel(code: string): string {
  return REGION_LABELS[code] ?? code;
}

function formatMonths(months: number): string {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0 ? `${years}년` : `${years}년 ${rest}개월`;
}

function bizAgeBoundsLabel(minMonths: number | null, maxMonths: number | null): string {
  if (minMonths !== null && maxMonths !== null) {
    return `${formatMonths(minMonths)} 이상 ${formatMonths(maxMonths)} 이내`;
  }
  if (minMonths !== null) return `${formatMonths(minMonths)} 이상`;
  if (maxMonths !== null) return `${formatMonths(maxMonths)} 이내`;
  return "업력 기준";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
