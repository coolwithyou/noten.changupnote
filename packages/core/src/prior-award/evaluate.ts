import type {
  CompanyProfile,
  CriterionKind,
  CriterionResult,
  PriorAwardCriterionValue,
  PriorAwardProfileValue,
  PriorAwardRecord,
  PriorAwardSelfKind,
} from "@cunote/contracts";
import {
  isPriorAwardProgramType,
  normalizePriorAwardProgramLabel,
  priorAwardProgramLabel,
} from "./canonical.js";

export interface PriorAwardEvaluation {
  result: CriterionResult;
  message: string;
  companyValue?: unknown;
}

export function adaptPriorAwardCriterionValue(value: unknown): PriorAwardCriterionValue {
  const row = record(value);
  if (row.scope === "self" || row.scope === "program" || row.scope === "program_type") {
    return {
      scope: row.scope,
      ...(isSelfKind(row.self_kind) ? { self_kind: row.self_kind } : {}),
      ...(row.channel === "general" || row.channel === "incubation_tenancy" ? { channel: row.channel } : {}),
      ...(strings(row.programs).length > 0 ? { programs: strings(row.programs) } : {}),
      ...(states(row.states).length > 0 ? { states: states(row.states) } : {}),
      ...(validWithin(row.within) ? { within: validWithin(row.within) } : {}),
      ...(strings(row.labels).length > 0 ? { labels: strings(row.labels) } : {}),
    };
  }
  const singularProgram = typeof row.program === "string" && row.program.trim() ? [row.program.trim()] : [];
  const labels = unique([...singularProgram, ...strings(row.programs), ...strings(row.awards), ...strings(row.labels)]);
  const canonical = labels.map(programKey).filter((item): item is string => item !== null);
  if (canonical.length > 0) return { scope: "program", programs: canonical, labels };
  const note = typeof row.note === "string" && row.note.trim() ? row.note.trim() : null;
  return {
    scope: "self",
    self_kind: "current_similar",
    ...((labels.length > 0 || note) ? { labels: unique([...labels, ...(note ? [note] : [])]) } : {}),
  };
}

export function evaluatePriorAward(input: {
  value: unknown;
  kind: CriterionKind;
  company: CompanyProfile;
  asOf?: Date;
}): PriorAwardEvaluation {
  const value = adaptPriorAwardCriterionValue(input.value);
  const profile = resolvedProfile(input.company, value);
  if (!profile || typeof input.company.confidence?.prior_award !== "number") {
    return unknown("수혜·참여 이력 확인 필요", { priorAwardQuestion: questionContextForValue(value) });
  }

  if (value.scope === "self") {
    const channel = value.channel ?? "general";
    const selfKind = value.self_kind ?? "current_similar";
    const flag = channel === "incubation_tenancy"
      ? profile.has_incubation_tenancy
      : profile.self_flags?.[selfKind];
    if (flag === undefined) {
      return unknown(channel === "incubation_tenancy"
        ? "다른 창업보육센터·BI 입주 여부 확인 필요"
        : `${selfKindLabel(selfKind)} 확인 필요`, {
          priorAwardQuestion: { scope: "self", selfKind, channel },
        });
    }
    return polarity(input.kind, flag, channel === "incubation_tenancy"
      ? "다른 창업보육센터·BI 입주"
      : selfKindLabel(selfKind));
  }

  const required = unique(strings(value.programs).map(programKey).filter((item): item is string => item !== null));
  if (required.length === 0) return unknown("대상 지원사업 이력 조건 확인 필요");
  const knownSource = value.scope === "program_type" ? profile.known_program_types : profile.known_programs;
  const known = new Set(knownSource.map(programKey).filter((item): item is string => item !== null));
  const unqueried = required.filter((program) => !known.has(program));
  if (unqueried.length > 0) {
    return unknown(`${unqueried.map(priorAwardProgramLabel).join(", ")} 이력 확인 필요`, {
      priorAwardQuestion: {
        scope: value.scope,
        programs: unqueried,
        states: value.states ?? [],
        requiresYear: Boolean(value.within),
      },
    });
  }

  const matchingRecords = profile.records.filter((recordValue) => {
    const key = recordValue.program ? programKey(recordValue.program) : null;
    if (!key || !required.includes(key)) return false;
    if (value.scope === "program_type" && !isPriorAwardProgramType(key)) return false;
    return !value.states?.length || value.states.includes(recordValue.state);
  });
  const period = evaluatePeriod(matchingRecords, value.within ?? null, input.asOf ?? new Date());
  if (period === "unknown") return unknown("수혜·참여 연도 확인 필요", {
    priorAwardQuestion: {
      scope: value.scope,
      programs: required,
      states: value.states ?? [],
      requiresYear: true,
    },
  });
  const hit = period === "hit";
  const labels = required.map(priorAwardProgramLabel).join(", ");
  return polarity(input.kind, hit, labels, {
    matchedPrograms: matchingRecords.flatMap((recordValue) => recordValue.program ? [recordValue.program] : []),
  });
}

function questionContextForValue(value: PriorAwardCriterionValue): Record<string, unknown> {
  if (value.scope === "self") return {
    scope: "self",
    selfKind: value.self_kind ?? "current_similar",
    channel: value.channel ?? "general",
    requiresYear: false,
  };
  return {
    scope: value.scope,
    programs: strings(value.programs).map(programKey).filter((item): item is string => item !== null),
    states: value.states ?? [],
    requiresYear: Boolean(value.within),
  };
}

function resolvedProfile(company: CompanyProfile, value: PriorAwardCriterionValue): PriorAwardProfileValue | null {
  if (company.prior_award_history) return company.prior_award_history;
  if (!company.prior_awards) return null;
  const records: PriorAwardRecord[] = company.prior_awards.map((program) => ({ program, state: "completed" }));
  const complete = company.list_completeness?.prior_award === "complete";
  const required = strings(value.programs).map(programKey).filter((item): item is string => item !== null);
  const present = records.flatMap((item) => item.program ? [programKey(item.program)] : [])
    .filter((item): item is string => item !== null);
  return {
    records,
    known_programs: complete ? unique([...present, ...required]) : unique(present),
    known_program_types: complete ? unique([...present, ...required].filter(isPriorAwardProgramType)) : unique(present.filter(isPriorAwardProgramType)),
  };
}

function evaluatePeriod(
  records: PriorAwardRecord[],
  within: PriorAwardCriterionValue["within"],
  asOf: Date,
): "hit" | "miss" | "unknown" {
  if (records.length === 0) return "miss";
  if (!within) return "hit";
  let indeterminate = false;
  for (const item of records) {
    if (item.year === null || item.year === undefined) {
      indeterminate = true;
      continue;
    }
    if (within.unit === "year") {
      if (asOf.getUTCFullYear() - item.year <= within.value) return "hit";
      continue;
    }
    const currentYear = asOf.getUTCFullYear();
    const minimumAgeMonths = Math.max(0, (currentYear - item.year - 1) * 12 + 1);
    const maximumAgeMonths = Math.max(0, (currentYear - item.year + 1) * 12 - 1);
    if (maximumAgeMonths <= within.value) return "hit";
    if (minimumAgeMonths <= within.value) indeterminate = true;
  }
  return indeterminate ? "unknown" : "miss";
}

function polarity(kind: CriterionKind, hit: boolean, label: string, companyValue?: unknown): PriorAwardEvaluation {
  if (kind === "exclusion") return {
    result: hit ? "fail" : "pass",
    message: hit ? `${label} 해당(자가신고 기준)` : `${label} 해당 없음(자가신고 기준)`,
    ...(companyValue !== undefined ? { companyValue } : {}),
  };
  if (kind === "required") return {
    result: hit ? "pass" : "fail",
    message: hit ? `${label} 이력 확인` : `${label} 필수 이력 없음`,
    ...(companyValue !== undefined ? { companyValue } : {}),
  };
  return {
    result: "pass",
    message: hit ? `${label} 우대 이력 확인` : `${label} 우대 이력 해당 없음`,
    ...(companyValue !== undefined ? { companyValue } : {}),
  };
}

function unknown(message: string, companyValue?: unknown): PriorAwardEvaluation {
  return { result: "unknown", message, ...(companyValue !== undefined ? { companyValue } : {}) };
}
function selfKindLabel(value: PriorAwardSelfKind): string {
  const labels: Record<PriorAwardSelfKind, string> = {
    current_similar: "현재 동일·유사 정부지원 수행·수혜 여부",
    same_project: "동일 과제의 다른 지원 동시 참여 여부",
    same_business_prior: "본 사업 과거 선정·입상 여부",
    same_year_other_support: "당해연도 타 부처·공공기관 유사 지원 중복 여부",
  };
  return labels[value];
}
function programKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("free:") && trimmed.length > "free:".length) return trimmed;
  return normalizePriorAwardProgramLabel(trimmed) ?? `free:${trimmed.toLowerCase().replace(/[\s·ㆍ_\-/()]/g, "")}`;
}
function isSelfKind(value: unknown): value is PriorAwardSelfKind {
  return value === "current_similar" || value === "same_project" || value === "same_business_prior" || value === "same_year_other_support";
}
function states(value: unknown): Array<"participating" | "completed" | "graduated"> {
  return strings(value).filter((item): item is "participating" | "completed" | "graduated" =>
    item === "participating" || item === "completed" || item === "graduated");
}
function validWithin(value: unknown): { value: number; unit: "year" | "month" } | null {
  const row = record(value);
  return typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0 &&
    (row.unit === "year" || row.unit === "month")
    ? { value: row.value, unit: row.unit }
    : null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
