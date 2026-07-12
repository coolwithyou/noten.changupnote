import type {
  CriterionDimension,
  GrantCriterion,
  NextQuestionDto,
  QuestionCriterionThresholdDto,
} from "@cunote/contracts";
import { DISQUALIFICATION_FLAGS, type DisqualificationAxis } from "../disqualification/canonical.js";
import { REGION_CODES } from "../kstartup/constants.js";

export type QuestionDefinitionId = `profile.${CriterionDimension}.v1`;

export interface QuestionDefinition {
  id: QuestionDefinitionId;
  dimension: CriterionDimension;
  prompt: string;
  inputType: NextQuestionDto["inputType"];
  unit?: NextQuestionDto["unit"];
  candidateOptionKeys?: string[];
  defaultOptions?: string[];
  responsePolicy: "single" | "multi_partial" | "tri_state_no_default" | "number_group";
  preciseFollowUp: NonNullable<NextQuestionDto["preciseFollowUp"]>;
}

const DEFINITIONS: Record<CriterionDimension, QuestionDefinition> = {
  tax_compliance: definition("tax_compliance", "국세·지방세·관세·4대보험 체납 여부를 확인해 주세요.", "checklist", {
    responsePolicy: "tri_state_no_default",
    defaultOptions: [...DISQUALIFICATION_FLAGS.tax_compliance],
  }),
  credit_status: definition("credit_status", "연체·채무불이행·회생·파산 등 신용 상태를 확인해 주세요.", "checklist", {
    responsePolicy: "tri_state_no_default",
    defaultOptions: [...DISQUALIFICATION_FLAGS.credit_status],
  }),
  sanction: definition("sanction", "정부지원사업 참여제한이나 제재 이력을 확인해 주세요.", "checklist", {
    responsePolicy: "tri_state_no_default",
    defaultOptions: [...DISQUALIFICATION_FLAGS.sanction],
  }),
  region: definition("region", "본사와 지원 가능한 지사·공장·연구소 소재지를 선택해 주세요.", "select", {
    candidateOptionKeys: ["labels", "regions"],
    defaultOptions: Object.keys(REGION_CODES),
  }),
  biz_age: definition("biz_age", "사업자등록 기준 업력을 입력해 주세요.", "number", {
    unit: "months",
  }),
  industry: definition("industry", "현재 영위하는 주요 업종을 선택해 주세요.", "select", {
    candidateOptionKeys: ["labels", "industries", "tags"],
    defaultOptions: ["ICT", "SW", "AI", "바이오", "제조", "콘텐츠", "패션", "해양", "기타"],
    responsePolicy: "multi_partial",
  }),
  size: definition("size", "공식 확인서 기준 기업규모를 선택해 주세요.", "select", {
    candidateOptionKeys: ["sizes"],
    defaultOptions: ["소상공인", "소기업", "중소기업", "중견기업", "대기업"],
  }),
  revenue: definition("revenue", "공고에서 요구하는 기준연도의 매출을 입력해 주세요.", "number", {
    unit: "krw",
    preciseFollowUp: "when_range_straddles_threshold",
  }),
  employees: definition("employees", "공고 기준에 맞는 상시근로자 수를 입력해 주세요.", "number", {
    unit: "people",
    preciseFollowUp: "when_range_straddles_threshold",
  }),
  founder_age: definition("founder_age", "대표자 연령을 입력해 주세요.", "number", { unit: "years" }),
  founder_trait: definition("founder_trait", "대표자 우대 속성을 확인해 주세요.", "select", {
    candidateOptionKeys: ["traits"],
    responsePolicy: "multi_partial",
  }),
  certification: definition("certification", "현재 유효한 인증 보유 여부를 확인해 주세요.", "select", {
    candidateOptionKeys: ["certs", "certifications", "labels"],
    responsePolicy: "multi_partial",
  }),
  target_type: definition("target_type", "신청 주체 유형을 선택해 주세요.", "select", {
    candidateOptionKeys: ["targets"],
    defaultOptions: ["예비창업자", "개인사업자", "법인", "일반기업", "1인 창조기업", "대학", "연구기관"],
  }),
  business_status: definition("business_status", "현재 정상 영업 중인지 확인해 주세요.", "boolean"),
  financial_health: definition("financial_health", "공고에서 요구하는 재무 건전성 수치를 확인해 주세요.", "number_group", {
    responsePolicy: "number_group",
  }),
  insured_workforce: definition("insured_workforce", "고용보험 가입과 피보험자 정보를 확인해 주세요.", "number_group", {
    responsePolicy: "number_group",
  }),
  investment: definition("investment", "투자 유치 및 TIPS 이력을 확인해 주세요.", "number_group", {
    responsePolicy: "number_group",
  }),
  prior_award: definition("prior_award", "동일·유사 지원사업 수혜 이력을 확인해 주세요.", "select", {
    candidateOptionKeys: ["programs"],
    responsePolicy: "multi_partial",
  }),
  ip: definition("ip", "현재 보유한 지식재산권을 확인해 주세요.", "select", {
    candidateOptionKeys: ["types"],
    responsePolicy: "multi_partial",
  }),
  premises: definition("premises", "사업장·공장·연구소 등 필요한 입지 조건을 확인해 주세요.", "text"),
  export_performance: definition("export_performance", "공고 기준기간의 수출 실적을 입력해 주세요.", "number", { unit: "krw" }),
  other: definition("other", "공고의 기타 신청 조건에 해당하는지 확인해 주세요.", "text"),
};

export function questionDefinitionFor(dimension: CriterionDimension): QuestionDefinition {
  return DEFINITIONS[dimension];
}

export function questionOptions(
  definitionValue: QuestionDefinition,
  criteria: GrantCriterion[],
): string[] {
  const criterionOptions = criteria.flatMap((criterion) => {
    const value = criterion.value as Record<string, unknown>;
    return (definitionValue.candidateOptionKeys ?? []).flatMap((key) => stringValues(value[key]));
  });
  const options = unique([...criterionOptions, ...(definitionValue.defaultOptions ?? [])]);
  if (definitionValue.dimension === "prior_award" && criterionOptions.length > 0) {
    return unique(["해당 없음", ...options]);
  }
  return options;
}

export function questionCriterionThresholds(
  dimension: CriterionDimension,
  candidates: Array<{ grantId: string; criterion: GrantCriterion }>,
): QuestionCriterionThresholdDto[] {
  const definitionValue = questionDefinitionFor(dimension);
  const grouped = new Map<string, QuestionCriterionThresholdDto & { grantIds: Set<string> }>();
  for (const candidate of candidates) {
    for (const threshold of thresholdsForCriterion(dimension, candidate.criterion)) {
      const key = `${threshold.field}:${threshold.operator}:${threshold.value}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.grantIds.add(candidate.grantId);
        existing.affectedGrantCount = existing.grantIds.size;
        continue;
      }
      grouped.set(key, {
        ...threshold,
        unit: definitionValue.unit ?? null,
        affectedGrantCount: 1,
        grantIds: new Set([candidate.grantId]),
      });
    }
  }
  return [...grouped.values()]
    .map(({ grantIds: _grantIds, ...threshold }) => threshold)
    .sort((left, right) => left.value - right.value || left.field.localeCompare(right.field));
}

function definition(
  dimension: CriterionDimension,
  prompt: string,
  inputType: NextQuestionDto["inputType"],
  options: Partial<Omit<QuestionDefinition, "id" | "dimension" | "prompt" | "inputType">> = {},
): QuestionDefinition {
  return {
    id: `profile.${dimension}.v1`,
    dimension,
    prompt,
    inputType,
    responsePolicy: options.responsePolicy ?? "single",
    preciseFollowUp: options.preciseFollowUp ?? "never",
    ...(options.unit ? { unit: options.unit } : {}),
    ...(options.candidateOptionKeys ? { candidateOptionKeys: options.candidateOptionKeys } : {}),
    ...(options.defaultOptions ? { defaultOptions: options.defaultOptions } : {}),
  };
}

function thresholdsForCriterion(
  dimension: CriterionDimension,
  criterion: GrantCriterion,
): Array<Pick<QuestionCriterionThresholdDto, "field" | "operator" | "value">> {
  const value = criterion.value as Record<string, unknown>;
  if (dimension === "revenue") {
    return numericBounds(value, [
      ["min_krw", "gte"], ["min", "gte"], ["max_krw", "lte"], ["max", "lte"],
    ]);
  }
  if (dimension === "employees") return numericBounds(value, [["min", "gte"], ["max", "lte"]]);
  if (dimension === "biz_age") return numericBounds(value, [["min_months", "gte"], ["max_months", "lte"]]);
  if (dimension === "financial_health") {
    const result = numericBounds(value, [["min_interest_coverage", "gte"]]);
    const debt = value.debt_ratio_pct_threshold;
    if (debt && typeof debt === "object" && !Array.isArray(debt)) {
      const row = debt as Record<string, unknown>;
      if (typeof row.value === "number" && Number.isFinite(row.value)) {
        result.push({ field: "debt_ratio_pct", operator: row.inclusive === true ? "gte" : "gt", value: row.value });
      }
    }
    return result;
  }
  if (dimension === "insured_workforce") return numericBounds(value, [["min_insured_count", "gte"], ["max_insured_count", "lte"]]);
  if (dimension === "investment") return numericBounds(value, [["min_total_raised_krw", "gte"]]);
  return [];
}

function numericBounds(
  value: Record<string, unknown>,
  specs: Array<[string, QuestionCriterionThresholdDto["operator"]]>,
): Array<Pick<QuestionCriterionThresholdDto, "field" | "operator" | "value">> {
  return specs.flatMap(([field, operator]) => {
    const amount = value[field];
    return typeof amount === "number" && Number.isFinite(amount) ? [{ field, operator, value: amount }] : [];
  });
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function isTriStateQuestion(dimension: CriterionDimension): dimension is DisqualificationAxis {
  return questionDefinitionFor(dimension).responsePolicy === "tri_state_no_default";
}
