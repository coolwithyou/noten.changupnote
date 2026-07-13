import {
  updateCompanyProfileField,
  type CompanyProfileFieldUpdate,
} from "@cunote/core";
import type {
  CompanyProfile,
  CompanyProfileEvidenceSourceKind,
  CriterionDimension,
} from "@cunote/contracts";

export interface DevServiceDataProfileMetadata {
  sourceKind: CompanyProfileEvidenceSourceKind;
  provider: string;
  asOf: string | null;
  confidence: number | null;
  axisCompleteness: "partial" | "complete";
}

export interface DevServiceDataNormalizationFailure {
  code: "normalization_failed";
  field: "revenue" | "certification" | "insured_workforce";
  message: string;
}

export type DevServiceDataProfileNormalization =
  | { ok: true; profileUpdates: CompanyProfileFieldUpdate[] }
  | { ok: false; failure: DevServiceDataNormalizationFailure };

export interface DevInsuredWorkforceValue {
  employment_insurance_active?: unknown;
  insured_count?: unknown;
  months_since_last_layoff?: unknown;
  no_layoff?: unknown;
}

const EMPTY_PROFILE: CompanyProfile = { confidence: {} };

/** 원 단위 scalar를 표시 문자열과 분리해 matcher 입력으로 만든다. */
export function buildRevenueProfileUpdates(
  revenueWon: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("revenue", () => [
    validatedUpdate("revenue", nonNegativeInteger(revenueWon, "revenue_krw"), metadata),
  ]);
}

/**
 * partial은 positive-only 병합이고, complete만 소진적 목록 교체다.
 * present-only miss(partial + 빈 배열)는 미보유 evidence를 만들지 않는다.
 */
export function buildCertificationProfileUpdates(
  certifications: readonly unknown[],
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("certification", () => {
    const values = uniqueStrings(certifications, "certifications");
    if (values.length === 0 && metadata.axisCompleteness === "partial") return [];
    return [validatedUpdate("certification", values, metadata, {
      mode: metadata.axisCompleteness === "complete" ? "replace" : "merge",
    })];
  });
}

/** matcher가 읽는 고용보험 nested 계약을 명/개월 정수 단위로 만든다. */
export function buildInsuredWorkforceProfileUpdates(
  raw: DevInsuredWorkforceValue,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("insured_workforce", () => {
    const value: NonNullable<CompanyProfile["insured_workforce"]> = {};
    if (raw.employment_insurance_active !== undefined) {
      value.employment_insurance_active = booleanValue(
        raw.employment_insurance_active,
        "employment_insurance_active",
      );
    }
    if (raw.insured_count !== undefined) {
      value.insured_count = nonNegativeInteger(raw.insured_count, "insured_count");
    }
    if (raw.months_since_last_layoff !== undefined) {
      value.months_since_last_layoff = nonNegativeInteger(
        raw.months_since_last_layoff,
        "months_since_last_layoff",
      );
    }
    if (raw.no_layoff !== undefined) {
      value.no_layoff = booleanValue(raw.no_layoff, "no_layoff");
    }
    if (Object.keys(value).length === 0) {
      throw new Error("insured_workforce에 정규화할 값이 없습니다.");
    }
    if (value.no_layoff === true && value.months_since_last_layoff !== undefined) {
      throw new Error("감원 없음과 최근 감원 경과개월을 동시에 확정할 수 없습니다.");
    }
    return [validatedUpdate("insured_workforce", value, metadata)];
  });
}

function normalize(
  field: DevServiceDataNormalizationFailure["field"],
  build: () => CompanyProfileFieldUpdate[],
): DevServiceDataProfileNormalization {
  try {
    return { ok: true, profileUpdates: build() };
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: "normalization_failed",
        field,
        message: error instanceof Error ? error.message.slice(0, 160) : "프로필 값 정규화 실패",
      },
    };
  }
}

function validatedUpdate(
  field: CriterionDimension,
  value: unknown,
  metadata: DevServiceDataProfileMetadata,
  options: { mode?: CompanyProfileFieldUpdate["mode"] } = {},
): CompanyProfileFieldUpdate {
  const provider = metadata.provider.trim();
  if (!provider) throw new Error("provider가 비어 있습니다.");
  if (
    metadata.confidence !== null &&
    (!Number.isFinite(metadata.confidence) || metadata.confidence < 0 || metadata.confidence > 1)
  ) {
    throw new Error("confidence는 0 이상 1 이하이어야 합니다.");
  }
  const update: CompanyProfileFieldUpdate = {
    field,
    value,
    confidence: metadata.confidence,
    sourceKind: metadata.sourceKind,
    provider,
    asOf: metadata.asOf,
    axisCompleteness: metadata.axisCompleteness,
    ...(options.mode ? { mode: options.mode } : {}),
  };
  updateCompanyProfileField(EMPTY_PROFILE, update);
  return update;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field}는 0 이상의 숫자여야 합니다.`);
  }
  return Math.floor(parsed);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field}는 boolean이어야 합니다.`);
  return value;
}

function uniqueStrings(values: readonly unknown[], field: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field}.${index}는 비어 있지 않은 문자열이어야 합니다.`);
    }
    const normalized = value.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
