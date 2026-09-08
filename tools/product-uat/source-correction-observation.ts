import assert from "node:assert/strict";
import type { CompanyProfile, CompanyProfileEvidenceObservation } from "../../packages/contracts/src/index";
import { encodeCompanyProfileRows } from "../../apps/web/src/lib/server/repositories/drizzle";

export const SOURCE_CORRECTION_UAT = Object.freeze({
  companyId: "20000000-0000-4000-8000-000000000001",
  ownerUserId: "10000000-0000-4000-8000-000000000001",
  profileRowId: "50000000-0000-4000-8000-000000000001",
  grantId: "40000000-0000-4000-8000-000000000003",
  grantTitle: "격리 공식 원천 정정 인수 공고",
  dimension: "employees",
  provider: "registry",
  sourceKind: "public_registry",
  before: {
    employeesCount: 20,
    asOf: "2026-09-07T00:00:00.000Z",
    observationVersion: "registry-employees-v1",
  },
  after: {
    employeesCount: 8,
    asOf: "2026-09-08T00:00:00.000Z",
    observationVersion: "registry-employees-v2",
  },
  observationId: "local-uat-registry-company-a-employees",
  fixtureReceipt: "source-correction-fixture-receipt.json",
  updateReceipt: "source-correction-observation-update-receipt.json",
  authority: "isolated_registry_observation_simulation_not_external_institution_refresh",
} as const);

export type SourceCorrectionObservationPhase = "before" | "after";

export function buildRegistryEmployeesProfile(
  phase: SourceCorrectionObservationPhase,
): CompanyProfile {
  const observation = SOURCE_CORRECTION_UAT[phase];
  const evidence: CompanyProfileEvidenceObservation = {
    sourceKind: SOURCE_CORRECTION_UAT.sourceKind,
    provider: SOURCE_CORRECTION_UAT.provider,
    asOf: observation.asOf,
    axisCompleteness: "complete",
    confidence: 1,
    scope: "shared",
    observationId: SOURCE_CORRECTION_UAT.observationId,
    observationVersion: observation.observationVersion,
    canonicalValue: String(observation.employeesCount),
    persistenceClass: "versioned_provider_observation",
    resolverVersion: "p1-v1",
  };
  return {
    id: SOURCE_CORRECTION_UAT.companyId,
    employees_count: observation.employeesCount,
    confidence: { employees: 1 },
    profile_evidence: { employees: evidence },
  };
}

export function buildRegistryEmployeesRow(phase: SourceCorrectionObservationPhase) {
  const observation = SOURCE_CORRECTION_UAT[phase];
  const rows = encodeCompanyProfileRows(
    SOURCE_CORRECTION_UAT.companyId,
    buildRegistryEmployeesProfile(phase),
    new Date(observation.asOf),
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.dimension, SOURCE_CORRECTION_UAT.dimension);
  assert.equal(row.userId, undefined, "공식 registry 관측은 회사 shared row여야 합니다");
  return row;
}
