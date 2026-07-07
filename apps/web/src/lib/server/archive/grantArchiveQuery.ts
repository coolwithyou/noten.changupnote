import {
  APPLY_METHOD_CHANNELS,
  CRITERION_DIMENSIONS,
  GRANT_BENEFIT_FAMILIES,
} from "@cunote/contracts";
import type {
  CriterionDimension,
  GrantBenefitFamily,
  GrantSource,
  GrantStatus,
} from "@cunote/contracts";
import type { GrantArchiveQuery, GrantArchiveSort } from "./grantArchiveSearch";

const GRANT_SOURCES = ["kstartup", "bizinfo", "bizinfo_event"] as const satisfies GrantSource[];
const GRANT_STATUSES = ["upcoming", "open", "closed", "unknown"] as const satisfies GrantStatus[];
const ARCHIVE_SORTS = ["updated", "deadline", "start_date", "title", "confidence"] as const satisfies GrantArchiveSort[];

export interface GrantArchiveQueryError {
  code: string;
  message: string;
  field: string;
  status: number;
}

export type GrantArchiveQueryResult =
  | { ok: true; query: GrantArchiveQuery }
  | { ok: false; error: GrantArchiveQueryError };

export function parseGrantArchiveQuery(request: Request): GrantArchiveQueryResult {
  return parseGrantArchiveSearchParams(new URL(request.url).searchParams);
}

export function parseGrantArchiveSearchParams(params: URLSearchParams): GrantArchiveQueryResult {
  const sort = params.get("sort") ?? undefined;
  const view = params.get("view") ?? undefined;
  const cursor = params.get("cursor");
  const limit = params.get("limit");
  const deadlineWithinDays = params.get("deadlineWithinDays");
  const minConfidence = params.get("minConfidence");
  const sources = parseEnumList(params, "source", GRANT_SOURCES);
  const statuses = parseEnumList(params, "status", GRANT_STATUSES);
  const benefitFamilies = parseEnumList(params, "benefit", GRANT_BENEFIT_FAMILIES);
  const applyMethods = parseEnumList(params, "applyMethod", APPLY_METHOD_CHANNELS);

  if (!sources.ok) return invalidQuery("source", `source는 ${GRANT_SOURCES.join(", ")} 중 하나여야 합니다.`);
  if (!statuses.ok) return invalidQuery("status", `status는 ${GRANT_STATUSES.join(", ")} 중 하나여야 합니다.`);
  if (!benefitFamilies.ok) return invalidQuery("benefit", `benefit은 ${GRANT_BENEFIT_FAMILIES.join(", ")} 중 하나여야 합니다.`);
  if (!applyMethods.ok) return invalidQuery("applyMethod", `applyMethod는 ${APPLY_METHOD_CHANNELS.join(", ")} 중 하나여야 합니다.`);
  if (sort && !ARCHIVE_SORTS.includes(sort as GrantArchiveSort)) {
    return invalidQuery("sort", `sort는 ${ARCHIVE_SORTS.join(", ")} 중 하나여야 합니다.`);
  }
  if (view && view !== "list" && view !== "calendar" && view !== "gantt") {
    return invalidQuery("view", "view는 list, calendar, gantt 중 하나여야 합니다.");
  }
  if (cursor && !isNonNegativeInteger(cursor)) {
    return invalidQuery("cursor", "cursor는 0 이상의 정수 오프셋이어야 합니다.");
  }

  let parsedLimit: number | undefined;
  if (limit) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      return invalidQuery("limit", "limit은 1 이상 100 이하의 정수여야 합니다.");
    }
    parsedLimit = value;
  }

  let parsedDeadline: number | undefined;
  if (deadlineWithinDays) {
    const value = Number(deadlineWithinDays);
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      return invalidQuery("deadlineWithinDays", "deadlineWithinDays는 0 이상 365 이하의 정수여야 합니다.");
    }
    parsedDeadline = value;
  }

  let parsedMinConfidence: number | undefined;
  if (minConfidence) {
    const value = Number(minConfidence);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return invalidQuery("minConfidence", "minConfidence는 0 이상 1 이하의 숫자여야 합니다.");
    }
    parsedMinConfidence = value;
  }

  const criterionFilters = parseCriterionFilters(params);
  if (!criterionFilters.ok) return criterionFilters;

  return {
    ok: true,
    query: buildQuery({
      q: params.get("q"),
      sources: sources.values,
      statuses: statuses.values,
      agencyJurisdictions: parseTextList(params, "agencyJurisdiction"),
      agencyOperators: parseTextList(params, "agencyOperator"),
      agencies: parseTextList(params, "agency"),
      categoryL1: parseTextList(params, "categoryL1"),
      categoryL2: parseTextList(params, "categoryL2"),
      benefitFamilies: benefitFamilies.values,
      applyMethods: applyMethods.values,
      criterionFilters: criterionFilters.query,
      applyStartFrom: params.get("applyStartFrom"),
      applyStartTo: params.get("applyStartTo"),
      applyEndFrom: params.get("applyEndFrom"),
      applyEndTo: params.get("applyEndTo"),
      deadlineWithinDays: parsedDeadline,
      hasRequiredDocuments: parseBoolean(params.get("hasRequiredDocuments")),
      hasDraftableDocuments: parseBoolean(params.get("hasDraftableDocuments")),
      hasArchivedAttachments: parseBoolean(params.get("hasArchivedAttachments")),
      needsReview: parseBoolean(params.get("needsReview")),
      textOnly: parseBoolean(params.get("textOnly")),
      minConfidence: parsedMinConfidence,
      sort: sort as GrantArchiveSort | undefined,
      view,
      cursor,
      limit: parsedLimit,
    }),
  };
}

function parseCriterionFilters(params: URLSearchParams): { ok: true; query: NonNullable<GrantArchiveQuery["criterionFilters"]> } | { ok: false; error: GrantArchiveQueryError } {
  const query: NonNullable<GrantArchiveQuery["criterionFilters"]> = [];
  for (const dimension of CRITERION_DIMENSIONS) {
    const values = parseTextList(params, `criterion.${dimension}`) ?? [];
    if (values.length > 0) {
      query.push({ dimension, values });
    }
  }

  for (const raw of splitValues(params.getAll("criterion"))) {
    const [dimension, value] = raw.split(":", 2);
    if (!isCriterionDimension(dimension)) {
      return invalidQuery("criterion", `criterion은 dimension:value 형식이어야 하며 dimension은 ${CRITERION_DIMENSIONS.join(", ")} 중 하나여야 합니다.`);
    }
    if (!value?.trim()) {
      return invalidQuery("criterion", "criterion 값은 비어 있을 수 없습니다.");
    }
    const existing = query.find((filter) => filter.dimension === dimension);
    if (existing) {
      existing.values = [...(existing.values ?? []), value.trim()];
    } else {
      query.push({ dimension, values: [value.trim()] });
    }
  }

  return { ok: true, query };
}

function parseEnumList<const T extends readonly string[]>(
  params: URLSearchParams,
  key: string,
  allowed: T,
): { ok: true; values: T[number][] | undefined } | { ok: false } {
  const values = splitValues(params.getAll(key));
  if (values.length === 0) return { ok: true, values: undefined };
  const invalid = values.some((value) => !allowed.includes(value));
  if (invalid) return { ok: false };
  return { ok: true, values: [...new Set(values)] as T[number][] };
}

function parseTextList(params: URLSearchParams, key: string): string[] | undefined {
  const values = splitValues(params.getAll(key));
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function splitValues(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildQuery(input: Record<string, unknown>): GrantArchiveQuery {
  const result: GrantArchiveQuery = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

function parseBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function isNonNegativeInteger(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0;
}

function isCriterionDimension(value: string | undefined): value is CriterionDimension {
  return Boolean(value && CRITERION_DIMENSIONS.includes(value as CriterionDimension));
}

function invalidQuery(field: string, message: string): { ok: false; error: GrantArchiveQueryError } {
  return {
    ok: false,
    error: {
      code: "invalid_archive_query",
      message,
      field,
      status: 400,
    },
  };
}
