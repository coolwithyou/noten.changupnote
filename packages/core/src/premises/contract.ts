import type {
  CompanyProfileFieldEvidence,
  CriterionResult,
  GrantCriterion,
  PremisesCriterionValue,
  PremisesFacilityType,
  PremisesLocation,
  PremisesProfileValue,
} from "@cunote/contracts";
import { isValidSidoCode } from "../criteria/regions.js";
import { REGION_LABELS } from "../kstartup/constants.js";

export const PREMISES_PROFILE_SCHEMA_VERSION = "premises-v1" as const;
export const PREMISES_PROFILE_PROVIDER = "cunote_profile_question" as const;
export const PREMISES_MAX_LOCATIONS = 10;

const FACILITY_TYPES = ["headquarters", "factory", "research_institute"] as const;
const FACILITY_TYPE_SET = new Set<string>(FACILITY_TYPES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface PremisesValidationIssue {
  path: string;
  message: string;
}

export type PremisesParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: PremisesValidationIssue[] };

export interface PremisesEvaluation {
  result: CriterionResult;
  message: string;
  companyValue?: PremisesProfileValue;
  unresolvedReason?: "company_profile_missing" | "criterion_invalid";
}

export class InvalidPremisesProfileError extends Error {
  readonly code = "invalid_premises_profile";

  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "InvalidPremisesProfileError";
  }
}

/** Exact premises-v1 criterion parser shared by authoring validation and matching. */
export function parsePremisesCriterionValue(value: unknown): PremisesParseResult<PremisesCriterionValue> {
  const issues: PremisesValidationIssue[] = [];
  const record = exactRecord(value, "value", [
    "schemaVersion",
    "state",
    "sidoCodes",
    "facilityTypes",
    "facilitySemantics",
    "basisDate",
  ], issues);
  if (!record) return { ok: false, issues };

  if (record.schemaVersion !== PREMISES_PROFILE_SCHEMA_VERSION) {
    issues.push({ path: "value.schemaVersion", message: "must be premises-v1." });
  }
  if (record.state !== "registered_current_site") {
    issues.push({ path: "value.state", message: "must be registered_current_site." });
  }
  if (record.facilitySemantics !== "any") {
    issues.push({ path: "value.facilitySemantics", message: "must be any." });
  }
  const sidoCodes = parseSidoCodes(record.sidoCodes, "value.sidoCodes", issues);
  const facilityTypes = parseFacilityTypes(record.facilityTypes, "value.facilityTypes", issues);
  const basisDate = parseDate(record.basisDate, "value.basisDate", issues);

  if (issues.length > 0 || !sidoCodes || !facilityTypes || !basisDate) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      schemaVersion: PREMISES_PROFILE_SCHEMA_VERSION,
      state: "registered_current_site",
      sidoCodes,
      facilityTypes,
      facilitySemantics: "any",
      basisDate,
    },
  };
}

/**
 * Fail-closed semantic admission for premises-v1 source evidence. It only checks that the
 * supplied typed value is directly supported; it never derives or repairs the value from text.
 */
export function inspectPremisesCriterionSourceCompatibility(input: {
  value: unknown;
  sourceSpan: unknown;
  note?: unknown;
}): PremisesParseResult<PremisesCriterionValue> {
  const parsed = parsePremisesCriterionValue(input.value);
  if (!parsed.ok) return parsed;
  const issues: PremisesValidationIssue[] = [];
  const sourceSpan = typeof input.sourceSpan === "string" ? input.sourceSpan.trim() : "";
  if (!sourceSpan) {
    return { ok: false, issues: [{ path: "source_span", message: "is required for premises-v1." }] };
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  const normalizedSource = sourceSpan.replace(/\s+/g, " ");
  const vetoText = `${sourceSpan}\n${note}`.replace(/\s+/g, " ");

  const unsafeSignals: Array<[RegExp, string]> = [
    [/이전\s*(?:예정|확약|계획)|입주\s*(?:예정|확약|완료)|(?:선정|협약|사업기간|지원)\s*(?:후|전|종료)|\d+\s*(?:일|개월|년)\s*이내/i, "future premises intent is outside premises-v1."],
    [/공장등록증|사업자등록증|법인등기부|등기부등본|등록증상|증빙(?:서류|자료)?|서류상/i, "document-specific proof is outside premises-v1."],
    [/\d+\s*(?:개월|년)\s*(?:이상|동안|계속)|계속하여|연속하여|소재\s*기간/i, "premises tenure is outside premises-v1."],
    [/특정\s*(?:건물|시설)|(?:지원|창업|아트|업사이클|테크노)\s*센터|산업단지|캠퍼스|입주공간/i, "specific venue requirements are outside premises-v1."],
    [/(?:본사|공장|연구소)[^.!?\n]{0,12}\s등(?:\s|을|이|의|$)/i, "open-ended facility alternatives are outside premises-v1."],
  ];
  for (const [pattern, message] of unsafeSignals) {
    if (pattern.test(vetoText)) issues.push({ path: "source_span", message });
  }
  if (/없(?:는|음|거나)?|아닌|않|미보유|미등록|제외|불문|다만|예외|경우에도|에만|오직|동시에|모두/.test(vetoText)) {
    issues.push({ path: "source_span", message: "negation, exception, exclusivity, or all-of semantics are outside premises-v1." });
  }
  if (/(?:본사|공장|연구소)[^.!?\n]{0,12}(?:및|와|과)[^.!?\n]{0,12}(?:본사|공장|연구소)/.test(vetoText)) {
    issues.push({ path: "source_span", message: "all-of facility relations are outside premises-v1." });
  }

  const withoutSidoNames = Object.values(REGION_LABELS)
    .flatMap((label) => sidoLabelVariants(label))
    .sort((left, right) => right.length - left.length)
    .reduce((text, label) => text.replaceAll(label, ""), vetoText);
  if (/[가-힣]{2,}(?:시|군|구)(?=\s|에|내|에서|소재|관내|$)/.test(withoutSidoNames)) {
    issues.push({ path: "source_span", message: "city or district requirements are outside premises-v1." });
  }

  const value = parsed.value;
  if (value.sidoCodes.length > 1 && value.facilityTypes.length > 1) {
    issues.push({ path: "value", message: "province/facility paired alternatives cannot be represented by premises-v1." });
  }
  if (!sourceContainsBasisDate(normalizedSource, value.basisDate)) {
    issues.push({ path: "source_span", message: `must explicitly contain basisDate ${value.basisDate}.` });
  }
  if (!/등록(?:된|한|되어|사업장)/.test(normalizedSource)) {
    issues.push({ path: "source_span", message: "must explicitly state a currently registered premises relation." });
  }
  const sourceSidoCodes = Object.entries(REGION_LABELS)
    .flatMap(([code, label]) => sidoLabelVariants(label).some((candidate) => normalizedSource.includes(candidate)) ? [code] : [])
    .sort();
  if (!sameStrings(sourceSidoCodes, value.sidoCodes)) {
    issues.push({ path: "source_span", message: "must name exactly the same sido set as value.sidoCodes." });
  }
  const sourceFacilityTypes = FACILITY_TYPES
    .filter((facilityType) => facilityPatterns[facilityType].test(normalizedSource))
    .sort();
  if (!sameStrings(sourceFacilityTypes, value.facilityTypes)) {
    issues.push({ path: "source_span", message: "must name exactly the same facility set as value.facilityTypes." });
  }
  return issues.length > 0 ? { ok: false, issues } : parsed;
}

/**
 * Normalizes direct user input while stamping coverage.asOf from the trusted server boundary.
 * A client-supplied coverage.asOf is deliberately ignored rather than treated as provenance.
 */
export function normalizePremisesProfileValue(
  value: unknown,
  options: { asOf: string },
): PremisesProfileValue {
  const asOf = parseTimestamp(options.asOf, "asOf");
  if (!asOf) throw new InvalidPremisesProfileError("asOf는 유효한 ISO 시각이어야 합니다.", "asOf");
  const parsed = parsePremisesProfileValue(value, { trustedAsOf: asOf });
  if (!parsed.ok) {
    const first = parsed.issues[0] ?? { path: "value", message: "invalid premises profile." };
    throw new InvalidPremisesProfileError(`${first.path}: ${first.message}`, first.path);
  }
  return parsed.value;
}

/** Stored-profile parser. Unlike input normalization, it never repairs or re-stamps provenance. */
export function parseStoredPremisesProfileValue(value: unknown): PremisesParseResult<PremisesProfileValue> {
  return parsePremisesProfileValue(value, {});
}

/**
 * Evaluates only reviewed required/exists current-province criteria against exact private evidence.
 * Every unsupported or incomplete state remains unknown; no region or cross-location inference occurs.
 */
export function evaluatePremisesCriterion(input: {
  criterion: GrantCriterion;
  profile: unknown;
  evidence: CompanyProfileFieldEvidence | undefined;
  asOf: Date;
}): PremisesEvaluation {
  const criterion = input.criterion;
  if (
    criterion.dimension !== "premises" ||
    criterion.kind !== "required" ||
    criterion.operator !== "exists" ||
    criterion.needs_review !== false ||
    typeof criterion.source_span !== "string" ||
    criterion.source_span.trim().length === 0
  ) {
    return invalidCriterion();
  }
  const parsedCriterion = inspectPremisesCriterionSourceCompatibility({
    value: criterion.value,
    sourceSpan: criterion.source_span,
  });
  if (!parsedCriterion.ok) return invalidCriterion();
  const parsedProfile = parseStoredPremisesProfileValue(input.profile);
  if (!parsedProfile.ok) return missingProfile();
  const profile = parsedProfile.value;
  if (!premisesProfileEvidenceIsUsable(input.evidence, profile)) return missingProfile(profile);
  if (new Date(profile.coverage.asOf).getTime() > input.asOf.getTime()) return missingProfile(profile);
  if (profile.locations.length === 0) return missingProfile(profile);

  const value = parsedCriterion.value;
  const evaluationDate = koreaCalendarDate(input.asOf);
  if (!evaluationDate || value.basisDate > evaluationDate) return invalidCriterion(profile);
  const evidenceDate = koreaCalendarDate(new Date(profile.coverage.asOf));
  if (!evidenceDate || value.basisDate > evidenceDate) return missingProfile(profile);
  if (!dateInClosedInterval(value.basisDate, profile.coverage.validFrom, profile.coverage.validTo)) {
    return missingProfile(profile);
  }
  const activeLocations = profile.locations.filter((location) => locationCoversDate(location, value.basisDate));
  if (activeLocations.length === 0) return missingProfile(profile);
  const hit = activeLocations.some((location) =>
    profile.coverage.facilityTypes.includes(location.facilityType) &&
    value.facilityTypes.includes(location.facilityType) &&
    value.sidoCodes.includes(location.sidoCode));
  if (hit) {
    return {
      result: "pass",
      message: "기준일 현재 등록 사업장의 시도·시설 유형이 조건과 일치해요.",
      companyValue: profile,
    };
  }
  if (
    profile.coverage.completeness !== "complete" ||
    !value.facilityTypes.every((type) => profile.coverage.facilityTypes.includes(type))
  ) return missingProfile(profile);
  return {
    result: "fail",
    message: "기준일 현재 확인된 등록 사업장 중 시도·시설 유형 조건에 맞는 곳이 없어요.",
    companyValue: profile,
  };
}

function parsePremisesProfileValue(
  value: unknown,
  options: { trustedAsOf?: string },
): PremisesParseResult<PremisesProfileValue> {
  const issues: PremisesValidationIssue[] = [];
  const record = exactRecord(value, "value", ["schemaVersion", "locations", "coverage"], issues);
  if (!record) return { ok: false, issues };
  if (record.schemaVersion !== PREMISES_PROFILE_SCHEMA_VERSION) {
    issues.push({ path: "value.schemaVersion", message: "must be premises-v1." });
  }

  const locations: PremisesLocation[] = [];
  const seenLocationIds = new Set<string>();
  if (!Array.isArray(record.locations)) {
    issues.push({ path: "value.locations", message: "must be an array." });
  } else if (record.locations.length > PREMISES_MAX_LOCATIONS) {
    issues.push({ path: "value.locations", message: `must contain at most ${PREMISES_MAX_LOCATIONS} locations.` });
  } else {
    record.locations.forEach((location, index) => {
      const path = `value.locations.${index}`;
      const row = exactRecord(location, path, ["locationId", "facilityType", "sidoCode", "validFrom", "validTo"], issues);
      if (!row) return;
      const locationId = typeof row.locationId === "string" && UUID_PATTERN.test(row.locationId)
        ? row.locationId.toLowerCase()
        : null;
      if (!locationId) issues.push({ path: `${path}.locationId`, message: "must be a UUID." });
      else if (seenLocationIds.has(locationId)) issues.push({ path: `${path}.locationId`, message: "must be unique." });
      else seenLocationIds.add(locationId);
      const facilityType = parseFacilityType(row.facilityType, `${path}.facilityType`, issues);
      const sidoCode = typeof row.sidoCode === "string" && isValidSidoCode(row.sidoCode) ? row.sidoCode : null;
      if (!sidoCode) issues.push({ path: `${path}.sidoCode`, message: "must be a supported two-digit sido code." });
      const validFrom = parseDate(row.validFrom, `${path}.validFrom`, issues);
      const validTo = row.validTo === null ? null : parseDate(row.validTo, `${path}.validTo`, issues);
      if (validFrom && validTo && validFrom > validTo) {
        issues.push({ path, message: "validFrom must be on or before validTo." });
      }
      if (locationId && facilityType && sidoCode && validFrom && (row.validTo === null || validTo)) {
        locations.push({ locationId, facilityType, sidoCode, validFrom, validTo });
      }
    });
  }

  const coverage = exactRecord(record.coverage, "value.coverage", [
    "facilityTypes",
    "validFrom",
    "validTo",
    "asOf",
    "completeness",
  ], issues, options.trustedAsOf ? ["asOf"] : []);
  const facilityTypes = coverage
    ? parseFacilityTypes(coverage.facilityTypes, "value.coverage.facilityTypes", issues)
    : null;
  const coverageValidFrom = coverage
    ? parseDate(coverage.validFrom, "value.coverage.validFrom", issues)
    : null;
  const coverageValidTo = coverage
    ? parseDate(coverage.validTo, "value.coverage.validTo", issues)
    : null;
  const suppliedAsOf = coverage
    ? parseTimestamp(coverage.asOf, "value.coverage.asOf", options.trustedAsOf ? undefined : issues)
    : null;
  const coverageAsOf = options.trustedAsOf ?? suppliedAsOf;
  const completeness = coverage?.completeness === "partial" || coverage?.completeness === "complete"
    ? coverage.completeness
    : null;
  if (coverage && !completeness) {
    issues.push({ path: "value.coverage.completeness", message: "must be partial or complete." });
  }
  if (coverageValidFrom && coverageValidTo && coverageValidFrom > coverageValidTo) {
    issues.push({ path: "value.coverage", message: "validFrom must be on or before validTo." });
  }
  const asOfDate = coverageAsOf ? koreaCalendarDate(new Date(coverageAsOf)) : null;
  if (coverageValidTo && asOfDate && coverageValidTo > asOfDate) {
    issues.push({ path: "value.coverage.validTo", message: "must not be after the server asOf date." });
  }
  for (const [index, location] of locations.entries()) {
    if (asOfDate && location.validFrom > asOfDate) {
      issues.push({ path: `value.locations.${index}.validFrom`, message: "must not be after the server asOf date." });
    }
    if (asOfDate && location.validTo && location.validTo > asOfDate) {
      issues.push({ path: `value.locations.${index}.validTo`, message: "must not be after the server asOf date." });
    }
  }

  if (
    issues.length > 0 ||
    !facilityTypes ||
    !coverageValidFrom ||
    !coverageValidTo ||
    !coverageAsOf ||
    !completeness
  ) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schemaVersion: PREMISES_PROFILE_SCHEMA_VERSION,
      locations: [...locations].sort((left, right) => left.locationId.localeCompare(right.locationId)),
      coverage: {
        facilityTypes,
        validFrom: coverageValidFrom,
        validTo: coverageValidTo,
        asOf: coverageAsOf,
        completeness,
      },
    },
  };
}

export function premisesProfileEvidenceIsUsable(
  evidence: CompanyProfileFieldEvidence | undefined,
  profile: unknown,
): boolean {
  const parsed = parseStoredPremisesProfileValue(profile);
  if (!parsed.ok) return false;
  const stored = parsed.value;
  return Boolean(
    evidence &&
    evidence.sourceKind === "self_declared" &&
    evidence.provider === PREMISES_PROFILE_PROVIDER &&
    evidence.scope === "user" &&
    evidence.persistenceClass === "portable_user_answer" &&
    evidence.asOf === stored.coverage.asOf &&
    evidence.axisCompleteness === stored.coverage.completeness &&
    parseTimestamp(evidence.asOf, "evidence.asOf") === evidence.asOf,
  );
}

function invalidCriterion(companyValue?: PremisesProfileValue): PremisesEvaluation {
  return {
    result: "unknown",
    message: "사업장 조건 구조를 검수해야 해요.",
    ...(companyValue ? { companyValue } : {}),
    unresolvedReason: "criterion_invalid",
  };
}

function missingProfile(companyValue?: PremisesProfileValue): PremisesEvaluation {
  return {
    result: "unknown",
    message: "기준일에 맞는 등록 사업장 정보와 확인 범위가 필요해요.",
    ...(companyValue ? { companyValue } : {}),
    unresolvedReason: "company_profile_missing",
  };
}

function locationCoversDate(location: PremisesLocation, date: string): boolean {
  return location.validFrom <= date && (location.validTo === null || date <= location.validTo);
}

function dateInClosedInterval(date: string, from: string, to: string): boolean {
  return from <= date && date <= to;
}

function parseFacilityTypes(
  value: unknown,
  path: string,
  issues: PremisesValidationIssue[],
): PremisesFacilityType[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > FACILITY_TYPES.length) {
    issues.push({ path, message: `must contain 1-${FACILITY_TYPES.length} facility types.` });
    return null;
  }
  const result: PremisesFacilityType[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseFacilityType(item, `${path}.${index}`, issues);
    if (parsed) result.push(parsed);
  }
  if (new Set(result).size !== result.length) {
    issues.push({ path, message: "must not contain duplicates." });
  }
  return result.length === value.length ? [...result].sort() : null;
}

function parseFacilityType(
  value: unknown,
  path: string,
  issues: PremisesValidationIssue[],
): PremisesFacilityType | null {
  if (typeof value !== "string" || !FACILITY_TYPE_SET.has(value)) {
    issues.push({ path, message: "must be headquarters, factory, or research_institute." });
    return null;
  }
  return value as PremisesFacilityType;
}

function parseSidoCodes(
  value: unknown,
  path: string,
  issues: PremisesValidationIssue[],
): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 17) {
    issues.push({ path, message: "must contain 1-17 sido codes." });
    return null;
  }
  if (value.some((item) => typeof item !== "string" || !isValidSidoCode(item))) {
    issues.push({ path, message: "must contain only supported two-digit sido codes." });
    return null;
  }
  if (new Set(value).size !== value.length) {
    issues.push({ path, message: "must not contain duplicates." });
    return null;
  }
  return [...value].sort();
}

function parseDate(
  value: unknown,
  path: string,
  issues: PremisesValidationIssue[],
): string | null {
  if (typeof value !== "string" || !validCalendarDate(value)) {
    issues.push({ path, message: "must be an absolute YYYY-MM-DD calendar date." });
    return null;
  }
  return value;
}

function validCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  return normalized === value;
}

function parseTimestamp(
  value: unknown,
  path: string,
  issues?: PremisesValidationIssue[],
): string | null {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    issues?.push({ path, message: "must be a valid ISO timestamp." });
    return null;
  }
  return new Date(value).toISOString();
}

function koreaCalendarDate(value: Date): string | null {
  if (Number.isNaN(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function exactRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: PremisesValidationIssue[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({ path, message: "must be an object." });
    return null;
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, message: "additional property is not allowed." });
  }
  const optional = new Set(optionalKeys);
  for (const key of keys) {
    if (!(key in record) && !optional.has(key)) {
      issues.push({ path: `${path}.${key}`, message: "is required." });
    }
  }
  return record;
}

const facilityPatterns: Record<PremisesFacilityType, RegExp> = {
  headquarters: /본사/,
  factory: /공장/,
  research_institute: /연구소/,
};

function sourceContainsBasisDate(source: string, basisDate: string): boolean {
  const [year, month, day] = basisDate.split("-").map(Number);
  if (!year || !month || !day) return false;
  const escapedIso = basisDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(?:^|\\D)${escapedIso}\\s*(?:현재|기준)(?:\\D|$)`),
    new RegExp(`${year}\\s*[.]\\s*0?${month}\\s*[.]\\s*0?${day}\\s*[.]?\\s*(?:현재|기준)`),
    new RegExp(`${year}\\s*년\\s*0?${month}\\s*월\\s*0?${day}\\s*일\\s*(?:현재|기준)`),
  ];
  return patterns.some((pattern) => pattern.test(source));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === [...right].sort()[index]);
}

function sidoLabelVariants(shortLabel: string): string[] {
  const official: Record<string, string[]> = {
    서울: ["서울", "서울특별시"],
    부산: ["부산", "부산광역시"],
    대구: ["대구", "대구광역시"],
    인천: ["인천", "인천광역시"],
    광주: ["광주", "광주광역시"],
    대전: ["대전", "대전광역시"],
    울산: ["울산", "울산광역시"],
    세종: ["세종", "세종특별자치시"],
    경기: ["경기", "경기도"],
    강원: ["강원", "강원특별자치도", "강원도"],
    충북: ["충북", "충청북도"],
    충남: ["충남", "충청남도"],
    전북: ["전북", "전북특별자치도", "전라북도"],
    전남: ["전남", "전라남도"],
    경북: ["경북", "경상북도"],
    경남: ["경남", "경상남도"],
    제주: ["제주", "제주특별자치도"],
  };
  return official[shortLabel] ?? [shortLabel];
}
