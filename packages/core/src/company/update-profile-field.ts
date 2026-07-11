import type { CompanyProfile, CriterionDimension, DisqualificationProfileValue } from "@cunote/contracts";
import {
  ALL_DISQUALIFICATION_FLAGS,
  DISQUALIFICATION_EXCEPTIONS,
  DISQUALIFICATION_FLAGS,
  DISQUALIFICATION_QUESTIONS,
  knownFlagsForQuestion,
  type DisqualificationAxis,
  type DisqualificationException,
  type DisqualificationFlag,
  type DisqualificationQuestionId,
} from "../disqualification/canonical.js";

export interface CompanyProfileFieldUpdate {
  field: CriterionDimension;
  value: unknown;
  confidence?: number | null;
}

/** 자가신고 기본 confidence — 문항 API가 명시 전달하지 않을 때 사용(§공통). */
export const SELF_DECLARED_CONFIDENCE = 0.6;

export class InvalidCompanyProfileFieldError extends Error {
  readonly code = "invalid_profile_field";
  readonly status = 400;

  constructor(
    message: string,
    readonly field = "field",
  ) {
    super(message);
    this.name = "InvalidCompanyProfileFieldError";
  }
}

export function updateCompanyProfileField(
  profile: CompanyProfile,
  update: CompanyProfileFieldUpdate,
): CompanyProfile {
  const next: CompanyProfile = {
    ...profile,
    confidence: {
      ...(profile.confidence ?? {}),
    },
  };

  switch (update.field) {
    case "region":
      next.region = normalizeRegion(update.value);
      break;
    case "biz_age":
      next.biz_age_months = normalizeNonNegativeNumber(update.value, "value");
      break;
    case "industry":
      next.industries = normalizeStringArray(update.value, "value");
      break;
    case "size":
      next.size = normalizeString(update.value, "value");
      break;
    case "revenue":
      next.revenue_krw = normalizeNonNegativeNumber(update.value, "value");
      break;
    case "employees":
      next.employees_count = normalizeNonNegativeNumber(update.value, "value");
      break;
    case "founder_age":
      next.founder_age = normalizeNonNegativeNumber(update.value, "value");
      break;
    case "founder_trait":
      next.traits = normalizeStringArray(update.value, "value", { allowEmpty: true });
      break;
    case "certification":
      next.certs = normalizeStringArray(update.value, "value", { allowEmpty: true });
      break;
    case "prior_award":
      next.prior_awards = normalizeStringArray(update.value, "value", { allowEmpty: true });
      break;
    case "ip":
      next.ip = normalizeStringArray(update.value, "value", { allowEmpty: true });
      break;
    case "target_type":
      next.target_types = normalizeStringArray(update.value, "value");
      break;
    case "business_status":
      next.business_status = normalizeBusinessStatus(update.value);
      break;
    case "tax_compliance":
      next.tax_compliance = normalizeDisqualification(update.value, "tax_compliance");
      break;
    case "credit_status":
      next.credit_status = normalizeDisqualification(update.value, "credit_status");
      break;
    case "sanction":
      next.sanction = normalizeDisqualification(update.value, "sanction");
      break;
    case "financial_health":
      next.financial_health = normalizeFinancialHealth(update.value);
      break;
    case "insured_workforce":
      next.insured_workforce = normalizeInsuredWorkforce(update.value);
      break;
    case "investment":
      next.investment = normalizeInvestment(update.value);
      break;
    case "premises":
    case "export_performance":
      throw new InvalidCompanyProfileFieldError(
        `${update.field} 축은 예약 상태로, 아직 프로필 입력을 받지 않습니다.`,
        "field",
      );
    case "other":
      next.other_conditions = normalizeOtherConditions(update.value);
      break;
    default:
      throw new InvalidCompanyProfileFieldError(
        `${update.field} 필드는 아직 프로필 업데이트에 연결되지 않았습니다.`,
        "field",
      );
  }

  if (typeof update.confidence === "number") {
    next.confidence = {
      ...(next.confidence ?? {}),
      [update.field]: clampConfidence(update.confidence),
    };
  } else if (isDisqualificationExpandedAxis(update.field) && next.confidence?.[update.field] === undefined) {
    // 결격·재무·고용·투자 축은 문항 응답만으로도 known 게이트가 열려야 한다.
    // 문항 API가 confidence를 명시하지 않으면 자가신고 기본값(0.6)으로 기록한다
    // (드리즐 fallback 0.8이 자가신고 의도를 덮지 않도록 여기서 확정).
    next.confidence = {
      ...(next.confidence ?? {}),
      [update.field]: SELF_DECLARED_CONFIDENCE,
    };
  }

  return next;
}

function normalizeRegion(value: unknown): NonNullable<CompanyProfile["region"]> {
  if (typeof value === "string") {
    const code = normalizeString(value, "value");
    return { code, label: code };
  }

  const record = normalizeRecord(value, "value");
  const code = normalizeString(record.code, "value.code");
  const label = typeof record.label === "string" && record.label.trim()
    ? record.label.trim()
    : undefined;
  return label ? { code, label } : { code };
}

function normalizeStringArray(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (typeof value === "string") return [normalizeString(value, field)];
  if (!Array.isArray(value)) {
    throw new InvalidCompanyProfileFieldError(`${field}는 문자열 배열이어야 합니다.`, field);
  }

  const normalized = value.map((item, index) => normalizeString(item, `${field}.${index}`));
  if (normalized.length === 0 && !options.allowEmpty) {
    throw new InvalidCompanyProfileFieldError(`${field}는 비어 있을 수 없습니다.`, field);
  }
  return normalized;
}

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidCompanyProfileFieldError(`${field}는 비어 있지 않은 문자열이어야 합니다.`, field);
  }
  return value.trim();
}

function normalizeNonNegativeNumber(value: unknown, field: string): number {
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue) || numberValue < 0) {
    throw new InvalidCompanyProfileFieldError(`${field}는 0 이상의 숫자여야 합니다.`, field);
  }
  return Math.floor(numberValue);
}

function normalizeRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidCompanyProfileFieldError(`${field}는 객체여야 합니다.`, field);
  }
  return value as Record<string, unknown>;
}

function normalizeBusinessStatus(value: unknown): NonNullable<CompanyProfile["business_status"]> {
  if (typeof value === "boolean") return { active: value, label: value ? "정상" : "확인 필요" };
  return normalizeRecord(value, "value") as NonNullable<CompanyProfile["business_status"]>;
}

function normalizeOtherConditions(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { note: normalizeString(value, "value") };
  if (typeof value === "boolean") return { confirmed: value };
  return normalizeRecord(value, "value");
}

function isDisqualificationExpandedAxis(field: CriterionDimension): boolean {
  return (
    field === "tax_compliance" ||
    field === "credit_status" ||
    field === "sanction" ||
    field === "financial_health" ||
    field === "insured_workforce" ||
    field === "investment"
  );
}

// ── 결격 3축 정규화 (문항 응답 → {flags, known_flags, exceptions}) ─────────────
//
// 문항→플래그 변환은 반드시 canonical의 QUESTION_FLAG_COVERAGE(covers)를 경유한다.
// 각 문항에 응답하면 그 문항이 커버하는 전체 플래그가 known_flags에 기록되고(C1),
// 사용자가 "해당" 표시한 플래그만 flags(보유 결격)에 담긴다.
//
// 지원 입력 형태:
//  1) 그룹 체크리스트 응답:
//       { answers: { [questionId]: { held?: string[] } }, exceptions?: string[] }
//     - answers에 등장한 문항 id는 응답 완료로 간주 → covers 전체가 known.
//     - held에 담긴 canonical 플래그가 보유 결격.
//  2) 직접 형태(마이그레이션·테스트용):
//       { flags?, known_flags?, exceptions? }
//     - 축에 속한 플래그만 필터링해 그대로 반영.
function normalizeDisqualification(
  value: unknown,
  axis: DisqualificationAxis,
): DisqualificationProfileValue {
  const record = normalizeRecord(value, "value");
  const axisFlags = new Set<DisqualificationFlag>(DISQUALIFICATION_FLAGS[axis]);
  const flags = new Set<DisqualificationFlag>();
  const known = new Set<DisqualificationFlag>();

  const answers = record.answers;
  if (answers !== undefined) {
    const answerRecord = normalizeRecord(answers, "value.answers");
    for (const [id, rawAnswer] of Object.entries(answerRecord)) {
      const questionId = asQuestionId(id, axis);
      // 문항 응답 완료 → covers 전체 known 처리 (문항→플래그 매핑 경유).
      for (const flag of knownFlagsForQuestion(questionId)) known.add(flag);
      const answer = normalizeRecord(rawAnswer, `value.answers.${id}`);
      for (const flag of normalizeFlagList(answer.held, `value.answers.${id}.held`)) {
        if (axisFlags.has(flag) && known.has(flag)) flags.add(flag);
      }
    }
  }

  // 직접 형태(flags/known_flags) — 축 필터링 후 병합.
  for (const flag of normalizeFlagList(record.flags, "value.flags")) {
    if (axisFlags.has(flag)) {
      flags.add(flag);
      known.add(flag); // 보유로 신고했다면 그 플래그는 당연히 질의됨.
    }
  }
  for (const flag of normalizeFlagList(record.known_flags, "value.known_flags")) {
    if (axisFlags.has(flag)) known.add(flag);
  }

  const exceptions = normalizeExceptionList(record.exceptions, "value.exceptions");

  return {
    flags: [...flags],
    known_flags: [...known],
    exceptions,
  };
}

function asQuestionId(id: string, axis: DisqualificationAxis): DisqualificationQuestionId {
  const question = DISQUALIFICATION_QUESTIONS.find((item) => item.id === id);
  if (!question) {
    throw new InvalidCompanyProfileFieldError(`알 수 없는 결격 문항 id: ${id}`, "value.answers");
  }
  if (question.axis !== axis) {
    throw new InvalidCompanyProfileFieldError(
      `${id} 문항은 ${axis} 축에 속하지 않습니다.`,
      "value.answers",
    );
  }
  return question.id;
}

function normalizeFlagList(value: unknown, field: string): DisqualificationFlag[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  const flags: DisqualificationFlag[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new InvalidCompanyProfileFieldError(`${field}는 문자열 배열이어야 합니다.`, field);
    }
    const flag = item.trim();
    if (!flag) continue;
    if (!isDisqualificationFlag(flag)) {
      throw new InvalidCompanyProfileFieldError(`${field}에 알 수 없는 결격 플래그: ${flag}`, field);
    }
    flags.push(flag);
  }
  return flags;
}

function normalizeExceptionList(value: unknown, field: string): DisqualificationException[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  const exceptions: DisqualificationException[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new InvalidCompanyProfileFieldError(`${field}는 문자열 배열이어야 합니다.`, field);
    }
    const exception = item.trim();
    if (!exception) continue;
    if (!isDisqualificationException(exception)) {
      throw new InvalidCompanyProfileFieldError(`${field}에 알 수 없는 예외: ${exception}`, field);
    }
    exceptions.push(exception);
  }
  return [...new Set(exceptions)];
}

function isDisqualificationFlag(value: string): value is DisqualificationFlag {
  return (ALL_DISQUALIFICATION_FLAGS as readonly string[]).includes(value);
}

function isDisqualificationException(value: string): value is DisqualificationException {
  return (DISQUALIFICATION_EXCEPTIONS as readonly string[]).includes(value);
}

// ── 재무 건전성 정규화 (M7: 자본잠식 저부담 + 결산 수치 선택 입력) ──────────────
function normalizeFinancialHealth(value: unknown): NonNullable<CompanyProfile["financial_health"]> {
  const record = normalizeRecord(value, "value");
  const result: NonNullable<CompanyProfile["financial_health"]> = {};

  if (record.impairment !== undefined && record.impairment !== null) {
    result.impairment = normalizeImpairment(record.impairment);
  } else if (typeof record.capital_impaired === "boolean") {
    // 저부담 예/아니오 문항: 자본잠식 여부만. 전부/부분 구분 없이 full로 보수 처리.
    result.impairment = record.capital_impaired ? "full" : "none";
  }
  const debtRatio = optionalNonNegativeNumber(record.debt_ratio_pct, "value.debt_ratio_pct");
  if (debtRatio !== undefined) result.debt_ratio_pct = debtRatio;
  // 이자보상배율은 소수·음수(영업손실) 가능 → floor·비음수 강제 없이 그대로 보존.
  const interestCoverage = optionalFiniteNumber(
    record.interest_coverage_ratio,
    "value.interest_coverage_ratio",
  );
  if (interestCoverage !== undefined) result.interest_coverage_ratio = interestCoverage;
  const totalAssets = optionalNonNegativeNumber(record.total_assets_krw, "value.total_assets_krw");
  if (totalAssets !== undefined) result.total_assets_krw = totalAssets;
  const equity = optionalNumber(record.equity_krw, "value.equity_krw");
  if (equity !== undefined) result.equity_krw = equity;
  const capital = optionalNonNegativeNumber(record.capital_krw, "value.capital_krw");
  if (capital !== undefined) result.capital_krw = capital;
  if (typeof record.fiscal_year === "string" && record.fiscal_year.trim()) {
    result.fiscal_year = record.fiscal_year.trim();
  }

  // 결산 수치가 있고 자본잠식 상태가 명시되지 않았으면 자본총계·자본금으로 파생(P3).
  if (
    result.impairment === undefined &&
    typeof result.equity_krw === "number" &&
    typeof result.capital_krw === "number"
  ) {
    result.impairment = deriveImpairment(result.equity_krw, result.capital_krw);
  }

  return result;
}

function deriveImpairment(equity: number, capital: number): "none" | "partial" | "full" {
  if (equity <= 0) return "full"; // 완전자본잠식.
  if (equity < capital) return "partial"; // 부분자본잠식(자본총계 < 자본금).
  return "none";
}

function normalizeImpairment(value: unknown): "none" | "partial" | "full" {
  if (value === "none" || value === "partial" || value === "full") return value;
  throw new InvalidCompanyProfileFieldError(
    "value.impairment은 none/partial/full 중 하나여야 합니다.",
    "value.impairment",
  );
}

// ── 고용보험 피보험자 정규화 ──────────────────────────────────────────────────
function normalizeInsuredWorkforce(value: unknown): NonNullable<CompanyProfile["insured_workforce"]> {
  const record = normalizeRecord(value, "value");
  const result: NonNullable<CompanyProfile["insured_workforce"]> = {};

  if (typeof record.employment_insurance_active === "boolean") {
    result.employment_insurance_active = record.employment_insurance_active;
  }
  const insuredCount = optionalNonNegativeNumber(record.insured_count, "value.insured_count");
  if (insuredCount !== undefined) result.insured_count = insuredCount;
  const monthsSince = optionalNonNegativeNumber(
    record.months_since_last_layoff,
    "value.months_since_last_layoff",
  );
  if (monthsSince !== undefined) result.months_since_last_layoff = monthsSince;
  if (typeof record.no_layoff === "boolean") result.no_layoff = record.no_layoff;

  return result;
}

// ── 투자 유치 정규화 ──────────────────────────────────────────────────────────
function normalizeInvestment(value: unknown): NonNullable<CompanyProfile["investment"]> {
  const record = normalizeRecord(value, "value");
  const result: NonNullable<CompanyProfile["investment"]> = {};

  const totalRaised = optionalNonNegativeNumber(record.total_raised_krw, "value.total_raised_krw");
  if (totalRaised !== undefined) result.total_raised_krw = totalRaised;
  if (record.last_round !== undefined) {
    if (record.last_round === null || record.last_round === "") {
      result.last_round = null;
    } else if (typeof record.last_round === "string") {
      result.last_round = record.last_round.trim();
    } else {
      throw new InvalidCompanyProfileFieldError(
        "value.last_round는 문자열이어야 합니다.",
        "value.last_round",
      );
    }
  }
  if (typeof record.tips_backed === "boolean") result.tips_backed = record.tips_backed;

  return result;
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return undefined;
  return normalizeNonNegativeNumber(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) {
    throw new InvalidCompanyProfileFieldError(`${field}는 숫자여야 합니다.`, field);
  }
  return Math.floor(numberValue);
}

/** 소수·음수를 보존하는 유한 숫자 파서(예: 이자보상배율). floor·비음수 강제 없음. */
function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) {
    throw new InvalidCompanyProfileFieldError(`${field}는 숫자여야 합니다.`, field);
  }
  return numberValue;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
