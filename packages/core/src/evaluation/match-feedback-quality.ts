export interface MatchFeedbackQualityRecord {
  id: string;
  actor: "user" | "reviewer";
  timestamp: string;
  value: Record<string, unknown>;
}

export interface MatchFeedbackQualityReport {
  periodStart: string;
  periodEnd: string;
  totalUserFeedback: number;
  completeProvenanceCount: number;
  provenanceCoverage: number | null;
  correctionCount: number;
  reviewCandidateCount: number;
  reviewedCandidateCount: number;
  reviewBacklogCount: number;
  byKind: Record<string, number>;
  byReasonCode: Record<string, number>;
  byCorrectedDimension: Record<string, number>;
  byCaptureStatus: Record<string, number>;
  byGrantSource: Record<string, number>;
  byRulesetVersion: Record<string, number>;
  invalidReviewerRecordCount: number;
  operationalReady: boolean;
}

export function buildMatchFeedbackQualityReport(input: {
  records: MatchFeedbackQualityRecord[];
  periodStart: Date;
  periodEnd: Date;
  minimumProvenanceCoverage?: number;
}): MatchFeedbackQualityReport {
  const periodStart = validDate(input.periodStart, "periodStart");
  const periodEnd = validDate(input.periodEnd, "periodEnd");
  if (periodEnd <= periodStart) throw new Error("periodEnd must be after periodStart");
  const minimumProvenanceCoverage = boundedRatio(input.minimumProvenanceCoverage ?? 0.95);
  const inPeriod = input.records.filter((record) => {
    const timestamp = new Date(record.timestamp);
    return !Number.isNaN(timestamp.getTime()) && timestamp >= periodStart && timestamp < periodEnd;
  });
  const userRecords = inPeriod.filter((record) => record.actor === "user");
  const reviewerRecords = inPeriod.filter((record) => record.actor === "reviewer");
  const reviewedIds = new Set<string>();
  let invalidReviewerRecordCount = 0;
  for (const record of reviewerRecords) {
    const reviewedFeedbackId = stringValue(record.value.reviewedFeedbackId);
    const decision = stringValue(record.value.reviewDecision);
    const reviewerId = stringValue(record.value.reviewerId);
    const reviewedAt = dateValue(record.value.reviewedAt);
    if (!reviewedFeedbackId || !reviewerId || !reviewedAt || (decision !== "accepted" && decision !== "rejected")) {
      invalidReviewerRecordCount += 1;
      continue;
    }
    reviewedIds.add(reviewedFeedbackId);
  }

  const reviewCandidates = userRecords.filter((record) => {
    const kind = stringValue(record.value.kind);
    return kind === "wrong" || isRecord(record.value.correction);
  });
  const completeProvenanceCount = userRecords.filter((record) => provenance(record.value)?.captureStatus === "complete").length;
  const provenanceCoverage = ratio(completeProvenanceCount, userRecords.length);
  const reviewedCandidateCount = reviewCandidates.filter((record) => reviewedIds.has(record.id)).length;
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    totalUserFeedback: userRecords.length,
    completeProvenanceCount,
    provenanceCoverage,
    correctionCount: userRecords.filter((record) => isRecord(record.value.correction)).length,
    reviewCandidateCount: reviewCandidates.length,
    reviewedCandidateCount,
    reviewBacklogCount: reviewCandidates.length - reviewedCandidateCount,
    byKind: histogram(userRecords.map((record) => stringValue(record.value.kind) ?? "missing")),
    byReasonCode: histogram(userRecords.map((record) => stringValue(record.value.reasonCode) ?? "missing")),
    byCorrectedDimension: histogram(userRecords
      .map((record) => isRecord(record.value.correction) ? stringValue(record.value.correction.dimension) : null)
      .filter((value): value is string => value !== null)),
    byCaptureStatus: histogram(userRecords.map((record) => provenance(record.value)?.captureStatus ?? "missing")),
    byGrantSource: histogram(userRecords.map((record) => provenance(record.value)?.grantSource ?? "missing")),
    byRulesetVersion: histogram(userRecords.map((record) => provenance(record.value)?.rulesetVersion ?? "missing")),
    invalidReviewerRecordCount,
    operationalReady: userRecords.length > 0 && provenanceCoverage !== null &&
      provenanceCoverage >= minimumProvenanceCoverage && invalidReviewerRecordCount === 0,
  };
}

function provenance(value: Record<string, unknown>): {
  captureStatus: string;
  grantSource: string | null;
  rulesetVersion: string | null;
} | null {
  if (!isRecord(value.provenance)) return null;
  return {
    captureStatus: stringValue(value.provenance.captureStatus) ?? "invalid",
    grantSource: stringValue(value.provenance.grantSource),
    rulesetVersion: stringValue(value.provenance.rulesetVersion),
  };
}

function histogram(values: string[]): Record<string, number> {
  return values.sort().reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}
function validDate(value: Date, label: string): Date {
  if (Number.isNaN(value.getTime())) throw new Error(`${label} must be a valid date`);
  return value;
}
function boundedRatio(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("minimumProvenanceCoverage must be between 0 and 1");
  return value;
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function dateValue(value: unknown): Date | null {
  const string = stringValue(value);
  if (!string) return null;
  const parsed = new Date(string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
