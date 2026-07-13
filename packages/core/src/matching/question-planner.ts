import type {
  CriterionDimension,
  GrantCriterion,
  NextQuestionDto,
  RuleTraceEntry,
} from "@cunote/contracts";
import type { DisqualificationAxis } from "../disqualification/canonical.js";
import {
  questionCriterionThresholds,
  questionDefinitionFor,
  questionOptions,
  type QuestionDefinitionId,
} from "../questions/definitions.js";
import { daysUntil, grantKey, type MatchedGrant } from "../use-cases/match-card.js";
import { priorAwardProgramLabel } from "../prior-award/canonical.js";

export interface PlannedProfileQuestion {
  question: NextQuestionDto;
  definitionId: QuestionDefinitionId;
  criterionThresholds: NonNullable<NextQuestionDto["criterionThresholds"]>;
  score: number;
  affectedGrantIds: string[];
  resolvesGrantCount: number;
  hardConditionCount: number;
  effort: "quick" | "medium" | "long";
}

export interface PlanProfileQuestionsOptions {
  asOf?: Date;
  limit?: number;
  excludeDimensions?: CriterionDimension[];
}

interface QuestionCandidate {
  trace: RuleTraceEntry;
  criterion: GrantCriterion;
  grantId: string;
  dDay: number | null;
  onlyRemainingDimension: boolean;
}

const DIMENSION_TIE_BREAK: CriterionDimension[] = [
  "tax_compliance",
  "credit_status",
  "sanction",
  "business_status",
  "region",
  "biz_age",
  "industry",
  "size",
  "revenue",
  "employees",
  "founder_age",
  "founder_trait",
  "certification",
  "target_type",
  "financial_health",
  "insured_workforce",
  "investment",
  "prior_award",
  "ip",
  "premises",
  "export_performance",
  "other",
];

/**
 * 여러 공고의 profile-resolvable unknown을 묶어 정보가치가 높은 질문을 고른다.
 * 원문 누락(text_only/evidence 없음), 검수 전 criterion, 이미 hard-fail인 공고는 제외한다.
 */
export function planProfileQuestions<TPayload>(
  matches: Array<MatchedGrant<TPayload>>,
  options: PlanProfileQuestionsOptions = {},
): PlannedProfileQuestion[] {
  const asOf = options.asOf ?? new Date();
  const limit = boundedLimit(options.limit);
  const excluded = new Set(options.excludeDimensions ?? []);
  const candidates = matches
    .flatMap((entry) => candidatesForMatch(entry, asOf))
    .filter((candidate) => !excluded.has(candidate.trace.dimension));
  const dimensions = [...new Set(candidates.map((candidate) => candidate.trace.dimension))];

  return dimensions
    .map((dimension) => planDimensionQuestion(
      dimension,
      candidates.filter((candidate) => candidate.trace.dimension === dimension),
    ))
    .sort((left, right) =>
      right.score - left.score ||
      right.question.affectedGrantCount - left.question.affectedGrantCount ||
      dimensionRank(left.question.dimension) - dimensionRank(right.question.dimension))
    .slice(0, limit);
}

function candidatesForMatch<TPayload>(
  entry: MatchedGrant<TPayload>,
  asOf: Date,
): QuestionCandidate[] {
  if (entry.match.eligibility === "ineligible") return [];
  if (
    entry.match.quality.extractionReadiness === "partial" ||
    entry.match.quality.extractionReadiness === "unstructured"
  ) return [];
  const hardUnknowns = entry.match.rule_trace
    .map((trace, index) => ({ trace, criterion: entry.item.criteria[index] }))
    .filter((item): item is { trace: RuleTraceEntry; criterion: GrantCriterion } =>
      item.trace.result === "unknown" &&
      (item.trace.kind === "required" || item.trace.kind === "exclusion") &&
      item.criterion !== undefined);
  const resolvable = hardUnknowns.filter(({ criterion }) => isProfileResolvableCriterion(criterion));
  if (resolvable.length === 0) return [];

  const unresolvedDimensions = new Set(hardUnknowns.map((item) => item.trace.dimension));
  const grantId = grantKey(entry.item.grant);
  const dDay = daysUntil(entry.item.grant.apply_end ?? null, asOf);
  return resolvable.map(({ trace, criterion }) => ({
    trace,
    criterion,
    grantId,
    dDay,
    onlyRemainingDimension: unresolvedDimensions.size === 1 && isExhaustiveQuestionDimension(trace.dimension),
  }));
}

function planDimensionQuestion(
  dimension: CriterionDimension,
  candidates: QuestionCandidate[],
): PlannedProfileQuestion {
  const scopedCandidates = dimension === "prior_award" ? selectPriorAwardQuestionCandidates(candidates) : candidates;
  const affectedGrantIds = unique(scopedCandidates.map((candidate) => candidate.grantId));
  const resolvesGrantIds = unique(scopedCandidates
    .filter((candidate) => candidate.onlyRemainingDimension)
    .map((candidate) => candidate.grantId));
  const hardConditionCount = scopedCandidates.length;
  const effort = effortForDimension(dimension);
  const definition = questionDefinitionFor(dimension);
  const hasRangeAnswer = scopedCandidates.some((candidate) => isRangeCompanyValue(candidate.trace.company_value));
  const rangeStage = Boolean(definition.rangeOptions?.length) && !hasRangeAnswer;
  const preciseStage = Boolean(definition.rangeOptions?.length) && hasRangeAnswer;
  const options = rangeStage
    ? definition.rangeOptions?.map((option) => option.label) ?? []
    : preciseStage
      ? []
      : questionOptions(definition, scopedCandidates.map((candidate) => candidate.criterion));
  const criterionThresholds = questionCriterionThresholds(
    dimension,
    scopedCandidates.map((candidate) => ({ grantId: candidate.grantId, criterion: candidate.criterion })),
  );
  const score = Math.max(0, Math.round(
    affectedGrantIds.length * 10 +
    resolvesGrantIds.length * 12 +
    scopedCandidates.reduce((sum, candidate) => sum + conditionWeight(candidate), 0) +
    scopedCandidates.reduce((sum, candidate) => sum + deadlineWeight(candidate.dDay), 0) -
    effortCost(effort),
  ));
  const priorAwardContext = dimension === "prior_award"
    ? priorAwardContextFromTrace(scopedCandidates[0]?.trace.company_value)
    : null;
  const question: NextQuestionDto = {
    dimension,
    definitionId: definition.id,
    prompt: priorAwardContext
      ? priorAwardPrompt(priorAwardContext)
      : preciseStage ? definition.precisePrompt ?? definition.prompt : definition.prompt,
    inputType: priorAwardContext ? "boolean" : rangeStage ? "select" : definition.inputType,
    framing: framingFor(dimension, affectedGrantIds.length, resolvesGrantIds.length),
    affectedGrantCount: affectedGrantIds.length,
    preciseFollowUp: definition.preciseFollowUp,
    responseStage: rangeStage ? "range" : preciseStage ? "precise" : "direct",
  };
  if (priorAwardContext) question.priorAwardContext = priorAwardContext;
  if (rangeStage && definition.rangeOptions) question.rangeOptions = definition.rangeOptions;
  if (definition.unit) question.unit = definition.unit;
  if (criterionThresholds.length > 0) question.criterionThresholds = criterionThresholds;
  if (options.length > 0) question.options = options;
  return {
    question,
    definitionId: definition.id,
    criterionThresholds,
    score,
    affectedGrantIds,
    resolvesGrantCount: resolvesGrantIds.length,
    hardConditionCount,
    effort,
  };
}

function selectPriorAwardQuestionCandidates(candidates: QuestionCandidate[]): QuestionCandidate[] {
  const grouped = new Map<string, QuestionCandidate[]>();
  for (const candidate of candidates) {
    const context = priorAwardContextFromTrace(candidate.trace.company_value);
    const key = context ? JSON.stringify(context) : "legacy";
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }
  return [...grouped.values()].sort((left, right) =>
    right.length - left.length || left[0]!.grantId.localeCompare(right[0]!.grantId))[0] ?? candidates;
}

function priorAwardContextFromTrace(value: unknown): NonNullable<NextQuestionDto["priorAwardContext"]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = (value as { priorAwardQuestion?: unknown }).priorAwardQuestion;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const row = context as Record<string, unknown>;
  if (row.scope !== "self" && row.scope !== "program" && row.scope !== "program_type") return null;
  const programs = Array.isArray(row.programs)
    ? row.programs.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 1)
    : [];
  const states = Array.isArray(row.states)
    ? row.states.filter((item): item is "participating" | "completed" | "graduated" =>
      item === "participating" || item === "completed" || item === "graduated")
    : [];
  return {
    scope: row.scope,
    ...(row.selfKind === "current_similar" || row.selfKind === "same_project" ||
      row.selfKind === "same_business_prior" || row.selfKind === "same_year_other_support"
      ? { selfKind: row.selfKind } : {}),
    ...(row.channel === "general" || row.channel === "incubation_tenancy" ? { channel: row.channel } : {}),
    ...(programs.length > 0 ? { programs } : {}),
    ...(states.length > 0 ? { states } : {}),
    requiresYear: row.requiresYear === true,
  };
}

function priorAwardPrompt(context: NonNullable<NextQuestionDto["priorAwardContext"]>): string {
  if (context.channel === "incubation_tenancy") return "현재 다른 창업보육센터·BI에 입주 중인가요?";
  if (context.scope === "self") {
    const prompts = {
      current_similar: "현재 다른 정부·지자체 지원사업을 수행 중이거나 동일·유사 지원을 받고 있나요?",
      same_project: "동일 과제로 다른 정부지원사업에 동시에 참여 중인가요?",
      same_business_prior: "이번 공모와 동일한 사업에 과거 선정·입상한 적이 있나요?",
      same_year_other_support: "올해 다른 부처·공공기관의 유사 정부보조금을 중복 수혜하고 있나요?",
    } as const;
    return prompts[context.selfKind ?? "current_similar"];
  }
  const program = context.programs?.[0] ? priorAwardProgramLabel(context.programs[0]) : "해당 프로그램";
  const [state] = context.states ?? [];
  if (state === "participating") return `현재 ${program}에 참여·수행 중인가요?`;
  if (state === "completed") return `${program} 선정·수혜 완료 이력이 있나요?`;
  if (state === "graduated") return `${program} 수료 이력이 있나요?`;
  return `${program} 참여·수혜·수료 이력이 있나요?`;
}

function isRangeCompanyValue(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "range");
}

function isProfileResolvableCriterion(criterion: GrantCriterion): boolean {
  if (criterion.operator === "text_only" || criterion.needs_review === true) return false;
  if (!criterion.source_span?.trim() && !criterion.source_field?.trim()) return false;
  if (criterion.dimension === "other" || criterion.dimension === "premises" || criterion.dimension === "export_performance") {
    return false;
  }
  const value = criterion.value as Record<string, unknown>;
  switch (criterion.dimension) {
    case "region":
      return value.nationwide === true || hasValues(value.regions);
    case "biz_age":
      return isNumber(value.min_months) || isNumber(value.max_months);
    case "founder_age":
      return hasValues(value.ranges);
    case "industry":
      return hasValues(value.codes) || hasValues(value.industries) || hasValues(value.labels) || hasValues(value.tags);
    case "size":
      return hasValues(value.sizes);
    case "revenue":
      return hasNumericBound(value, ["min_krw", "min", "max_krw", "max"]);
    case "employees":
      return hasNumericBound(value, ["min", "max"]);
    case "certification":
      return hasValues(value.certs) || hasValues(value.certifications) || hasValues(value.labels);
    case "founder_trait":
      return hasValues(value.traits);
    case "prior_award":
      return value.scope === "self" || value.scope === "program" || value.scope === "program_type" ||
        hasValues(value.programs) || hasValues(value.flags) || typeof value.note === "string";
    case "ip":
      return hasValues(value.types);
    case "target_type":
      return hasValues(value.targets);
    case "business_status":
      return hasValues(value.statuses) || /휴.?폐업|폐업/.test(criterion.source_span ?? "");
    case "tax_compliance":
    case "credit_status":
    case "sanction":
      return hasValues(value.flags);
    case "financial_health":
    case "insured_workforce":
    case "investment":
      return Object.values(value).some((item) => item !== null && item !== undefined);
    default:
      return false;
  }
}

function conditionWeight(candidate: QuestionCandidate): number {
  const kindWeight = candidate.trace.kind === "exclusion" ? 6 : 4;
  return kindWeight + (candidate.onlyRemainingDimension ? 3 : 0);
}

function isExhaustiveQuestionDimension(dimension: CriterionDimension): boolean {
  return !(
    dimension === "industry" ||
    dimension === "founder_trait" ||
    dimension === "certification" ||
    dimension === "prior_award" ||
    dimension === "ip" ||
    dimension === "target_type"
  );
}

function deadlineWeight(dDay: number | null): number {
  if (dDay === null || dDay < 0) return 0;
  if (dDay <= 7) return 4;
  if (dDay <= 21) return 2;
  return 0;
}

function effortForDimension(dimension: CriterionDimension): PlannedProfileQuestion["effort"] {
  if (
    dimension === "financial_health" ||
    dimension === "insured_workforce" ||
    dimension === "investment"
  ) return "long";
  if (
    dimension === "revenue" ||
    dimension === "employees" ||
    dimension === "founder_age" ||
    dimension === "biz_age"
  ) return "medium";
  return "quick";
}

function effortCost(effort: PlannedProfileQuestion["effort"]): number {
  if (effort === "long") return 8;
  if (effort === "medium") return 4;
  return 1;
}

function framingFor(dimension: CriterionDimension, affected: number, resolves: number): string {
  const resolution = resolves > 0 ? ` 이 중 ${resolves}개 공고는 이 답변으로 판정을 확정할 수 있어요.` : "";
  const sensitivity = isDisqualificationAxis(dimension)
    ? " 답변은 자격 확인에만 사용하며 설정에서 수정할 수 있어요."
    : "";
  return `${affected}개 공고의 미확인 조건을 줄일 수 있어요.${resolution}${sensitivity}`;
}

function isDisqualificationAxis(dimension: CriterionDimension): dimension is DisqualificationAxis {
  return dimension === "tax_compliance" || dimension === "credit_status" || dimension === "sanction";
}

function hasValues(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function hasNumericBound(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => isNumber(value[key]));
}

function dimensionRank(dimension: CriterionDimension): number {
  const index = DIMENSION_TIE_BREAK.indexOf(dimension);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function boundedLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
