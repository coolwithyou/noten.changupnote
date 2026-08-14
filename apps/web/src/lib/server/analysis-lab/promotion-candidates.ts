import { createHash } from "node:crypto";
import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
} from "@cunote/contracts";
import { and, desc, eq } from "drizzle-orm";
import { AI_REVIEW_ADOPTED } from "@/features/dev/analysis-lab/contract";
import { labAuditFilePath } from "./audit-store";
import {
  isLabAuditCompleteForRun,
  loadAuditedConfirmedReviews,
} from "./audited-reviews";
import {
  LAB_DETERMINISTIC_AUDIT_POLICY_VERSION,
  resolveDeterministicAuditDisagreement,
} from "./deterministic-audit-resolution";
import { readBundledPromotionApplicationPrecompute } from "./application-precompute-release";
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
  isVerifiedLocalLabSourceArtifact,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionSourceArtifact,
} from "./promotion-release";
import { selectReviewedRuns } from "./reviewed-runs";
import { labReviewFilePath } from "./review-store";
import { labRunFilePath, modelSlug } from "./run-store";
import { isPublishableLabRun } from "./run-outcome";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { prepareDeepAnalysisInput } from "../deep-analysis/prepareInput";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";

export interface PromotionCandidate {
  source: PromotionSource;
  plan: GrantPromotionPlan;
  sourceArtifact: PromotionSourceArtifact;
}

export interface PromotionCandidateSelectionOptions {
  grantId?: string;
  auditedLocalCanary?: boolean;
}

/**
 * 주간 사람검수 release와 별개로 여는 유일한 우회 경로다. 정확히 한 공고를 지정하고,
 * 구독 transport의 AI 검수+감사가 모두 봉인된 경우에만 후보 1건을 반환한다.
 */
export function selectPromotionCandidatesForRelease(
  candidates: readonly PromotionCandidate[],
  options: PromotionCandidateSelectionOptions = {},
): PromotionCandidate[] {
  if (!options.grantId) return [...candidates];
  if (!options.auditedLocalCanary) {
    throw new Error("단일 로컬 승격은 --audited-local-canary 명시가 필요합니다.");
  }
  const selected = candidates.filter((candidate) => candidate.plan.grantId === options.grantId);
  if (selected.length !== 1) {
    throw new Error(`단일 로컬 승격 후보는 정확히 1건이어야 합니다: ${options.grantId} (${selected.length}건)`);
  }
  const [candidate] = selected;
  if (
    !candidate
    || candidate.source.origin !== "audited"
    || candidate.source.run.transport !== "claude-cli"
    || !isPublishableLabRun(candidate.source.run)
    || candidate.sourceArtifact.localLabEvidence?.reviewMethod !== "ai_audit"
    || !isVerifiedLocalLabSourceArtifact(candidate.sourceArtifact)
  ) {
    throw new Error(`AI 검수·감사가 봉인된 구독 분석만 단일 로컬 승격할 수 있습니다: ${options.grantId}`);
  }
  return [candidate];
}

/**
 * release 준비 전용 후보 수집. 미완 감사/pending은 의도적으로 포함하지 않는다.
 * 준비 이후의 aggregate/shadow/promote는 이 함수를 다시 호출하지 않고 manifest만 소비한다.
 */
export async function loadConfirmedPromotionCandidates(options: {
  scanAll?: boolean;
} = {}): Promise<PromotionCandidate[]> {
  const scanAll = options.scanAll === true;
  const reviewedSelection = await selectReviewedRuns({ scanAll });
  const audited = await loadAuditedConfirmedReviews({
    model: AI_REVIEW_ADOPTED.model,
    scanAll,
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
      ...(source.auditEvidence?.deterministicResolvedCriterionIndexes
        ? {
            deterministicResolvedCriterionIndexes:
              source.auditEvidence.deterministicResolvedCriterionIndexes,
          }
        : {}),
      sidecar,
    });
    const artifact: PromotionSourceArtifact = {
      grantId: run.grantId,
      runId: run.runId,
      runSha256: await hashFile(runPath),
      confirmationsSha256: await hashFileIfPresent(confirmationPath) ?? null,
      overlaySha256: await hashFileIfPresent(overlayPath) ?? null,
      ...(run.transport === "claude-cli"
        ? {
            localLabEvidence: {
              schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
              transport: "claude-cli" as const,
              model: run.model,
              promptVersion: run.promptVersion,
              inputSha256: run.inputSha256,
              reviewMethod: source.origin === "human" ? "human" as const : "ai_audit" as const,
              ...(source.origin === "audited" && source.auditEvidence
                ? {
                    reviewModel: source.auditEvidence.reviewModel,
                    reviewPromptVersion: source.auditEvidence.reviewPromptVersion,
                    ...(source.auditEvidence.reviewTransport === "claude-cli"
                      ? { reviewTransport: "claude-cli" as const }
                      : {}),
                    ...(source.auditEvidence.auditModel
                      ? { auditModel: source.auditEvidence.auditModel }
                      : {}),
                    ...(source.auditEvidence.auditPromptVersion
                      ? { auditPromptVersion: source.auditEvidence.auditPromptVersion }
                      : {}),
                    ...(source.auditEvidence.auditTransport === "claude-cli"
                      ? { auditTransport: "claude-cli" as const }
                      : {}),
                    ...(source.auditEvidence.deterministicPolicyVersion
                      ? {
                          deterministicPolicyVersion:
                            source.auditEvidence.deterministicPolicyVersion,
                          deterministicResolvedCriterionIndexes:
                            source.auditEvidence.deterministicResolvedCriterionIndexes,
                        }
                      : {}),
                  }
                : {}),
            },
          }
        : {}),
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
  if (artifact.deepAnalysisRunId) {
    return verifyDeepAnalysisPromotionSourceArtifact(artifact);
  }
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
  if (!isPublishableLabRun(run)) changed.push("run_outcome");
  if (artifact.localLabEvidence) {
    if (run.transport !== artifact.localLabEvidence.transport) changed.push("transport");
    if (run.model !== artifact.localLabEvidence.model) changed.push("model");
    if (run.promptVersion !== artifact.localLabEvidence.promptVersion) changed.push("prompt_version");
    if (run.inputSha256 !== artifact.localLabEvidence.inputSha256) changed.push("input_evidence");
    try {
      const { reassembleLabInputForRun } = await import("./ai-review");
      const currentInput = await reassembleLabInputForRun(run);
      if (currentInput.inputSha256 !== run.inputSha256) changed.push("input");
    } catch {
      changed.push("input_unavailable");
    }
    if (artifact.localLabEvidence.reviewMethod === "ai_audit") {
      const suffix = modelSlug(artifact.localLabEvidence.reviewModel ?? "");
      const reviewPath = runPath.replace(/\.json$/, `.ai-review.${suffix}.json`);
      const auditPath = labAuditFilePath(
        run.source,
        run.sourceId,
        run.runId,
        artifact.localLabEvidence.reviewModel ?? "",
      );
      const [{ readAiReviewFile }, { readLabAuditFileAt }] = await Promise.all([
        import("./ai-review"),
        import("./audit-store"),
      ]);
      const [review, audit] = await Promise.all([
        readAiReviewFile(reviewPath),
        readLabAuditFileAt(auditPath),
      ]);
      if (
        !review
        || review.model !== artifact.localLabEvidence.reviewModel
        || review.promptVersion !== artifact.localLabEvidence.reviewPromptVersion
        || review.aiReviewTransport !== artifact.localLabEvidence.reviewTransport
        || review.inputSha256Verified !== true
      ) {
        changed.push("ai_review_provenance");
      }
      if (
        !audit
        || !isLabAuditCompleteForRun(run, audit)
        || audit.model !== artifact.localLabEvidence.reviewModel
        || audit.aiPromptVersion !== artifact.localLabEvidence.reviewPromptVersion
        || audit.aiAuditModel !== artifact.localLabEvidence.auditModel
        || audit.aiAuditPromptVersion !== artifact.localLabEvidence.auditPromptVersion
        || audit.aiAuditTransport !== artifact.localLabEvidence.auditTransport
      ) {
        changed.push("ai_audit_provenance");
      }
      if (audit) {
        const resolved = audit.items.flatMap((item) =>
          resolveDeterministicAuditDisagreement(run, item) ? [item.criterionIndex!] : [])
          .sort((a, b) => a - b);
        const expected = [...(artifact.localLabEvidence.deterministicResolvedCriterionIndexes ?? [])]
          .sort((a, b) => a - b);
        if (JSON.stringify(resolved) !== JSON.stringify(expected)) {
          changed.push("deterministic_audit_resolution");
        }
        if (
          resolved.length > 0
          && artifact.localLabEvidence.deterministicPolicyVersion
            !== LAB_DETERMINISTIC_AUDIT_POLICY_VERSION
        ) {
          changed.push("deterministic_audit_policy");
        }
      }
    }
    if (run.applicationRoundtrip?.runId) {
      if (!artifact.applicationPrecompute) {
        changed.push("application_precompute_missing");
      } else {
        try {
          const bundled = await readBundledPromotionApplicationPrecompute(
            artifact.applicationPrecompute,
          );
          if (
            bundled.run.runId !== run.applicationRoundtrip.runId
            || bundled.run.transport !== run.applicationRoundtrip.transport
            || bundled.run.requestedModel !== run.applicationRoundtrip.model
          ) {
            changed.push("application_precompute_provenance");
          }
        } catch {
          changed.push("application_precompute_artifact");
        }
      }
    }
  }
  return { ok: changed.length === 0, changed };
}

async function verifyDeepAnalysisPromotionSourceArtifact(
  artifact: PromotionSourceArtifact,
): Promise<{ ok: boolean; changed: string[] }> {
  const changed: string[] = [];
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) return { ok: false, changed: ["r2_config_missing"] };
  const [run] = await db
    .select()
    .from(schema.grantDeepAnalysisRuns)
    .where(eq(schema.grantDeepAnalysisRuns.id, artifact.deepAnalysisRunId!))
    .limit(1);
  if (!run) return { ok: false, changed: ["deep_run_missing"] };
  if (run.runId !== artifact.runId) changed.push("run_id");
  if (run.grantId !== artifact.grantId) changed.push("grant_id");
  if (run.status !== "passed") changed.push("run_status");
  if (run.sourceRevisionSha256 !== artifact.sourceRevisionSha256) changed.push("source_revision");
  if (run.inputSha256 !== artifact.inputSha256) changed.push("input");
  if (run.outputArtifactKey !== artifact.outputArtifactKey) changed.push("output_key");
  if (!run.outputArtifactKey) {
    changed.push("output_missing");
  } else {
    const output = await storage.getObjectBytes(run.outputArtifactKey);
    if (sha256(output.body) !== artifact.runSha256) changed.push("output");
  }

  const [latestJob] = await db
    .select()
    .from(schema.grantDeepAnalysisJobs)
    .where(and(
      eq(schema.grantDeepAnalysisJobs.grantId, artifact.grantId),
      eq(schema.grantDeepAnalysisJobs.modelPolicyVersion, DEEP_ANALYSIS_MODEL_POLICY_VERSION),
    ))
    .orderBy(desc(schema.grantDeepAnalysisJobs.createdAt), desc(schema.grantDeepAnalysisJobs.id))
    .limit(1);
  if (!latestJob || latestJob.id !== run.jobId) changed.push("current_job");
  if (latestJob && latestJob.sourceRevisionSha256 !== run.sourceRevisionSha256) {
    changed.push("job_source_revision");
  }

  const [analysisReceipt] = await db
    .select()
    .from(schema.grantDeepAnalysisStageReceipts)
    .where(and(
      eq(schema.grantDeepAnalysisStageReceipts.runId, run.id),
      eq(schema.grantDeepAnalysisStageReceipts.stage, "analysis_complete"),
    ))
    .orderBy(
      desc(schema.grantDeepAnalysisStageReceipts.attempt),
      desc(schema.grantDeepAnalysisStageReceipts.createdAt),
    )
    .limit(1);
  if (analysisReceipt?.status !== "passed") changed.push("analysis_complete");

  const [audit] = await db
    .select()
    .from(schema.grantDeepAnalysisAudits)
    .where(eq(schema.grantDeepAnalysisAudits.runId, run.id))
    .orderBy(desc(schema.grantDeepAnalysisAudits.attempt))
    .limit(1);
  if (!audit) {
    changed.push("audit_verdict");
  } else {
    if (artifact.auditVerdict === undefined) {
      if (audit.verdict !== "concur") changed.push("audit_verdict");
    } else if (
      audit.verdict !== artifact.auditVerdict
      || (audit.verdict !== "concur" && audit.verdict !== "unsure")
    ) {
      changed.push("audit_verdict");
    }
    if (audit.artifactKey !== artifact.auditArtifactKey) changed.push("audit_key");
    if (audit.artifactSha256 !== artifact.auditSha256) changed.push("audit_hash");
    const auditObject = await storage.getObjectBytes(audit.artifactKey);
    if (sha256(auditObject.body) !== audit.artifactSha256) changed.push("audit_artifact");
  }

  const currentInput = await prepareDeepAnalysisInput({
    db,
    storage,
    grantId: artifact.grantId,
    maxTotalChars: DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
  });
  if (!currentInput.sealed) changed.push("current_input_unsealed");
  if (currentInput.sourceRevisionSha256 !== run.sourceRevisionSha256) {
    changed.push("current_source_revision");
  }
  if (currentInput.inputSha256 !== run.inputSha256) changed.push("current_input");
  return { ok: changed.length === 0, changed: [...new Set(changed)] };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
