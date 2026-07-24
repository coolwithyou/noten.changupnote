import { AI_REVIEW_ADOPTED } from "@/features/dev/analysis-lab/contract";
import { labAuditFilePath } from "./audit-store";
import { loadAuditedConfirmedReviews } from "./audited-reviews";
import { labConfirmationsFilePath, readLabConfirmationsFile } from "./confirmations";
import {
  humanReviewOverlayFilePath,
  readHumanReviewOverlayFile,
} from "./human-review-overlay";
import {
  dedupePromotionSources,
  planGrantPromotion,
  type GrantPromotionPlan,
  type PromotionSource,
} from "./promote";
import {
  hashFile,
  hashFileIfPresent,
  type PromotionSourceArtifact,
} from "./promotion-release";
import { selectReviewedRuns } from "./reviewed-runs";
import { labReviewFilePath } from "./review-store";
import { labRunFilePath, modelSlug } from "./run-store";

export interface PromotionCandidate {
  source: PromotionSource;
  plan: GrantPromotionPlan;
  sourceArtifact: PromotionSourceArtifact;
}

/**
 * release 준비 전용 후보 수집. 미완 감사/pending은 의도적으로 포함하지 않는다.
 * 준비 이후의 aggregate/shadow/promote는 이 함수를 다시 호출하지 않고 manifest만 소비한다.
 */
export async function loadConfirmedPromotionCandidates(): Promise<PromotionCandidate[]> {
  const reviewedSelection = await selectReviewedRuns({ scanAll: false });
  const audited = await loadAuditedConfirmedReviews({
    model: AI_REVIEW_ADOPTED.model,
    scanAll: false,
  });
  const sources = dedupePromotionSources(reviewedSelection.reviewed, audited.confirmed);
  const candidates: PromotionCandidate[] = [];
  for (const source of sources) {
    const run = source.run;
    const runPath = labRunFilePath(run.source, run.sourceId, run.runId);
    const confirmationPath = labConfirmationsFilePath(run.source, run.sourceId, run.runId);
    const overlayPath = humanReviewOverlayFilePath(run.source, run.sourceId, run.runId);
    const sidecar = await readLabConfirmationsFile(confirmationPath);
    const overlay = await readHumanReviewOverlayFile(overlayPath);
    const plan = planGrantPromotion({
      run,
      review: source.review,
      overlay,
      origin: source.origin,
      sidecar,
    });
    const artifact: PromotionSourceArtifact = {
      grantId: run.grantId,
      runId: run.runId,
      runSha256: await hashFile(runPath),
      confirmationsSha256: await hashFileIfPresent(confirmationPath) ?? null,
      overlaySha256: await hashFileIfPresent(overlayPath) ?? null,
    };
    if (source.origin === "human") {
      artifact.reviewSha256 = await hashFile(
        labReviewFilePath(run.source, run.sourceId, run.runId),
      );
    } else {
      const suffix = modelSlug(AI_REVIEW_ADOPTED.model);
      artifact.aiReviewSha256 = await hashFile(
        runPath.replace(/\.json$/, `.ai-review.${suffix}.json`),
      );
      artifact.auditSha256 = await hashFile(
        labAuditFilePath(run.source, run.sourceId, run.runId, AI_REVIEW_ADOPTED.model),
      );
    }
    candidates.push({ source, plan, sourceArtifact: artifact });
  }
  return candidates.sort((left, right) => left.plan.grantId.localeCompare(right.plan.grantId));
}

export async function verifyPromotionSourceArtifact(
  artifact: PromotionSourceArtifact,
): Promise<{ ok: boolean; changed: string[] }> {
  const run = await import("./run-store").then(({ readLabRun }) =>
    readLabRun(artifact.grantId, artifact.runId));
  if (!run) return { ok: false, changed: ["run_missing"] };
  const runPath = labRunFilePath(run.source, run.sourceId, run.runId);
  const checks: Array<[string, string | null | undefined, string | null]> = [
    ["run", artifact.runSha256, await hashFileIfPresent(runPath) ?? null],
    [
      "review",
      artifact.reviewSha256,
      await hashFileIfPresent(labReviewFilePath(run.source, run.sourceId, run.runId)) ?? null,
    ],
    [
      "ai_review",
      artifact.aiReviewSha256,
      await hashFileIfPresent(
        runPath.replace(/\.json$/, `.ai-review.${modelSlug(AI_REVIEW_ADOPTED.model)}.json`),
      ) ?? null,
    ],
    [
      "audit",
      artifact.auditSha256,
      await hashFileIfPresent(
        labAuditFilePath(run.source, run.sourceId, run.runId, AI_REVIEW_ADOPTED.model),
      ) ?? null,
    ],
    [
      "overlay",
      artifact.overlaySha256,
      await hashFileIfPresent(humanReviewOverlayFilePath(run.source, run.sourceId, run.runId)) ?? null,
    ],
    [
      "confirmations",
      artifact.confirmationsSha256,
      await hashFileIfPresent(labConfirmationsFilePath(run.source, run.sourceId, run.runId)) ?? null,
    ],
  ];
  const changed = checks
    .filter(([, expected, actual]) => expected !== undefined && expected !== actual)
    .map(([name]) => name);
  return { ok: changed.length === 0, changed };
}
