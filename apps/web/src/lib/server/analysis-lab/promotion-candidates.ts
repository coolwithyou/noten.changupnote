import { createHash } from "node:crypto";
import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
} from "@cunote/contracts";
import { and, desc, eq } from "drizzle-orm";
import { AI_REVIEW_ADOPTED, type LabRun } from "@/features/dev/analysis-lab/contract";
import { labAuditFilePath } from "./audit-store";
import { isLabAuditCompleteForRun } from "./audited-reviews";
import {
  LAB_DETERMINISTIC_AUDIT_POLICY_VERSION,
  resolveDeterministicAuditDisagreement,
} from "./deterministic-audit-resolution";
import { readBundledPromotionApplicationPrecompute } from "./application-precompute-release";
import { labConfirmationsFilePath } from "./confirmations";
import { humanReviewOverlayFilePath } from "./human-review-overlay";
import {
  type GrantPromotionPlan,
  type PromotionSource,
} from "./promote";
import {
  hashFileIfPresent,
  type PromotionSourceArtifact,
} from "./promotion-release";
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

export interface PromotionSourceVerificationDeps {
  readRunImpl?: (grantId: string, runId: string) => Promise<LabRun | null>;
}

export class PromotionSourceUnavailableError extends Error {
  readonly code = "promotion_source_unavailable" as const;

  constructor(
    readonly grantId: string,
    readonly detail: string,
  ) {
    super(`승격 source를 현재 검증할 수 없습니다: ${grantId} (${detail})`);
    this.name = "PromotionSourceUnavailableError";
  }
}

export interface PromotionReleaseSourceVerificationDeps {
  verifyOne?: (
    artifact: PromotionSourceArtifact,
  ) => Promise<{ ok: boolean; changed: string[] }>;
}

function sourceVerificationUnavailableCode(code: string): boolean {
  return code === "r2_config_missing"
    || code === "input_unavailable"
    || code.endsWith("_unavailable");
}

/**
 * immutable aggregate/shadow/dry-run이 공유하는 source 검증 seam.
 *
 * 실제 hash/revision 차이는 drift 목록으로 반환한다. 파일·DB·스토리지 재구성 실패는
 * 예외로 구분해 호출자가 불변 gate artifact를 쓰기 전에 중단할 수 있게 한다.
 */
export async function verifyPromotionReleaseSources(
  artifacts: readonly PromotionSourceArtifact[],
  deps: PromotionReleaseSourceVerificationDeps = {},
): Promise<string[]> {
  const drift: string[] = [];
  for (const artifact of artifacts) {
    let result: { ok: boolean; changed: string[] };
    try {
      if (deps.verifyOne) {
        result = await deps.verifyOne(artifact);
      } else if (artifact.localLabEvidence?.reviewMethod === "deep_repair_receipt") {
        const { verifyDeepRepairPromotionSourceArtifactDetailed } = await import(
          "./deep-repair-promotion"
        );
        result = await verifyDeepRepairPromotionSourceArtifactDetailed(artifact);
      } else {
        result = await verifyPromotionSourceArtifact(artifact);
      }
    } catch (error) {
      throw new PromotionSourceUnavailableError(
        artifact.grantId,
        error instanceof Error ? error.message : String(error),
      );
    }
    const unavailable = result.changed.find(sourceVerificationUnavailableCode);
    if (unavailable) {
      throw new PromotionSourceUnavailableError(artifact.grantId, unavailable);
    }
    for (const changed of result.changed) drift.push(`${artifact.grantId}:${changed}`);
  }
  return drift;
}

export async function verifyPromotionSourceArtifact(
  artifact: PromotionSourceArtifact,
  deps: PromotionSourceVerificationDeps = {},
): Promise<{ ok: boolean; changed: string[] }> {
  if (artifact.deepAnalysisRunId) {
    return verifyDeepAnalysisPromotionSourceArtifact(artifact);
  }
  if (artifact.localLabEvidence?.reviewMethod === "deep_repair_receipt") {
    const { verifyDeepRepairPromotionSourceArtifact } = await import("./deep-repair-promotion");
    return verifyDeepRepairPromotionSourceArtifact(artifact);
  }
  let readRunImpl = deps.readRunImpl;
  if (!readRunImpl) ({ readLabRun: readRunImpl } = await import("./run-store"));
  const run = await readRunImpl(artifact.grantId, artifact.runId);
  if (!run) return { ok: false, changed: ["run_missing"] };
  if (!isPublishableLabRun(run)) return { ok: false, changed: ["run_outcome"] };
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
    if (run.applicationRoundtrip?.runId || artifact.applicationPrecompute) {
      if (!artifact.applicationPrecompute) {
        changed.push("application_precompute_missing");
      } else {
        try {
          const bundled = await readBundledPromotionApplicationPrecompute(
            artifact.applicationPrecompute,
          );
          const embedded = run.applicationRoundtrip;
          const evidence = artifact.applicationPrecompute;
          if (embedded ? (
            bundled.run.runId !== embedded.runId
            || bundled.run.transport !== embedded.transport
            || bundled.run.requestedModel !== embedded.model
          ) : (
            evidence.schema !== "promotion-application-precompute-v2"
            || evidence.parentLabRunId !== run.runId
            || evidence.canaryAdmission?.deepReceiptSha256
              !== artifact.localLabEvidence.deepRepair?.receiptSha256
          )) {
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
