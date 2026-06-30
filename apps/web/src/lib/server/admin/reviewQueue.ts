import { and, desc, eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

const REVIEWABLE_KINDS = new Set(["wrong", "blocked"]);
const REVIEWABLE_REASON_CODES = new Set([
  "wrong_high",
  "wrong_low",
  "wrong_condition",
  "profile_wrong",
  "criteria_wrong",
  "taxonomy_gap",
  "portal_blocked",
]);
const ELIGIBILITIES = new Set(["eligible", "conditional", "ineligible"]);
const CRITERION_RESULTS = new Set(["pass", "fail", "unknown"]);
const DEFAULT_GOLDEN_VER = "feedback-matching-candidates-v1";

export interface AdminReviewFeedbackRow {
  id: string;
  targetType: string;
  targetId: string;
  type: string;
  actor: string;
  value: Record<string, unknown>;
  ts: Date;
}

export interface AdminReviewQueue {
  generatedAt: string;
  total: number;
  items: AdminReviewQueueItem[];
}

export interface AdminReviewQueueItem {
  feedbackId: string;
  targetId: string;
  companyId: string | null;
  grantId: string | null;
  feedbackType: string;
  kind: string | null;
  outcome: string | null;
  reasonCode: string | null;
  message: string | null;
  priority: "high" | "medium" | "low";
  reviewReason: string;
  correction: AdminReviewCorrection | null;
  goldenCandidate: AdminGoldenCandidate | null;
  receivedAt: string;
}

export interface AdminReviewCorrection {
  dimension: string | null;
  criterionId: string | null;
  expectedEligibility: string | null;
  correctedEligibility: string | null;
  correctedResult: string | null;
  note: string | null;
}

export interface AdminGoldenCandidate {
  kind: "matching";
  ref: string;
  goldenVer: string;
  ready: boolean;
  missing: string[];
  gold: Record<string, unknown>;
}

export interface PromoteReviewFeedbackResult {
  created: boolean;
  goldenSet: {
    id: string;
    kind: string;
    ref: string;
    goldenVer: string;
  };
  reviewItem: AdminReviewQueueItem;
}

export class AdminReviewQueueError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminReviewQueueError";
  }
}

export async function getAdminReviewQueue(limit = 20): Promise<AdminReviewQueue> {
  const db = getCunoteDb();
  const safeLimit = Math.max(1, Math.min(100, limit));
  const rows = await db
    .select()
    .from(schema.feedback)
    .where(eq(schema.feedback.targetType, "match"))
    .orderBy(desc(schema.feedback.ts))
    .limit(Math.max(50, safeLimit * 10));

  const items = buildAdminReviewQueueItems(rows, safeLimit);
  return {
    generatedAt: new Date().toISOString(),
    total: items.length,
    items,
  };
}

export async function promoteReviewFeedbackToGoldenSet(input: {
  feedbackId: string;
  goldenVer?: string | null;
  curatedBy?: string | null;
}): Promise<PromoteReviewFeedbackResult> {
  const feedbackId = input.feedbackId.trim();
  if (!feedbackId) {
    throw new AdminReviewQueueError("invalid_feedback_id", "피드백 id가 필요합니다.", 400);
  }

  const db = getCunoteDb();
  const [row] = await db
    .select()
    .from(schema.feedback)
    .where(eq(schema.feedback.id, feedbackId))
    .limit(1);
  if (!row) {
    throw new AdminReviewQueueError("feedback_not_found", "피드백을 찾지 못했습니다.", 404);
  }

  const [reviewItem] = buildAdminReviewQueueItems([row], 1);
  if (!reviewItem) {
    throw new AdminReviewQueueError("feedback_not_reviewable", "리뷰 큐로 보낼 수 있는 피드백이 아닙니다.", 400);
  }
  const candidate = reviewItem.goldenCandidate;
  if (!candidate?.ready) {
    throw new AdminReviewQueueError(
      "golden_candidate_incomplete",
      `골든셋 후보에 필요한 값이 부족합니다: ${candidate?.missing.join(", ") ?? "candidate"}`,
      400,
    );
  }

  const goldenVer = normalizeGoldenVer(input.goldenVer) ?? candidate.goldenVer;
  const ref = candidate.ref;
  const [existing] = await db
    .select({
      id: schema.goldenSet.id,
      kind: schema.goldenSet.kind,
      ref: schema.goldenSet.ref,
      goldenVer: schema.goldenSet.goldenVer,
    })
    .from(schema.goldenSet)
    .where(and(
      eq(schema.goldenSet.kind, "matching"),
      eq(schema.goldenSet.ref, ref),
      eq(schema.goldenSet.goldenVer, goldenVer),
    ))
    .limit(1);

  if (existing) {
    return {
      created: false,
      goldenSet: existing,
      reviewItem,
    };
  }

  const [created] = await db
    .insert(schema.goldenSet)
    .values({
      kind: "matching",
      ref,
      goldenVer,
      curatedBy: uuidOrNull(input.curatedBy),
      gold: {
        ...candidate.gold,
        goldenVer,
        promotedAt: new Date().toISOString(),
      },
    })
    .returning({
      id: schema.goldenSet.id,
      kind: schema.goldenSet.kind,
      ref: schema.goldenSet.ref,
      goldenVer: schema.goldenSet.goldenVer,
    });
  if (!created) {
    throw new AdminReviewQueueError("golden_candidate_failed", "골든셋 후보 저장 결과가 없습니다.", 500);
  }

  return {
    created: true,
    goldenSet: created,
    reviewItem,
  };
}

export function buildAdminReviewQueueItems(
  rows: AdminReviewFeedbackRow[],
  limit = 20,
): AdminReviewQueueItem[] {
  return rows
    .map(toReviewQueueItem)
    .filter((item): item is AdminReviewQueueItem => item !== null)
    .slice(0, Math.max(1, limit));
}

function toReviewQueueItem(row: AdminReviewFeedbackRow): AdminReviewQueueItem | null {
  const kind = stringValue(row.value.kind);
  const reasonCode = stringValue(row.value.reasonCode);
  const outcome = stringValue(row.value.outcome);
  const correction = correctionValue(row.value.correction);
  const reviewable = REVIEWABLE_KINDS.has(kind ?? "") ||
    REVIEWABLE_REASON_CODES.has(reasonCode ?? "") ||
    correction !== null;

  if (!reviewable) return null;

  const target = splitTargetId(row.targetId);
  const item: AdminReviewQueueItem = {
    feedbackId: row.id,
    targetId: row.targetId,
    companyId: target.companyId,
    grantId: target.grantId,
    feedbackType: row.type,
    kind,
    outcome,
    reasonCode,
    message: stringValue(row.value.message),
    priority: priorityFor(kind, reasonCode, correction),
    reviewReason: reviewReasonFor(kind, reasonCode, correction),
    correction,
    goldenCandidate: null,
    receivedAt: row.ts.toISOString(),
  };
  item.goldenCandidate = buildGoldenCandidate(item);
  return item;
}

function buildGoldenCandidate(item: AdminReviewQueueItem): AdminGoldenCandidate {
  const missing: string[] = [];
  if (!item.companyId) missing.push("companyId");
  if (!item.grantId) missing.push("grantId");
  if (!item.correction?.correctedEligibility) missing.push("correctedEligibility");
  const ready = missing.length === 0;

  return {
    kind: "matching",
    ref: `feedback:${item.feedbackId}`,
    goldenVer: DEFAULT_GOLDEN_VER,
    ready,
    missing,
    gold: {
      source: "feedback",
      feedbackId: item.feedbackId,
      targetId: item.targetId,
      companyId: item.companyId,
      grantId: item.grantId,
      expected: item.correction?.correctedEligibility ?? null,
      correction: item.correction,
      reasonCode: item.reasonCode,
      outcome: item.outcome,
      feedbackKind: item.kind,
      feedbackType: item.feedbackType,
      message: item.message,
      observedAt: item.receivedAt,
      note: "Human review required before using as an authoritative eval fixture.",
    },
  };
}

function correctionValue(value: unknown): AdminReviewCorrection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const correction: AdminReviewCorrection = {
    dimension: stringValue(record.dimension),
    criterionId: stringValue(record.criterionId),
    expectedEligibility: eligibilityValue(record.expectedEligibility),
    correctedEligibility: eligibilityValue(record.correctedEligibility),
    correctedResult: criterionResultValue(record.correctedResult),
    note: stringValue(record.note),
  };
  return Object.values(correction).some((item) => item !== null) ? correction : null;
}

function splitTargetId(targetId: string): { companyId: string | null; grantId: string | null } {
  const separator = targetId.indexOf(":");
  if (separator <= 0) return { companyId: null, grantId: targetId || null };
  return {
    companyId: targetId.slice(0, separator),
    grantId: targetId.slice(separator + 1) || null,
  };
}

function priorityFor(
  kind: string | null,
  reasonCode: string | null,
  correction: AdminReviewCorrection | null,
): AdminReviewQueueItem["priority"] {
  if (kind === "blocked" || reasonCode === "portal_blocked") return "high";
  if (correction?.correctedEligibility || correction?.correctedResult) return "high";
  if (kind === "wrong" || reasonCode?.startsWith("wrong_")) return "medium";
  return "low";
}

function reviewReasonFor(
  kind: string | null,
  reasonCode: string | null,
  correction: AdminReviewCorrection | null,
): string {
  if (kind === "blocked" || reasonCode === "portal_blocked") return "신청 단계에서 막힌 매칭입니다.";
  if (reasonCode === "wrong_high") return "높게 추천됐지만 사용자가 틀렸다고 본 매칭입니다.";
  if (reasonCode === "wrong_low") return "낮게 평가됐거나 누락됐다고 신고된 매칭입니다.";
  if (reasonCode === "criteria_wrong") return "공고 조건 추출/해석 오류 후보입니다.";
  if (reasonCode === "profile_wrong") return "회사 프로필 값 오류 후보입니다.";
  if (reasonCode === "taxonomy_gap") return "업종/지역/조건 taxonomy 보강 후보입니다.";
  if (correction) return "정정값이 포함된 피드백입니다.";
  return "리뷰가 필요한 매칭 피드백입니다.";
}

function normalizeGoldenVer(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uuidOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function eligibilityValue(value: unknown): string | null {
  return ELIGIBILITIES.has(value as string) ? value as string : null;
}

function criterionResultValue(value: unknown): string | null {
  return CRITERION_RESULTS.has(value as string) ? value as string : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
