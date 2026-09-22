import { hashGrantRawPayload } from "./grantRawHash";

export const GRANT_SOURCE_CHANGE_IMPACT_SCHEMA = "grant-source-change-impact-v1" as const;

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

/**
 * 수집 시점의 이전·현재 source projection을 소비 기능별로 비교한다.
 * raw 전체가 바뀌어도 eligibility 입력이 그대로면 모델 재실행으로 보내지 않는다.
 */
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

/** 모델 입력에 실제 노출되는 자격·예외 구역만 봉인한다. 관측 시각과 조회수는 제외한다. */
function sourceCoverageFingerprint(source: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (source === "kstartup") {
    const detail = isRecord(payload.detail) ? payload.detail : {};
    return hashGrantRawPayload({
      pbanc_ctnt: payload.pbanc_ctnt ?? null,
      aply_trgt: payload.aply_trgt ?? null,
      aply_trgt_ctnt: payload.aply_trgt_ctnt ?? null,
      aply_excl_trgt_ctnt: payload.aply_excl_trgt_ctnt ?? null,
      prfn_matr: payload.prfn_matr ?? null,
      biz_enyy: payload.biz_enyy ?? null,
      biz_trgt_age: payload.biz_trgt_age ?? null,
      supt_regin: payload.supt_regin ?? null,
      supt_biz_clsfc: payload.supt_biz_clsfc ?? null,
      detail: {
        apply_method_text: detail.apply_method_text ?? null,
        submit_documents_text: detail.submit_documents_text ?? null,
        attachments: detail.attachments ?? null,
      },
    });
  }
  if (source === "bizinfo") {
    return hashGrantRawPayload({
      trgetNm: payload.trgetNm ?? null,
      pldirSportRealmLclasCodeNm: payload.pldirSportRealmLclasCodeNm ?? null,
      pldirSportRealmMlsfcCodeNm: payload.pldirSportRealmMlsfcCodeNm ?? null,
      reqstMthPapersCn: payload.reqstMthPapersCn ?? null,
      bsnsSumryCn: payload.bsnsSumryCn ?? null,
      hashtags: payload.hashtags ?? null,
    });
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
