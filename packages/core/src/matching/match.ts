import type {
  BizAgeCriterionValue,
  CompanyProfile,
  CriterionDimension,
  CriterionResult,
  Eligibility,
  FounderAgeCriterionValue,
  GrantCriterion,
  ListCriterionValue,
  MatchResult,
  NextQuestion,
  RegionCriterionValue,
  RuleTraceEntry,
} from "@cunote/contracts";
import { REGION_LABELS } from "../kstartup/constants.js";

export const RULESET_VERSION = "ruleset-kstartup-spine-v1";
export const SCORING_VERSION = "scoring-fit-v1";

export function matchGrantCriteria(
  criteria: GrantCriterion[],
  company: CompanyProfile,
): MatchResult {
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

  const result: MatchResult = {
    eligibility,
    fit_score: scoreFit(eligibility, ruleTrace),
    rule_trace: ruleTrace,
    unknown_fields,
    ruleset_ver: RULESET_VERSION,
    scoring_ver: SCORING_VERSION,
  };
  const question = nextQuestion(unknown_fields);
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
      return evaluateListCriterion(criterion, company.industries, "tags", "업종/분야", isKnownListField(company, "industry"));
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
      return evaluateListCriterion(criterion, company.certs, "certs", "인증", isKnownListField(company, "certification"));
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
  if (company.founder_age === null || company.founder_age === undefined) {
    return trace(criterion, "unknown", "대표자 연령 확인 필요");
  }
  const ranges = Array.isArray(value.ranges) ? value.ranges : [];
  if (ranges.length === 0) {
    return trace(criterion, "unknown", "대표자 연령 조건 확인 필요");
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
