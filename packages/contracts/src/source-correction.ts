import type { CompanyProfileFieldEvidence, CriterionDimension } from "./index.js";

export interface SourceCorrectionSnapshot {
  dimension: CriterionDimension;
  value: unknown;
  displayValue: string | null;
  evidence: CompanyProfileFieldEvidence;
}
export type SourceCorrectionStatus = "open" | "reviewing" | "waiting_source" | "resolved" | "rejected" | "withdrawn";
export interface SourceCorrectionEvent {
  at: string;
  actor: string;
  action: string;
  note: string;
}
export interface SourceCorrectionRecord {
  id: string;
  ticketId: string;
  companyId: string;
  userId: string;
  dimension: CriterionDimension;
  status: SourceCorrectionStatus;
  baseline: SourceCorrectionSnapshot;
  statement: string;
  observation: SourceCorrectionSnapshot | null;
  events: SourceCorrectionEvent[];
  revision: number;
}
export const SOURCE_CORRECTION_LABELS: Record<SourceCorrectionStatus, string> = {
  open: "접수", reviewing: "검토 중", waiting_source: "원천 확인 대기",
  resolved: "갱신값 검수 완료", rejected: "사유 안내 후 종결", withdrawn: "요청 철회",
};

export function sourceCorrectionIsOpen(status: SourceCorrectionStatus): boolean {
  return status === "open" || status === "reviewing" || status === "waiting_source";
}

/** Display labels and supplementary annotations cannot turn an unchanged source into a correction. */
export function sourceSnapshotIdentity(snapshot: SourceCorrectionSnapshot): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return JSON.stringify(canonical({ dimension: snapshot.dimension, value: snapshot.value,
    provider: snapshot.evidence.provider, sourceKind: snapshot.evidence.sourceKind,
    asOf: snapshot.evidence.asOf, completeness: snapshot.evidence.axisCompleteness }));
}

export function isOfficialSourceSnapshot(snapshot: SourceCorrectionSnapshot): boolean {
  return ["authoritative_api", "public_registry"].includes(snapshot.evidence.sourceKind)
    && Boolean(snapshot.evidence.provider) && snapshot.value !== undefined;
}

export function isVerifiedSourceCurrent(verified: SourceCorrectionSnapshot, current: SourceCorrectionSnapshot): boolean {
  const before = Date.parse(verified.evidence.asOf ?? "");
  const after = Date.parse(current.evidence.asOf ?? "");
  if (!Number.isFinite(before) || !Number.isFinite(after) || after < before) return false;
  // A later observation of the same fact does not reopen a resolved dispute just because time advanced.
  return sourceSnapshotIdentity({ ...current, evidence: { ...current.evidence, asOf: verified.evidence.asOf } }) === sourceSnapshotIdentity(verified);
}

export function canVerifySourceCorrection(record: Pick<SourceCorrectionRecord, "baseline" | "observation">): boolean {
  const { baseline, observation } = record;
  if (!observation || !isOfficialSourceSnapshot(observation) || observation.dimension !== baseline.dimension
    || observation.evidence.provider !== baseline.evidence.provider
    || observation.evidence.sourceKind !== baseline.evidence.sourceKind) return false;
  const before = Date.parse(baseline.evidence.asOf ?? "");
  const after = Date.parse(observation.evidence.asOf ?? "");
  return Number.isFinite(after) && (!Number.isFinite(before) || after >= before)
    && sourceSnapshotIdentity(baseline) !== sourceSnapshotIdentity(observation);
}
