import {
  CRITERION_DIMENSIONS,
  CRITERION_KINDS,
  CRITERION_OPERATORS,
  ELIGIBILITIES,
  type CompanyProfile,
  type CriterionDimension,
  type CriterionKind,
  type CriterionOperator,
  type Eligibility,
} from "@cunote/contracts";

export type V3LabelStatus = "legacy" | "draft" | "reviewed";

export interface V3AnnotationBase {
  schemaVersion: "matching-v3";
  labelStatus: V3LabelStatus;
  annotatorId?: string | null;
  reviewerId?: string | null;
  annotatedAt?: string | null;
  reviewedAt?: string | null;
}

export interface V3CompanyAnnotation extends V3AnnotationBase {
  recordType: "company";
  companyId: string;
  businessKind: "individual" | "corporation" | "unknown";
  profile: CompanyProfile;
  sourceFixture: string;
}

export interface V3CriterionAnnotation {
  criterionId: string;
  dimension: CriterionDimension;
  kind: CriterionKind;
  operator: CriterionOperator;
  value: unknown;
  sourceSpan: string | null;
  sourceField: string | null;
  annotationConfidence: number;
  note: string | null;
}

export interface V3GrantAnnotation extends V3AnnotationBase {
  recordType: "grant";
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  audience: "company" | "individual" | "mixed" | "unknown";
  criteria: V3CriterionAnnotation[];
  textOnlyConditions?: Array<{ sourceSpan: string; reason: string }>;
  sourceFixture: string;
  sourceRevision?: string | null;
}

export interface V3EligibilityPairAnnotation extends V3AnnotationBase {
  recordType: "eligibility_pair";
  pairId: string;
  grantId: string;
  companyId: string;
  expectedEligibility: Eligibility;
  split: "development" | "holdout";
  hardFailCriterionIds: string[];
  unknownCriterionIds: string[];
  resolvableByProfileInput: boolean | null;
  note: string;
  /** Engine provenance is optional only for loading pre-provenance draft packets. */
  rulesetVer?: string;
  scoringVer?: string;
  inputFingerprint?: string;
}

export type V3AnnotationRecord =
  | V3CompanyAnnotation
  | V3GrantAnnotation
  | V3EligibilityPairAnnotation;

export interface V3AnnotationDataset {
  records: V3AnnotationRecord[];
  companies: V3CompanyAnnotation[];
  grants: V3GrantAnnotation[];
  eligibilityPairs: V3EligibilityPairAnnotation[];
}

export function parseV3AnnotationJsonl(text: string, sourceName = "annotation.jsonl"): V3AnnotationDataset {
  const records = text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((entry) => entry.line.length > 0 && !entry.line.startsWith("#"))
    .map((entry) => parseRecord(entry.line, `${sourceName}:${entry.lineNumber}`));

  assertUnique(records.filter((record): record is V3CompanyAnnotation => record.recordType === "company"), "companyId", sourceName);
  assertUnique(records.filter((record): record is V3GrantAnnotation => record.recordType === "grant"), "grantId", sourceName);
  assertUnique(records.filter((record): record is V3EligibilityPairAnnotation => record.recordType === "eligibility_pair"), "pairId", sourceName);

  return {
    records,
    companies: records.filter((record): record is V3CompanyAnnotation => record.recordType === "company"),
    grants: records.filter((record): record is V3GrantAnnotation => record.recordType === "grant"),
    eligibilityPairs: records.filter((record): record is V3EligibilityPairAnnotation => record.recordType === "eligibility_pair"),
  };
}

function parseRecord(line: string, location: string): V3AnnotationRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`${location}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = requireRecord(value, location);
  if (record.schemaVersion !== "matching-v3") throw new Error(`${location}: schemaVersion must be matching-v3`);
  if (!isOneOf(record.labelStatus, ["legacy", "draft", "reviewed"] as const)) {
    throw new Error(`${location}: invalid labelStatus`);
  }
  let parsed: V3AnnotationRecord;
  if (record.recordType === "company") parsed = parseCompany(record, location);
  else if (record.recordType === "grant") parsed = parseGrant(record, location);
  else if (record.recordType === "eligibility_pair") parsed = parseEligibilityPair(record, location);
  else throw new Error(`${location}: invalid recordType`);
  assertReviewedMetadata(parsed, location);
  return parsed;
}

function parseCompany(record: Record<string, unknown>, location: string): V3CompanyAnnotation {
  const businessKind = record.businessKind;
  if (!isOneOf(businessKind, ["individual", "corporation", "unknown"] as const)) {
    throw new Error(`${location}: invalid businessKind`);
  }
  return {
    ...baseFields(record),
    recordType: "company",
    companyId: requireString(record.companyId, `${location}.companyId`),
    businessKind,
    profile: requireRecord(record.profile, `${location}.profile`) as CompanyProfile,
    sourceFixture: requireString(record.sourceFixture, `${location}.sourceFixture`),
  };
}

function parseGrant(record: Record<string, unknown>, location: string): V3GrantAnnotation {
  const audience = record.audience;
  if (!isOneOf(audience, ["company", "individual", "mixed", "unknown"] as const)) {
    throw new Error(`${location}: invalid audience`);
  }
  if (!Array.isArray(record.criteria)) throw new Error(`${location}.criteria must be an array`);
  const source = requireString(record.source, `${location}.source`);
  const sourceId = requireString(record.sourceId, `${location}.sourceId`);
  const grantId = requireString(record.grantId, `${location}.grantId`);
  if (grantId !== `${source}:${sourceId}`) throw new Error(`${location}: grantId must equal source:sourceId`);
  return {
    ...baseFields(record),
    recordType: "grant",
    grantId,
    source,
    sourceId,
    title: requireString(record.title, `${location}.title`),
    audience,
    criteria: record.criteria.map((criterion, index) =>
      parseCriterion(requireRecord(criterion, `${location}.criteria[${index}]`), `${location}.criteria[${index}]`)),
    sourceFixture: requireString(record.sourceFixture, `${location}.sourceFixture`),
    ...(typeof record.sourceRevision === "string" || record.sourceRevision === null
      ? { sourceRevision: record.sourceRevision }
      : {}),
  };
}

function assertReviewedMetadata(record: V3AnnotationRecord, location: string): void {
  if (record.labelStatus !== "reviewed") return;
  const annotatorId = cleanString(record.annotatorId);
  const reviewerId = cleanString(record.reviewerId);
  const annotatedAt = isoDate(record.annotatedAt);
  const reviewedAt = isoDate(record.reviewedAt);
  if (!annotatorId) throw new Error(`${location}: reviewed record requires annotatorId`);
  if (!reviewerId) throw new Error(`${location}: reviewed record requires reviewerId`);
  if (annotatorId.toLocaleLowerCase("en-US") === reviewerId.toLocaleLowerCase("en-US")) {
    throw new Error(`${location}: reviewed record requires an independent reviewer`);
  }
  if (/(^|[^a-z])(ai|llm|gpt|claude|codex|gemini|anthropic|openai)([^a-z]|$)/i.test(reviewerId)) {
    throw new Error(`${location}: reviewerId must identify a human reviewer`);
  }
  if (!annotatedAt) throw new Error(`${location}: reviewed record requires valid annotatedAt`);
  if (!reviewedAt) throw new Error(`${location}: reviewed record requires valid reviewedAt`);
  if (reviewedAt.getTime() < annotatedAt.getTime()) {
    throw new Error(`${location}: reviewedAt must not precede annotatedAt`);
  }
  if (record.recordType === "grant" && !cleanString(record.sourceRevision)) {
    throw new Error(`${location}: reviewed grant requires sourceRevision`);
  }
}

function cleanString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoDate(value: string | null | undefined): Date | null {
  const text = cleanString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseCriterion(record: Record<string, unknown>, location: string): V3CriterionAnnotation {
  if (!isOneOf(record.dimension, CRITERION_DIMENSIONS)) throw new Error(`${location}: invalid dimension`);
  if (!isOneOf(record.kind, CRITERION_KINDS)) throw new Error(`${location}: invalid kind`);
  if (!isOneOf(record.operator, CRITERION_OPERATORS)) throw new Error(`${location}: invalid operator`);
  if (typeof record.annotationConfidence !== "number" || record.annotationConfidence < 0 || record.annotationConfidence > 1) {
    throw new Error(`${location}: annotationConfidence must be 0..1`);
  }
  return {
    criterionId: requireString(record.criterionId, `${location}.criterionId`),
    dimension: record.dimension,
    kind: record.kind,
    operator: record.operator,
    value: record.value,
    sourceSpan: nullableString(record.sourceSpan, `${location}.sourceSpan`),
    sourceField: nullableString(record.sourceField, `${location}.sourceField`),
    annotationConfidence: record.annotationConfidence,
    note: nullableString(record.note, `${location}.note`),
  };
}

function parseEligibilityPair(record: Record<string, unknown>, location: string): V3EligibilityPairAnnotation {
  if (!isOneOf(record.expectedEligibility, ELIGIBILITIES)) throw new Error(`${location}: invalid expectedEligibility`);
  if (!isOneOf(record.split, ["development", "holdout"] as const)) throw new Error(`${location}: invalid split`);
  return {
    ...baseFields(record),
    recordType: "eligibility_pair",
    pairId: requireString(record.pairId, `${location}.pairId`),
    grantId: requireString(record.grantId, `${location}.grantId`),
    companyId: requireString(record.companyId, `${location}.companyId`),
    expectedEligibility: record.expectedEligibility,
    split: record.split,
    hardFailCriterionIds: stringArray(record.hardFailCriterionIds, `${location}.hardFailCriterionIds`),
    unknownCriterionIds: stringArray(record.unknownCriterionIds, `${location}.unknownCriterionIds`),
    resolvableByProfileInput: nullableBoolean(record.resolvableByProfileInput, `${location}.resolvableByProfileInput`),
    note: requireString(record.note, `${location}.note`),
    ...(record.rulesetVer === undefined ? {} : { rulesetVer: requireString(record.rulesetVer, `${location}.rulesetVer`) }),
    ...(record.scoringVer === undefined ? {} : { scoringVer: requireString(record.scoringVer, `${location}.scoringVer`) }),
    ...(record.inputFingerprint === undefined
      ? {}
      : { inputFingerprint: requireString(record.inputFingerprint, `${location}.inputFingerprint`) }),
  };
}

function baseFields(record: Record<string, unknown>): V3AnnotationBase {
  return {
    schemaVersion: "matching-v3",
    labelStatus: record.labelStatus as V3LabelStatus,
    ...(typeof record.annotatorId === "string" || record.annotatorId === null ? { annotatorId: record.annotatorId } : {}),
    ...(typeof record.reviewerId === "string" || record.reviewerId === null ? { reviewerId: record.reviewerId } : {}),
    ...(typeof record.annotatedAt === "string" || record.annotatedAt === null ? { annotatedAt: record.annotatedAt } : {}),
    ...(typeof record.reviewedAt === "string" || record.reviewedAt === null ? { reviewedAt: record.reviewedAt } : {}),
  };
}

function assertUnique<T extends Record<K, string>, K extends keyof T>(records: T[], key: K, sourceName: string): void {
  const values = new Set<string>();
  for (const record of records) {
    if (values.has(record[key])) throw new Error(`${sourceName}: duplicate ${String(key)} ${record[key]}`);
    values.add(record[key]);
  }
}

function requireRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, location: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${location} must be string or null`);
  return value;
}

function nullableBoolean(value: unknown, location: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${location} must be boolean or null`);
  return value;
}

function stringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${location} must be a string array`);
  }
  return value;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
