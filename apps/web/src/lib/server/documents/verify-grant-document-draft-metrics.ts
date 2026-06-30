import assert from "node:assert/strict";
import { summarizeAdminGrantDocumentDraftMetrics } from "./grantDocumentDraftMetrics";
import type {
  AdminGrantDocumentDraftMetricItem,
  AdminGrantDocumentDraftQualityEventItem,
} from "./grantDocumentDraftMetrics";

const drafts: AdminGrantDocumentDraftMetricItem[] = [
  draftMetric({ id: "draft-1", status: "reviewed", missingFieldCount: 0, filledFieldCount: 5 }),
  draftMetric({ id: "draft-2", status: "exported", missingFieldCount: 1, filledFieldCount: 3 }),
  draftMetric({ id: "draft-3", status: "needs_input", missingFieldCount: 2, filledFieldCount: 1 }),
];

const qualityEvents: AdminGrantDocumentDraftQualityEventItem[] = [
  qualityEvent({ id: "event-1", kind: "incorrect_fact" }),
  qualityEvent({ id: "event-2", kind: "incorrect_fact" }),
  qualityEvent({ id: "event-3", kind: "missing_context" }),
  qualityEvent({ id: "event-4", kind: null }),
];

const summary = summarizeAdminGrantDocumentDraftMetrics({ drafts, qualityEvents });

assert.equal(summary.totalDrafts, 3);
assert.equal(summary.reviewedDrafts, 1);
assert.equal(summary.exportedDrafts, 1);
assert.equal(summary.needsInputDrafts, 1);
assert.equal(summary.totalMissingFields, 3);
assert.equal(summary.averageMissingFields, 1);
assert.equal(summary.qualityFeedbackCount, 4);
assert.deepEqual(summary.qualityFeedbackByKind, [
  { kind: "incorrect_fact", count: 2 },
  { kind: "missing_context", count: 1 },
  { kind: "unknown", count: 1 },
]);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "draft_metric_status_counts",
    "draft_metric_missing_field_average",
    "draft_quality_feedback_kind_counts",
  ],
  summary,
}, null, 2));

function draftMetric(input: {
  id: string;
  status: string;
  missingFieldCount: number;
  filledFieldCount: number;
}): AdminGrantDocumentDraftMetricItem {
  return {
    id: input.id,
    grantId: "00000000-0000-4000-8000-000000000201",
    companyId: "00000000-0000-4000-8000-000000000301",
    documentKey: `${input.id}:application_form`,
    documentCategory: "application_form",
    documentName: "지원신청서",
    status: input.status,
    filledFieldCount: input.filledFieldCount,
    missingFieldCount: input.missingFieldCount,
    warningCount: 0,
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function qualityEvent(input: {
  id: string;
  kind: string | null;
}): AdminGrantDocumentDraftQualityEventItem {
  return {
    id: input.id,
    draftId: "00000000-0000-4000-8000-000000000401",
    actorUserId: "00000000-0000-4000-8000-000000000501",
    kind: input.kind,
    documentName: "지원신청서",
    documentCategory: "application_form",
    status: "draft",
    hasMessage: true,
    createdAt: "2026-06-30T00:00:00.000Z",
  };
}
