import {
  RULESET_VERSION,
  SCORING_VERSION,
  type MatchStateInputBinding,
} from "@cunote/core";

export interface BoundMatchStateCacheRow {
  companyId: string;
  grantId: string;
  inputBinding: unknown;
  calculationAsOf: Date | null;
  rulesetVer: string;
  scoringVer: string;
}

/**
 * 저장된 match_state는 현재 입력 revision/topology와 엔진 버전이 모두 같을 때만 cache다.
 * legacy null 또는 metadata drift row를 baseline에서 제외한다. 같은 metadata를 남긴 결과-only
 * 덮어쓰기는 이 validator만으로 식별할 수 없으므로 DB writer-contract trigger가 별도로 차단한다.
 */
export function filterCurrentMatchStateCacheRows<T extends BoundMatchStateCacheRow>(
  rows: readonly T[],
  currentBindings: readonly MatchStateInputBinding[],
): T[] {
  const currentByPair = new Map(currentBindings.map((binding) => [pairKey(binding), binding]));
  return rows.filter((row) => {
    if (
      row.rulesetVer !== RULESET_VERSION
      || row.scoringVer !== SCORING_VERSION
      || !(row.calculationAsOf instanceof Date)
      || Number.isNaN(row.calculationAsOf.getTime())
    ) return false;
    const current = currentByPair.get(pairKey(row));
    if (!current) return false;
    const stored = parseStoredBinding(row.inputBinding);
    return stored !== null && canonicalBinding(stored) === canonicalBinding(current);
  });
}

function parseStoredBinding(value: unknown): MatchStateInputBinding | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "companyId",
    "companyRevision",
    "grantComponentRevisions",
    "grantId",
    "version",
  ])) return null;
  if (
    value.version !== "match-state-input-v1"
    || typeof value.companyId !== "string"
    || typeof value.grantId !== "string"
    || typeof value.companyRevision !== "string"
    || !POSITIVE_REVISION.test(value.companyRevision)
    || !Array.isArray(value.grantComponentRevisions)
    || value.grantComponentRevisions.length === 0
  ) return null;
  const components: MatchStateInputBinding["grantComponentRevisions"] = [];
  const seen = new Set<string>();
  for (const component of value.grantComponentRevisions) {
    if (
      !isRecord(component)
      || !hasExactKeys(component, ["grantId", "revision"])
      || typeof component.grantId !== "string"
      || typeof component.revision !== "string"
      || !UUID_PATTERN.test(component.grantId)
      || !POSITIVE_REVISION.test(component.revision)
      || seen.has(component.grantId)
    ) return null;
    seen.add(component.grantId);
    components.push({ grantId: component.grantId, revision: component.revision });
  }
  if (!seen.has(value.grantId)) return null;
  return {
    version: value.version,
    companyId: value.companyId,
    companyRevision: value.companyRevision,
    grantId: value.grantId,
    grantComponentRevisions: components,
  };
}

function canonicalBinding(binding: MatchStateInputBinding): string {
  return JSON.stringify({
    version: binding.version,
    companyId: binding.companyId,
    companyRevision: binding.companyRevision,
    grantId: binding.grantId,
    grantComponentRevisions: [...binding.grantComponentRevisions]
      .sort((left, right) => left.grantId.localeCompare(right.grantId)),
  });
}

function pairKey(value: { companyId: string; grantId: string }): string {
  return `${value.companyId}:${value.grantId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_REVISION = /^[1-9][0-9]*$/;
