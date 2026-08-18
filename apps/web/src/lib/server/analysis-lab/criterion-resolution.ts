// 사람 검수·AI 감사·확장 overlay를 criterion 단위 발행 상태로 해소하는 단일 원천.
import {
  isAiAuditConcur,
  type LabAudit,
  type LabAxisReview,
  type LabCriterionReview,
  type LabCriterionVerdict,
  type LabReview,
  type LabRun,
} from "@/lib/server/analysis-lab/lab-contract";
import type { HumanReviewOverlay } from "./human-review-overlay";

export type CriterionResolutionState =
  | "confirmed_correct"
  | "confirmed_edited"
  | "confirmed_wrong"
  | "pending"
  | "unaudited_correct"
  | "deep_repair_receipt";

export interface CriterionResolution {
  criterionIndex: number;
  state: CriterionResolutionState;
  decidedBy: string | null;
  note: string | null;
}

export interface AiCriterionReviewSnapshot {
  criterionReviews: LabCriterionReview[];
  axisReviews?: LabAxisReview[];
}

export function resolveCriterionStates(input: {
  run: LabRun;
  humanReview?: LabReview | null | undefined;
  aiReview?: AiCriterionReviewSnapshot | null | undefined;
  audit?: LabAudit | null | undefined;
  overlay?: HumanReviewOverlay | null | undefined;
  /**
   * 봉인된 deep-repair run 자체를 승격 입력으로 채택한 경우의 terminal receipt.
   * 사람 검수나 독립 감사를 가장하지 않고 별도 resolution provenance로 기록한다.
   */
  deepRepairReceiptSha256?: string | null | undefined;
}): CriterionResolution[] {
  const humanByIndex = new Map(
    (input.humanReview?.criterionReviews ?? []).map((item) => [item.criterionIndex, item]),
  );
  const aiByIndex = new Map(
    (input.aiReview?.criterionReviews ?? []).map((item) => [item.criterionIndex, item]),
  );
  const auditByIndex = new Map(
    (input.audit?.items ?? [])
      .filter((item) => item.kind === "criterion" && item.criterionIndex !== undefined)
      .map((item) => [item.criterionIndex!, item]),
  );
  const overlayByIndex = new Map(
    (input.overlay?.items ?? [])
      .filter((item) => item.itemKind === "criterion" && item.criterionIndex !== undefined)
      .map((item) => [item.criterionIndex!, item]),
  );

  return input.run.criteria.map((_, criterionIndex) => {
    const overlay = overlayByIndex.get(criterionIndex);
    if (overlay) {
      return fromVerdict(criterionIndex, overlay.humanVerdict as LabCriterionVerdict, overlay.decidedBy, overlay.note);
    }

    const human = humanByIndex.get(criterionIndex);
    if (human) {
      return fromVerdict(
        criterionIndex,
        human.verdict,
        input.humanReview?.reviewerEmail ?? null,
        human.note,
      );
    }

    const audit = auditByIndex.get(criterionIndex);
    if (audit?.humanVerdict) {
      return fromVerdict(
        criterionIndex,
        audit.humanVerdict as LabCriterionVerdict,
        input.audit?.auditorEmail ?? null,
        audit.note ?? audit.aiNote,
      );
    }
    if (audit && isAiAuditConcur(audit)) {
      return fromVerdict(
        criterionIndex,
        audit.aiVerdict as LabCriterionVerdict,
        input.audit?.aiAuditModel ?? "ai_audit_concur",
        audit.aiAuditNote ?? audit.aiNote,
      );
    }

    if (input.deepRepairReceiptSha256) {
      return {
        criterionIndex,
        state: "deep_repair_receipt",
        decidedBy: input.deepRepairReceiptSha256,
        note: null,
      };
    }

    const ai = aiByIndex.get(criterionIndex);
    if (ai?.verdict === "correct" && !audit) {
      return {
        criterionIndex,
        state: "unaudited_correct",
        decidedBy: null,
        note: ai.note,
      };
    }
    return {
      criterionIndex,
      state: "pending",
      decidedBy: null,
      note: audit?.note ?? ai?.note ?? null,
    };
  });
}

export function publishesCriterion(state: CriterionResolutionState): boolean {
  return state === "confirmed_correct"
    || state === "unaudited_correct"
    || state === "pending"
    || state === "deep_repair_receipt";
}

export function criterionNeedsReview(state: CriterionResolutionState): boolean {
  // 운영 승격 안전 정책(2026-07-24): 사람 판정 또는 독립 감사 일치가 없는 AI correct도
  // 서비스는 비차단으로 노출하되 추천·탈락을 확정하지 못하도록 needs_review=true로 발행한다.
  return state === "pending" || state === "unaudited_correct";
}

export function publishesConfirmationQuestion(state: CriterionResolutionState): boolean {
  return state === "confirmed_correct" || state === "deep_repair_receipt";
}

function fromVerdict(
  criterionIndex: number,
  verdict: LabCriterionVerdict,
  decidedBy: string | null,
  note: string | null,
): CriterionResolution {
  const state: CriterionResolutionState =
    verdict === "correct"
      ? "confirmed_correct"
      : verdict === "needs_edit"
        ? "confirmed_edited"
        : verdict === "wrong"
          ? "confirmed_wrong"
          : "pending";
  return { criterionIndex, state, decidedBy, note };
}
