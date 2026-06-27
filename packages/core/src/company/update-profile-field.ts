import type { CompanyProfile, CriterionDimension } from "@cunote/contracts";

export interface CompanyProfileFieldUpdate {
  field: CriterionDimension;
  value: unknown;
  confidence?: number | null;
}

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

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
