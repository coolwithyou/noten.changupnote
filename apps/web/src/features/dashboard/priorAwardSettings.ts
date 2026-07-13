import type {
  CompanyProfile,
  PriorAwardProfileValue,
  PriorAwardRecord,
  PriorAwardSelfKind,
  PriorAwardState,
} from "@cunote/contracts";
import {
  CANONICAL_PRIOR_AWARD_PROGRAMS,
  isPriorAwardProgramType,
  normalizePriorAwardProgramLabel,
} from "@cunote/core";

export type PriorAwardTriState = "unknown" | "yes" | "no";

export interface PriorAwardRecordDraft {
  id: string;
  program: string;
  agency: string;
  state: PriorAwardState;
  year: string;
}

export interface PriorAwardSettingsDraft {
  self: Record<PriorAwardSelfKind, PriorAwardTriState>;
  incubationTenancy: PriorAwardTriState;
  records: PriorAwardRecordDraft[];
  knownPrograms: string[];
  knownProgramTypes: string[];
}

const SELF_KINDS: readonly PriorAwardSelfKind[] = [
  "current_similar",
  "same_project",
  "same_business_prior",
  "same_year_other_support",
];

export function emptyPriorAwardSettingsDraft(): PriorAwardSettingsDraft {
  return {
    self: {
      current_similar: "unknown",
      same_project: "unknown",
      same_business_prior: "unknown",
      same_year_other_support: "unknown",
    },
    incubationTenancy: "unknown",
    records: [],
    knownPrograms: [],
    knownProgramTypes: [],
  };
}

export function priorAwardDraftFromProfile(profile: CompanyProfile | undefined): PriorAwardSettingsDraft {
  const draft = emptyPriorAwardSettingsDraft();
  if (!profile) return draft;
  const history = profile.prior_award_history;
  for (const kind of SELF_KINDS) {
    if (history?.self_flags?.[kind] !== undefined) {
      draft.self[kind] = history.self_flags[kind] ? "yes" : "no";
    }
  }
  if (history?.has_incubation_tenancy !== undefined) {
    draft.incubationTenancy = history.has_incubation_tenancy ? "yes" : "no";
  }
  const records: PriorAwardRecord[] = history?.records ?? (profile.prior_awards ?? []).map((program) => ({
    program,
    state: "completed" as const,
  }));
  draft.records = records.map((record, index) => ({
    id: `record-${index + 1}`,
    program: record.program ?? "",
    agency: record.agency ?? "",
    state: record.state,
    year: typeof record.year === "number" ? String(record.year) : "",
  }));
  draft.knownPrograms = [...(history?.known_programs ?? [])];
  draft.knownProgramTypes = [...(history?.known_program_types ?? [])];
  return draft;
}

export function buildPriorAwardProfileValue(draft: PriorAwardSettingsDraft): PriorAwardProfileValue {
  const records = draft.records.map((record, index) => {
    const program = record.program.trim();
    if (!program) throw new Error(`${index + 1}번째 이력의 사업명을 입력해 주세요.`);
    const year = parseYear(record.year, index);
    return {
      program: normalizePriorAwardProgramLabel(program) ?? program,
      ...(record.agency.trim() ? { agency: record.agency.trim() } : {}),
      state: record.state,
      ...(year !== undefined ? { year } : {}),
    };
  });
  const selfFlags: Partial<Record<PriorAwardSelfKind, boolean>> = {};
  for (const kind of SELF_KINDS) {
    if (draft.self[kind] !== "unknown") selfFlags[kind] = draft.self[kind] === "yes";
  }
  const knownPrograms = new Set(draft.knownPrograms.map(canonicalOrTrimmed).filter(Boolean));
  const knownProgramTypes = new Set(draft.knownProgramTypes.map(canonicalOrTrimmed).filter(Boolean));
  for (const record of records) {
    const program = record.program;
    if (isPriorAwardProgramType(program)) knownProgramTypes.add(program);
    else knownPrograms.add(program);
  }
  return {
    records,
    ...(Object.keys(selfFlags).length > 0 ? { self_flags: selfFlags } : {}),
    ...(draft.incubationTenancy !== "unknown"
      ? { has_incubation_tenancy: draft.incubationTenancy === "yes" }
      : {}),
    known_programs: [...knownPrograms],
    known_program_types: [...knownProgramTypes],
  };
}

export function isCanonicalProgramKnown(draft: PriorAwardSettingsDraft, key: string): boolean {
  const source = isPriorAwardProgramType(key) ? draft.knownProgramTypes : draft.knownPrograms;
  return source.some((program) => canonicalOrTrimmed(program) === key);
}

export function setCanonicalProgramKnown(
  draft: PriorAwardSettingsDraft,
  key: string,
  known: boolean,
): PriorAwardSettingsDraft {
  const field = isPriorAwardProgramType(key) ? "knownProgramTypes" : "knownPrograms";
  const current = draft[field].filter((program) => canonicalOrTrimmed(program) !== key);
  return { ...draft, [field]: known ? [...current, key] : current };
}

export function newPriorAwardRecordDraft(id: string): PriorAwardRecordDraft {
  return { id, program: "", agency: "", state: "completed", year: "" };
}

export const PRIOR_AWARD_PROGRAM_OPTIONS = CANONICAL_PRIOR_AWARD_PROGRAMS.map((program) => ({
  key: program.key,
  label: program.label,
  isProgramType: program.isProgramType,
}));

function parseYear(value: string, index: number): number | undefined {
  if (!value.trim()) return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new Error(`${index + 1}번째 이력 연도는 1900~2100 사이여야 합니다.`);
  }
  return year;
}

function canonicalOrTrimmed(value: string): string {
  const trimmed = value.trim();
  return normalizePriorAwardProgramLabel(trimmed) ?? trimmed;
}
