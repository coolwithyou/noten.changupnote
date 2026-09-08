// Offline-only deterministic draft packet. It does not call a model, mutate a LabRun/review,
// write the service DB, or authorize release/promotion/live questions.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION,
  CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA,
  canonicalConfirmationQuestionDraftJson,
  confirmationQuestionDraftPacketBody,
  parseConfirmationQuestionDraftPacket,
  parseConfirmationQuestionManualInputEnvelope,
  type ConfirmationQuestionDraftItem,
  type ManualConfirmationDraftInput,
  type ConfirmationQuestionDraftPacket,
  type ConfirmationQuestionDraftPacketBody,
} from "@cunote/contracts/confirmation-question-draft";
import type { LabCriterion, LabReview, LabRun } from "./lab-contract";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import { classifyManualConfirmationCriterion } from "./manual-confirmation-evaluations";
import { labReviewFilePath, validateReviewerEmail } from "./review-store";
import { analysisLabDir, labRunFilePath, readLabRun } from "./run-store";

export interface StoredConfirmationQuestionDraftResult {
  packet: ConfirmationQuestionDraftPacket;
  path: string;
}

export interface ValidatedBoundManualConfirmationInput {
  run: LabRun;
  review: LabReview;
  manualInput: ManualConfirmationDraftInput;
}

export function buildConfirmationQuestionDraftPacket(input: {
  run: LabRun;
  review: LabReview;
  runArtifactSha256: string;
  reviewArtifactSha256: string;
}): ConfirmationQuestionDraftPacket {
  const { run, review } = input;
  if (!isSha256(input.runArtifactSha256) || !isSha256(input.reviewArtifactSha256)) {
    throw new Error("run/review artifact SHA-256 결속이 필요합니다.");
  }
  if (!run.sourceRevisionSha256 || !isSha256(run.sourceRevisionSha256)) {
    throw new Error("확인질문 draft에는 run sourceRevisionSha256가 필요합니다.");
  }
  if (!isSha256(run.inputSha256)) {
    throw new Error("확인질문 draft에는 유효한 run inputSha256가 필요합니다.");
  }
  if (run.attachmentManifestSha256 !== undefined && !isSha256(run.attachmentManifestSha256)) {
    throw new Error("run attachmentManifestSha256가 올바르지 않습니다.");
  }
  if (review.grantId !== run.grantId || review.runId !== run.runId) {
    throw new Error("확인질문 draft review가 run과 일치하지 않습니다.");
  }
  const reviewer = validateReviewerEmail(review.reviewerEmail);
  if (!reviewer.ok) throw new Error(reviewer.reason);
  const reviewUpdatedAt = canonicalIso(review.updatedAt, "review.updatedAt");
  const correctCriterionIndexes = parseCorrectCriterionIndexes(review, run.criteria.length);
  const items = run.criteria.flatMap((criterion, criterionIndex) => {
    if (!correctCriterionIndexes.has(criterionIndex)) return [];
    if (criterion.confirmation) return [];
    if (classifyManualConfirmationCriterion(criterion) !== "user_confirmation") return [];
    return [buildDraftItem(criterion, criterionIndex)];
  });
  if (items.length === 0) {
    throw new Error("사람 검수에서 확정된 확인질문 draft 후보가 없습니다.");
  }
  const body: ConfirmationQuestionDraftPacketBody = {
    schema: CONFIRMATION_QUESTION_DRAFT_PACKET_SCHEMA,
    generatorVersion: CONFIRMATION_QUESTION_DRAFT_GENERATOR_VERSION,
    authority: {
      status: "unreviewed_draft",
      modelCallsMade: 0,
      serviceDatabaseWritesMade: 0,
      releaseAuthorized: false,
      promotionAuthorized: false,
      liveQuestionWriteAuthorized: false,
      currentServiceStateVerified: false,
    },
    source: {
      grantId: run.grantId,
      runId: run.runId,
      source: run.source,
      sourceId: run.sourceId,
      inputSha256: run.inputSha256,
      sourceRevisionSha256: run.sourceRevisionSha256,
      attachmentManifestSha256: run.attachmentManifestSha256 ?? null,
      runArtifactSha256: input.runArtifactSha256,
      reviewArtifactSha256: input.reviewArtifactSha256,
      criterionReviewerEmail: reviewer.email,
      reviewUpdatedAt,
    },
    items,
  };
  return parseConfirmationQuestionDraftPacket({
    ...body,
    contentSha256: sha256(canonicalConfirmationQuestionDraftJson(body)),
  });
}

export async function generateConfirmationQuestionDraftFromStoredRun(input: {
  grantId: string;
  runId: string;
  outputDirectory?: string;
}): Promise<StoredConfirmationQuestionDraftResult> {
  const located = await readLabRun(input.grantId, input.runId);
  if (!located) throw new Error("확인질문 draft 대상 run을 찾지 못했습니다.");
  const runPath = labRunFilePath(located.source, located.sourceId, located.runId);
  const reviewPath = labReviewFilePath(located.source, located.sourceId, located.runId);
  const [runBytes, reviewBytes] = await Promise.all([readFile(runPath), readFile(reviewPath)]);
  const run = JSON.parse(runBytes.toString("utf8")) as LabRun;
  const review = JSON.parse(reviewBytes.toString("utf8")) as LabReview;
  if (
    run.grantId !== input.grantId
    || run.runId !== input.runId
    || run.source !== located.source
    || run.sourceId !== located.sourceId
  ) {
    throw new Error("다시 읽은 run artifact 결속이 조회 결과와 일치하지 않습니다.");
  }
  const packet = buildConfirmationQuestionDraftPacket({
    run,
    review,
    runArtifactSha256: sha256(runBytes),
    reviewArtifactSha256: sha256(reviewBytes),
  });
  const outputDirectory = input.outputDirectory
    ?? join(analysisLabDir(), "confirmation-question-drafts");
  const path = join(
    outputDirectory,
    `${packet.contentSha256}.confirmation-question-draft.json`,
  );
  await writeImmutableBytesAtomic(path, serializeConfirmationQuestionDraftPacket(packet));
  return { packet, path };
}

export function serializeConfirmationQuestionDraftPacket(
  packet: ConfirmationQuestionDraftPacket,
): Buffer {
  const parsed = parseConfirmationQuestionDraftPacket(packet);
  const expected = sha256(canonicalConfirmationQuestionDraftJson(
    confirmationQuestionDraftPacketBody(parsed),
  ));
  if (parsed.contentSha256 !== expected) {
    throw new Error("확인질문 draft content SHA가 내용과 일치하지 않습니다.");
  }
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/**
 * 관리자 export의 원 packet과 현재 local raw artifact를 exact 재결속한다.
 * 서비스 DB의 current source 상태를 조회하거나 검증하지 않는다.
 */
export function validateBoundManualConfirmationInput(input: {
  raw: unknown;
  runArtifactBytes: Uint8Array;
  reviewArtifactBytes: Uint8Array;
}): ValidatedBoundManualConfirmationInput {
  const envelope = parseConfirmationQuestionManualInputEnvelope(input.raw);
  const run = JSON.parse(Buffer.from(input.runArtifactBytes).toString("utf8")) as LabRun;
  const review = JSON.parse(Buffer.from(input.reviewArtifactBytes).toString("utf8")) as LabReview;
  const packet = buildConfirmationQuestionDraftPacket({
    run,
    review,
    runArtifactSha256: sha256(input.runArtifactBytes),
    reviewArtifactSha256: sha256(input.reviewArtifactBytes),
  });
  if (
    canonicalConfirmationQuestionDraftJson(packet)
    !== canonicalConfirmationQuestionDraftJson(envelope.draftPacket)
  ) {
    throw new Error("bound manual input의 draft packet이 현재 raw run/review와 일치하지 않습니다.");
  }
  return {
    run,
    review,
    manualInput: envelope.manualInput,
  };
}

function buildDraftItem(
  criterion: LabCriterion,
  criterionIndex: number,
): ConfirmationQuestionDraftItem {
  const sourceSpan = criterion.sourceSpan!;
  const exclusion = criterion.kind === "exclusion";
  const kindLabel = criterion.kind === "preferred" ? "우대" : exclusion ? "제외" : "필수";
  return {
    criterionIndex,
    criterionKind: criterion.kind,
    polarity: exclusion ? "exclusion_membership" : "criterion_satisfaction",
    criterionSha256: sha256(canonicalConfirmationQuestionDraftJson(criterion)),
    sourceSpan,
    resolutionScope: "per_notice",
    answerType: "single",
    prompt: `다음 ${kindLabel} 조건${exclusion ? "에 해당하나요" : "을 충족하나요"}?\n\n“${sourceSpan}”`,
    options: exclusion
      ? [
        { value: "yes", label: "해당해요", evaluation: "unsatisfied" },
        { value: "no", label: "해당하지 않아요", evaluation: "satisfied" },
        { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
      ]
      : [
        { value: "yes", label: "충족해요", evaluation: "satisfied" },
        { value: "no", label: "충족하지 않아요", evaluation: "unsatisfied" },
        { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
      ],
  };
}

function parseCorrectCriterionIndexes(review: LabReview, criterionCount: number): Set<number> {
  if (!Array.isArray(review.criterionReviews)) {
    throw new Error("review criterionReviews가 배열이 아닙니다.");
  }
  const seen = new Set<number>();
  const correct = new Set<number>();
  for (const item of review.criterionReviews) {
    if (
      !Number.isSafeInteger(item?.criterionIndex)
      || item.criterionIndex < 0
      || item.criterionIndex >= criterionCount
    ) {
      throw new Error("review criterionIndex가 run 범위를 벗어납니다.");
    }
    if (seen.has(item.criterionIndex)) {
      throw new Error(`review criterionIndex 중복: ${item.criterionIndex}`);
    }
    seen.add(item.criterionIndex);
    if (item.verdict === "correct") correct.add(item.criterionIndex);
  }
  return correct;
}

function canonicalIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}가 필요합니다.`);
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${label}가 canonical ISO 시각이 아닙니다.`);
  }
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
