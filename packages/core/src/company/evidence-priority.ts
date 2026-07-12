import type {
  CompanyProfileEvidenceObservation,
  CriterionDimension,
} from "@cunote/contracts";

export type EvidencePrecedenceDecision = "replace" | "retain";

export interface EvidencePrecedenceResult {
  decision: EvidencePrecedenceDecision;
  reason:
    | "source_priority"
    | "completeness"
    | "provider_priority"
    | "same_provider_confidence"
    | "same_provider_freshness"
    | "same_provider_tie"
    | "unknown_provider_tie";
  primary: "current" | "incoming";
  supplemental: "current" | "incoming";
  explanation: string;
}

const SOURCE_PRIORITY: Record<CompanyProfileEvidenceObservation["sourceKind"], number> = {
  authoritative_api: 5,
  public_registry: 4,
  auth_supplied: 3,
  self_declared: 2,
  derived: 1,
};

/** Higher entries are the preferred display source for that field. */
const PROVIDER_POLICY: Partial<Record<CriterionDimension, readonly string[]>> = {
  business_status: ["nts", "codef"],
  employees: ["kcomwel", "dart"],
  insured_workforce: ["kcomwel"],
  ip: ["kipris"],
  certification: ["startup_confirmation", "smpp", "registry"],
  target_type: ["startup_confirmation", "codef", "nice"],
  revenue: ["codef", "dart", "fsc", "nice"],
  financial_health: ["codef", "dart", "fsc", "nice"],
  region: ["codef", "nice"],
  biz_age: ["codef", "nice"],
  industry: ["codef", "nice"],
  size: ["codef", "nice"],
};

/**
 * Selects the primary observation without discarding the loser. The caller
 * should store `supplemental` beside the selected primary for provenance.
 */
export function resolveEvidencePrecedence(input: {
  dimension: CriterionDimension;
  current: CompanyProfileEvidenceObservation;
  incoming: CompanyProfileEvidenceObservation;
}): EvidencePrecedenceResult {
  const { current, incoming } = input;
  // Completeness is evaluated first: a partial observation must not replace a
  // complete axis value merely because its source/provider has a higher tier.
  // The partial observation remains useful as supplemental provenance.
  const completenessComparison = compareNumber(
    completenessRank(incoming.axisCompleteness),
    completenessRank(current.axisCompleteness),
  );
  if (completenessComparison !== 0) {
    return result(completenessComparison > 0, "completeness",
      "같은 원천 등급에서는 complete evidence를 partial evidence보다 우선합니다.");
  }

  const sourceComparison = compareNumber(
    SOURCE_PRIORITY[incoming.sourceKind],
    SOURCE_PRIORITY[current.sourceKind],
  );
  if (sourceComparison !== 0) {
    return result(sourceComparison > 0, "source_priority",
      `${incoming.sourceKind}와 ${current.sourceKind}의 원천 우선순위를 적용했습니다.`);
  }

  const policy = PROVIDER_POLICY[input.dimension] ?? [];
  const currentProviderRank = providerRank(policy, current.provider);
  const incomingProviderRank = providerRank(policy, incoming.provider);
  if (currentProviderRank !== null || incomingProviderRank !== null) {
    const providerComparison = compareNullableProviderRank(incomingProviderRank, currentProviderRank);
    if (providerComparison !== 0) {
      return result(providerComparison > 0, "provider_priority",
        `${input.dimension}의 명시적 provider 정책을 적용했습니다.`);
    }
  }

  if (incoming.provider !== current.provider) {
    return result(false, "unknown_provider_tie",
      "동일 우선순위의 서로 다른 provider는 최신 시각만으로 교체하지 않습니다.");
  }

  const confidenceComparison = compareConfidence(incoming.confidence, current.confidence);
  if (confidenceComparison !== 0) {
    return result(confidenceComparison > 0, "same_provider_confidence",
      "같은 provider와 우선순위에서는 더 높은 confidence를 우선합니다.");
  }

  const freshnessComparison = compareTimestamp(incoming.asOf, current.asOf);
  if (freshnessComparison !== 0) {
    return result(freshnessComparison > 0, "same_provider_freshness",
      "같은 provider와 우선순위에서는 더 최신 기준일을 우선합니다.");
  }
  return result(false, "same_provider_tie", "모든 우선순위 값이 같아 현재 evidence를 유지합니다.");
}

function result(
  replace: boolean,
  reason: EvidencePrecedenceResult["reason"],
  explanation: string,
): EvidencePrecedenceResult {
  return {
    decision: replace ? "replace" : "retain",
    reason,
    primary: replace ? "incoming" : "current",
    supplemental: replace ? "current" : "incoming",
    explanation,
  };
}

function completenessRank(value: CompanyProfileEvidenceObservation["axisCompleteness"]): number {
  return value === "complete" ? 2 : 1;
}

function providerRank(policy: readonly string[], provider: string): number | null {
  const index = policy.indexOf(provider);
  return index === -1 ? null : policy.length - index;
}

function compareNullableProviderRank(incoming: number | null, current: number | null): number {
  if (incoming === current) return 0;
  if (incoming === null) return -1;
  if (current === null) return 1;
  return compareNumber(incoming, current);
}

function compareConfidence(incoming: number | null, current: number | null): number {
  if (incoming === current) return 0;
  if (incoming === null) return -1;
  if (current === null) return 1;
  return compareNumber(incoming, current);
}

function compareTimestamp(incoming: string | null, current: string | null): number {
  const incomingTime = timestamp(incoming);
  const currentTime = timestamp(current);
  return compareNumber(incomingTime, currentTime);
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareNumber(incoming: number, current: number): number {
  return incoming === current ? 0 : incoming > current ? 1 : -1;
}
