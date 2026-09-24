import { hashGrantRawPayload } from "./grantRawHash";

export const GRANT_SOURCE_CHANGE_IMPACT_SCHEMA = "grant-source-change-impact-v2" as const;

export type GrantSourceChangeClassification =
  | "initial"
  | "unchanged"
  | "evidence_refresh"
  | "recruitment_only"
  | "condition_review_required"
  | "coverage_review_required"
  | "unknown_review_required";

export type GrantSourceChangeDomain =
  | "raw"
  | "recruitment"
  | "eligibility"
  | "coverage"
  | "attachments"
  | "extractor_contract";

export interface GrantSourceChangeProjectionInput {
  readonly source: string;
  readonly rawPayload: unknown;
  readonly recruitment: unknown;
  readonly eligibility: unknown;
  readonly attachments: unknown;
  readonly extractorContract: unknown;
}

export interface GrantSourceChangeImpact {
  readonly schema: typeof GRANT_SOURCE_CHANGE_IMPACT_SCHEMA;
  readonly classification: GrantSourceChangeClassification;
  readonly changedDomains: readonly GrantSourceChangeDomain[];
  readonly previousRawSha256: string | null;
  readonly currentRawSha256: string;
  readonly requiresModelRun: false;
}

/** 수집 시점의 이전·현재 source projection을 비교한다. */
export function classifyGrantSourceChangeImpact(input: {
  readonly previous: GrantSourceChangeProjectionInput | null;
  readonly current: GrantSourceChangeProjectionInput;
}): GrantSourceChangeImpact {
  const current = fingerprints(input.current);
  if (!input.previous) return impact("initial", [], null, current.raw);

  const previous = fingerprints(input.previous);
  const changedDomains = domainOrder.filter((domain) => previous[domain] !== current[domain]);
  if (changedDomains.length === 0) {
    return impact("unchanged", changedDomains, previous.raw, current.raw);
  }

  const rawChanged = changedDomains.includes("raw");
  const sourceChanged = input.previous.source !== input.current.source;
  const coverageComparable = current.coverage !== null && previous.coverage !== null && !sourceChanged;
  let classification: GrantSourceChangeClassification;
  if (rawChanged && !coverageComparable) {
    classification = "unknown_review_required";
  } else if (changedDomains.includes("coverage") || changedDomains.includes("attachments")) {
    classification = "coverage_review_required";
  } else if (changedDomains.includes("eligibility") || changedDomains.includes("extractor_contract")) {
    classification = "condition_review_required";
  } else if (changedDomains.includes("recruitment")) {
    classification = "recruitment_only";
  } else {
    classification = "evidence_refresh";
  }
  return impact(classification, changedDomains, previous.raw, current.raw);
}

export function parseGrantSourceChangeImpact(value: unknown): GrantSourceChangeImpact | null {
  if (!isRecord(value) || value.schema !== GRANT_SOURCE_CHANGE_IMPACT_SCHEMA) return null;
  if (!classifications.has(String(value.classification))) return null;
  if (!Array.isArray(value.changedDomains)
    || value.changedDomains.some((domain) => !domains.has(String(domain)))) return null;
  if (value.previousRawSha256 !== null && !isSha(value.previousRawSha256)) return null;
  if (!isSha(value.currentRawSha256) || value.requiresModelRun !== false) return null;
  return Object.freeze({
    schema: GRANT_SOURCE_CHANGE_IMPACT_SCHEMA,
    classification: value.classification as GrantSourceChangeClassification,
    changedDomains: Object.freeze(value.changedDomains as GrantSourceChangeDomain[]),
    previousRawSha256: value.previousRawSha256 as string | null,
    currentRawSha256: value.currentRawSha256,
    requiresModelRun: false,
  });
}

const domainOrder: readonly GrantSourceChangeDomain[] = [
  "raw",
  "recruitment",
  "eligibility",
  "coverage",
  "attachments",
  "extractor_contract",
];
const domains = new Set<string>(domainOrder);
const classifications = new Set<string>([
  "initial",
  "unchanged",
  "evidence_refresh",
  "recruitment_only",
  "condition_review_required",
  "coverage_review_required",
  "unknown_review_required",
]);

interface GrantSourceFingerprints {
  readonly raw: string;
  readonly recruitment: string;
  readonly eligibility: string;
  readonly coverage: string | null;
  readonly attachments: string;
  readonly extractor_contract: string;
}

function fingerprints(input: GrantSourceChangeProjectionInput): GrantSourceFingerprints {
  return {
    raw: hashGrantRawPayload(input.rawPayload),
    recruitment: hashGrantRawPayload(input.recruitment),
    eligibility: hashGrantRawPayload(input.eligibility),
    coverage: sourceCoverageFingerprint(input.source, input.rawPayload),
    attachments: hashGrantRawPayload(input.attachments),
    extractor_contract: hashGrantRawPayload(input.extractorContract),
  };
}

/**
 * 모델 입력은 raw 전체를 포함한다. 의미 불변 자동 재결속은 알려진 관측 메타데이터만
 * 제외한 전체 raw가 같을 때 허용한다. 새 필드와 기간 문구도 검수로 보낸다.
 */
function sourceCoverageFingerprint(source: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (source === "kstartup") {
    const { detail, ...material } = payload;
    if (detail === undefined) return hashGrantRawPayload(material);
    if (!isRecord(detail)) return hashGrantRawPayload({ ...material, detail });
    const { fetched_at: _observedAt, ...materialDetail } = detail;
    return hashGrantRawPayload({ ...material, detail: materialDetail });
  }
  if (source === "bizinfo") {
    const { inqireCo: _views, ...material } = payload;
    return hashGrantRawPayload(material);
  }
  return null;
}

function impact(
  classification: GrantSourceChangeClassification,
  changedDomains: readonly GrantSourceChangeDomain[],
  previousRawSha256: string | null,
  currentRawSha256: string,
): GrantSourceChangeImpact {
  return Object.freeze({
    schema: GRANT_SOURCE_CHANGE_IMPACT_SCHEMA,
    classification,
    changedDomains: Object.freeze([...changedDomains]),
    previousRawSha256,
    currentRawSha256,
    requiresModelRun: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
