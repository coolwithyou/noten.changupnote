import type { CriterionDimension } from "@cunote/contracts";

/**
 * 값이 들어온 물리 provider와 별개로, 매칭 프로필에서 그 값을 어떤 증거로 취급할지 나타낸다.
 */
export type EvidenceSourceKind =
  | "authoritative_api"
  | "public_registry"
  | "auth_supplied"
  | "self_declared"
  | "derived";

/** 부모 축 전체를 판정할 수 있는지 나타내는 보수적인 완전성 계약. */
export type AxisCompleteness = "complete" | "partial" | "unknown" | "not_applicable";

export type AutofillCoverageStatus =
  | "self-declared"
  | "pending"
  | "live"
  | "cache"
  | "failed"
  | "n/a";

/** 예약축 premises/export_performance와 자유입력 other를 제외한 운영 구조화 19축. */
export const OPERATIONAL_AUTOFILL_DIMENSIONS = [
  "region",
  "biz_age",
  "industry",
  "size",
  "revenue",
  "employees",
  "founder_age",
  "founder_trait",
  "certification",
  "prior_award",
  "ip",
  "target_type",
  "business_status",
  "tax_compliance",
  "credit_status",
  "sanction",
  "financial_health",
  "insured_workforce",
  "investment",
] as const satisfies readonly CriterionDimension[];

export type OperationalAutofillDimension = (typeof OPERATIONAL_AUTOFILL_DIMENSIONS)[number];

const OPERATIONAL_DIMENSION_SET = new Set<CriterionDimension>(OPERATIONAL_AUTOFILL_DIMENSIONS);
const FILLED_STATUSES = new Set<AutofillCoverageStatus>(["live", "cache", "self-declared"]);
const AUTHORITATIVE_SOURCE_KINDS = new Set<EvidenceSourceKind>([
  "authoritative_api",
  "public_registry",
]);

export interface AutofillCoverageRow {
  dimension: CriterionDimension | null;
  parentKey: string | null;
  status: AutofillCoverageStatus;
  sourceKind: EvidenceSourceKind | null;
  axisCompleteness: AxisCompleteness;
}

export interface CoverageRatio {
  numerator: number;
  denominator: number;
  ratio: number;
}

export interface AutofillCoverageMetrics {
  authoritative_axis_coverage: CoverageRatio;
  total_answered_coverage: CoverageRatio;
  grant_weighted_coverage: CoverageRatio;
}

export type AutofillGrantWeights = Partial<Record<CriterionDimension, number>>;

/**
 * provider 이름만으로 증거 종류를 정하지 못하는 두 예외(CODEF 인증 입력, registry)를
 * 한 곳에서 분류한다. 나머지 실제 API provider는 authoritative_api로 취급한다.
 */
export function classifyEvidenceSourceKind(input: {
  provider: string | null;
  dimension: CriterionDimension | null;
  status?: AutofillCoverageStatus;
}): EvidenceSourceKind | null {
  if (input.status === "self-declared" || input.provider === "manual") return "self_declared";
  if (input.provider === "derived") return "derived";
  if (input.provider === "registry") return "public_registry";
  if (
    input.provider === "codef" &&
    (input.dimension === "founder_age" || input.dimension === "founder_trait")
  ) {
    return "auth_supplied";
  }
  return input.provider ? "authoritative_api" : null;
}

/** 하위 플래그 한 건은 부모 축 전체를 complete로 만들지 않는다. */
export function defaultAxisCompleteness(input: {
  status: AutofillCoverageStatus;
  parentKey: string | null;
}): AxisCompleteness {
  if (input.status === "n/a") return "not_applicable";
  if (!FILLED_STATUSES.has(input.status)) return "unknown";
  return input.parentKey ? "partial" : "complete";
}

/**
 * 19개 부모 축만 집계한다. 하위 플래그/서브필드는 진단용 행이며 분자와 분모에 직접 들어가지 않는다.
 * grantWeights가 없으면 모든 축의 가중치를 1로 보고, 주어지면 누락 축의 가중치는 0으로 본다.
 */
export function measureAutofillCoverage(
  rows: readonly AutofillCoverageRow[],
  grantWeights?: AutofillGrantWeights | null,
): AutofillCoverageMetrics {
  const parentsByDimension = new Map<OperationalAutofillDimension, AutofillCoverageRow>();
  for (const row of rows) {
    if (
      row.parentKey !== null ||
      row.dimension === null ||
      !OPERATIONAL_DIMENSION_SET.has(row.dimension)
    ) {
      continue;
    }
    parentsByDimension.set(row.dimension as OperationalAutofillDimension, row);
  }

  let authoritativeCount = 0;
  let answeredCount = 0;
  let answeredWeight = 0;
  let totalWeight = 0;

  for (const dimension of OPERATIONAL_AUTOFILL_DIMENSIONS) {
    const row = parentsByDimension.get(dimension);
    const complete = row?.axisCompleteness === "complete" && FILLED_STATUSES.has(row.status);
    const answered = complete && row.sourceKind !== null;
    const authoritative = answered && AUTHORITATIVE_SOURCE_KINDS.has(row.sourceKind as EvidenceSourceKind);
    if (answered) answeredCount += 1;
    if (authoritative) authoritativeCount += 1;

    const rawWeight = grantWeights == null ? 1 : grantWeights[dimension] ?? 0;
    const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 0;
    totalWeight += weight;
    if (answered) answeredWeight += weight;
  }

  const denominator = OPERATIONAL_AUTOFILL_DIMENSIONS.length;
  return {
    authoritative_axis_coverage: ratio(authoritativeCount, denominator),
    total_answered_coverage: ratio(answeredCount, denominator),
    grant_weighted_coverage: ratio(answeredWeight, totalWeight),
  };
}

function ratio(numerator: number, denominator: number): CoverageRatio {
  return {
    numerator,
    denominator,
    ratio: denominator > 0 ? numerator / denominator : 0,
  };
}
