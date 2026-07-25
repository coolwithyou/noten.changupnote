import { randomUUID } from "node:crypto";
import {
  DEEP_ANALYSIS_PROMPT_VERSION,
  type DeepAnalysisStageStatus,
} from "@cunote/contracts";
import { eq } from "drizzle-orm";
import type { CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { analyzeSealedDeepAnalysisInput } from "./analyzer";
import {
  DEEP_ANALYSIS_AUDIT_PROMPT_VERSION,
  runBlindDeepAnalysisAudit,
} from "./audit";
import { putImmutableDeepAnalysisArtifact } from "./artifacts";
import { buildDeepAnalysisInputStageReceipts } from "./inputStages";
import {
  appendDeepAnalysisExceptionEvent,
  enqueueDeepAnalysisJob,
  findLatestDeepAnalysisRunForJob,
} from "./ledger";
import { prepareDeepAnalysisInput } from "./prepareInput";
import { repairDeepAnalysisExecution } from "./repair";
import { appendVerifiedDeepAnalysisStageReceipt } from "./receipts";
import { stableJson } from "./sourceRevision";
import {
  DEEP_ANALYSIS_VALIDATOR_VERSION,
  validateDeepAnalysisResult,
} from "./validator";
import type { DeepAnalysisWorkerPolicy } from "./workerPolicy";
import { completeDeepAnalysisJob } from "./workerState";

export const DEEP_ANALYSIS_PROCESSOR_VERSION = "deep-analysis-processor-v1" as const;

type DeepAnalysisJob = typeof schema.grantDeepAnalysisJobs.$inferSelect;

export async function processDeepAnalysisJob(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  apiKey: string;
  job: DeepAnalysisJob;
  policy: DeepAnalysisWorkerPolicy;
  actor?: string;
}): Promise<{ runId: string; databaseRunId: string }> {
  const actor = input.actor ?? "deep-analysis-worker";
  const latest = await findLatestDeepAnalysisRunForJob(input.db, input.job.id);
  if (latest?.status === "passed") {
    await completeDeepAnalysisJob(input.db, input.job.id);
    return { runId: latest.runId, databaseRunId: latest.id };
  }

  const seal = await prepareDeepAnalysisInput({
    db: input.db,
    storage: input.storage,
    grantId: input.job.grantId,
    maxTotalChars: input.policy.maxTotalInputChars,
  });
  if (seal.sourceRevisionSha256 !== input.job.sourceRevisionSha256) {
    await enqueueDeepAnalysisJob(input.db, {
      grantId: input.job.grantId,
      sourceRevisionSha256: seal.sourceRevisionSha256,
      modelPolicyVersion: input.policy.modelPolicyVersion,
      priority: input.job.priority + 1,
      maxAttempts: input.job.maxAttempts,
    });
    throw new Error(
      `Deep analysis input is not sealed: source revision changed from ${input.job.sourceRevisionSha256.slice(0, 12)} to ${seal.sourceRevisionSha256.slice(0, 12)}`,
    );
  }

  const publicRunId = buildDeepAnalysisRunId();
  const inputArtifact = await putImmutableDeepAnalysisArtifact({
    storage: input.storage,
    identity: {
      grantId: input.job.grantId,
      sourceRevisionSha256: seal.sourceRevisionSha256,
      runId: publicRunId,
      kind: "input",
      extension: "json",
    },
    body: seal.inputArtifactBody,
    contentType: "application/json",
  });
  const [run] = await input.db.insert(schema.grantDeepAnalysisRuns).values({
    runId: publicRunId,
    jobId: input.job.id,
    grantId: input.job.grantId,
    sourceRevisionSha256: seal.sourceRevisionSha256,
    attachmentManifestSha256: seal.attachmentManifestSha256,
    inputSha256: seal.inputSha256,
    inputArtifactKey: inputArtifact.key,
    model: input.policy.primaryModel,
    promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
    modelPolicyVersion: input.policy.modelPolicyVersion,
    inputChars: seal.totalChars,
    ...(latest ? { supersedesRunId: latest.id } : {}),
  }).returning();
  if (!run) throw new Error("Failed to create deep analysis run");

  const receiptContext = {
    db: input.db,
    storage: input.storage,
    grantId: input.job.grantId,
    sourceRevisionSha256: seal.sourceRevisionSha256,
    publicRunId,
    databaseRunId: run.id,
  };
  let terminalized = false;
  const finishCurrentRun = async (
    terminal: Parameters<typeof finishRun>[2],
  ): Promise<void> => {
    await finishRun(input.db, run.id, terminal);
    terminalized = true;
  };

  try {
    for (const draft of buildDeepAnalysisInputStageReceipts(seal)) {
      await appendVerifiedDeepAnalysisStageReceipt({
        ...receiptContext,
        ...draft,
        verifierVersion: DEEP_ANALYSIS_PROCESSOR_VERSION,
      });
    }
    if (!seal.sealed) {
      await openException(input.db, run.id, actor, "input_not_sealed", {
        blockers: seal.blockers,
        attachmentManifestSha256: seal.attachmentManifestSha256,
      });
      await finishCurrentRun({
        status: "blocked",
        errorCode: "input_not_sealed",
        errorMessage: seal.blockers.map((item) => item.message).join("; "),
      });
      throw new Error(`Deep analysis input is not sealed: ${seal.blockers.map((item) => item.code).join(",")}`);
    }

    let primary;
    try {
      primary = await analyzeSealedDeepAnalysisInput({
        seal,
        apiKey: input.apiKey,
        model: input.policy.primaryModel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendVerifiedDeepAnalysisStageReceipt({
        ...receiptContext,
        stage: "model_call_passed",
        status: "failed",
        verifierVersion: DEEP_ANALYSIS_PROCESSOR_VERSION,
        evidence: { error: message.slice(0, 2_000) },
      });
      await finishCurrentRun({
        status: "failed",
        errorCode: "primary_model_failed",
        errorMessage: message,
      });
      throw error;
    }

    let validation = validateDeepAnalysisResult({ seal, result: primary.result });
    try {
      for (let repairAttempt = 0; repairAttempt < 2 && !validation.valid; repairAttempt += 1) {
        primary = await repairDeepAnalysisExecution({
          seal,
          apiKey: input.apiKey,
          model: input.policy.primaryModel,
          failedExecution: primary,
          validation,
        });
        validation = validateDeepAnalysisResult({ seal, result: primary.result });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendVerifiedDeepAnalysisStageReceipt({
        ...receiptContext,
        stage: "model_call_passed",
        status: "failed",
        verifierVersion: DEEP_ANALYSIS_PROCESSOR_VERSION,
        evidence: {
          error: message.slice(0, 2_000),
          phase: "primary_repair",
          completedPassCount: primary.passes.length,
        },
      });
      await finishCurrentRun({
        status: "failed",
        errorCode: "primary_repair_failed",
        errorMessage: message,
      });
      throw error;
    }

    const rawArtifact = await putImmutableDeepAnalysisArtifact({
      storage: input.storage,
      identity: {
        grantId: input.job.grantId,
        sourceRevisionSha256: seal.sourceRevisionSha256,
        runId: publicRunId,
        kind: "raw-response",
        extension: "json",
      },
      body: `${stableJson({
        schema: "deep-analysis-raw-passes-v1",
        passes: primary.passes.map((pass) => ({
          kind: pass.kind,
          chunkId: pass.chunkId,
          inputChars: pass.inputChars,
          rawResponseText: pass.result.rawResponseText,
          rawToolInput: pass.result.rawToolInput,
          stopReason: pass.result.stopReason,
          usage: pass.result.usage,
          costUsd: pass.result.costUsd,
        })),
      })}\n`,
      contentType: "application/json",
    });
    await appendVerifiedDeepAnalysisStageReceipt({
      ...receiptContext,
      stage: "model_call_passed",
      status: "passed",
      verifierVersion: DEEP_ANALYSIS_PROCESSOR_VERSION,
      evidence: {
        model: input.policy.primaryModel,
        promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
        passCount: primary.passes.length,
        repairCount: primary.passes.filter((pass) => pass.kind === "repair").length,
        rawArtifactKey: rawArtifact.key,
      },
    });
    await input.db.update(schema.grantDeepAnalysisRuns).set({
      rawResponseArtifactKey: rawArtifact.key,
      inputTokens: primary.result.usage?.inputTokens ?? null,
      outputTokens: primary.result.usage?.outputTokens ?? null,
      costUsd: money(primary.result.costUsd),
    }).where(eq(schema.grantDeepAnalysisRuns.id, run.id));

    const outputArtifact = await putImmutableDeepAnalysisArtifact({
      storage: input.storage,
      identity: {
        grantId: input.job.grantId,
        sourceRevisionSha256: seal.sourceRevisionSha256,
        runId: publicRunId,
        kind: "normalized-output",
        extension: "json",
      },
      body: `${stableJson({
        schema: "deep-analysis-normalized-output-v1",
        result: stripRawModelResult(primary.result),
        validation,
      })}\n`,
      contentType: "application/json",
    });
    await input.db.update(schema.grantDeepAnalysisRuns).set({
      outputArtifactKey: outputArtifact.key,
    }).where(eq(schema.grantDeepAnalysisRuns.id, run.id));
    await appendValidationReceipts(receiptContext, validation, outputArtifact.key);

  if (validation.axisCoverageComplete) {
    const refsByDimension = new Map(
      validation.criteria.map((item) => [item.criterion.dimension, item.evidenceRefs]),
    );
    await input.db.insert(schema.grantDeepAnalysisAxisResults).values(
      primary.result.axisAssessments.map((axis) => ({
        runId: run.id,
        dimension: axis.dimension,
        status: axis.status,
        confidence: axis.confidence,
        comment: axis.comment,
        evidenceRefs: refsByDimension.get(axis.dimension) ?? [],
        criterionSemanticHashes: validation.axisCriterionSemanticHashes[axis.dimension],
      })),
    );
  }
  if (!validation.valid) {
    await openException(input.db, run.id, actor, "primary_validation_failed", {
      issues: validation.issues,
      outputArtifactKey: outputArtifact.key,
    });
    await finishCurrentRun({
      status: "failed",
      errorCode: "primary_validation_failed",
      errorMessage: validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    });
    throw new Error("Deep analysis response contract invalid");
  }

  const primaryCost = primary.result.costUsd ?? 0;
  if (primaryCost * 2 > input.policy.perNoticeCostCapUsd) {
    await openException(input.db, run.id, actor, "per_notice_cost_cap", {
      primaryCostUsd: primaryCost,
      projectedAuditCostUsd: primaryCost,
      capUsd: input.policy.perNoticeCostCapUsd,
    });
    await finishCurrentRun({
      status: "blocked",
      errorCode: "pending_budget",
      errorMessage: "Projected primary + audit cost exceeds per-notice cost cap",
    });
    throw new Error("per-notice cost cap reached; pending_budget");
  }

  const auditStartedAt = new Date();
  let audit;
  try {
    audit = await runBlindDeepAnalysisAudit({
      seal,
      apiKey: input.apiKey,
      auditModel: input.policy.auditModel,
      primaryValidation: validation,
      primaryResult: primary.result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendVerifiedDeepAnalysisStageReceipt({
      ...receiptContext,
      stage: "independent_audit_passed",
      status: "failed",
      verifierVersion: DEEP_ANALYSIS_AUDIT_PROMPT_VERSION,
      evidence: { error: message.slice(0, 2_000), phase: "audit_model_or_repair" },
    });
    await finishCurrentRun({
      status: "failed",
      errorCode: "independent_audit_failed",
      errorMessage: message,
    });
    throw error;
  }
  const auditCompletedAt = new Date();
  const auditArtifact = await putImmutableDeepAnalysisArtifact({
    storage: input.storage,
    identity: {
      grantId: input.job.grantId,
      sourceRevisionSha256: seal.sourceRevisionSha256,
      runId: publicRunId,
      kind: "audit",
      extension: "json",
    },
    body: `${stableJson({
      schema: "deep-analysis-blind-audit-v1",
      model: audit.model,
      promptVersion: audit.promptVersion,
      verdict: audit.verdict,
      itemResults: audit.itemResults,
      validation: audit.validation,
      passes: audit.execution.passes.map((pass) => ({
        kind: pass.kind,
        chunkId: pass.chunkId,
        inputChars: pass.inputChars,
        rawResponseText: pass.result.rawResponseText,
        rawToolInput: pass.result.rawToolInput,
        usage: pass.result.usage,
        costUsd: pass.result.costUsd,
      })),
      adjudication: audit.adjudication,
    })}\n`,
    contentType: "application/json",
  });
  await input.db.insert(schema.grantDeepAnalysisAudits).values({
    runId: run.id,
    attempt: 1,
    model: audit.model,
    promptVersion: DEEP_ANALYSIS_AUDIT_PROMPT_VERSION,
    inputSha256: seal.inputSha256,
    verdict: audit.verdict,
    itemResults: audit.itemResults.map((item) => ({ ...item })),
    artifactKey: auditArtifact.key,
    artifactSha256: auditArtifact.sha256,
    startedAt: auditStartedAt,
    completedAt: auditCompletedAt,
  });
  await appendVerifiedDeepAnalysisStageReceipt({
    ...receiptContext,
    stage: "independent_audit_passed",
    status: audit.verdict === "concur" ? "passed" : "failed",
    verifierVersion: DEEP_ANALYSIS_AUDIT_PROMPT_VERSION,
    evidence: {
      verdict: audit.verdict,
      auditModel: audit.model,
      auditArtifactKey: auditArtifact.key,
      disagreementCount: audit.itemResults.filter((item) => item.verdict === "disagree").length,
    },
  });
  const totalCost = primaryCost
    + (audit.execution.result.costUsd ?? 0)
    + (audit.adjudication?.costUsd ?? 0);
  await input.db.update(schema.grantDeepAnalysisRuns).set({
    inputTokens: (primary.result.usage?.inputTokens ?? 0)
      + (audit.execution.result.usage?.inputTokens ?? 0)
      + (audit.adjudication?.usage?.inputTokens ?? 0),
    outputTokens: (primary.result.usage?.outputTokens ?? 0)
      + (audit.execution.result.usage?.outputTokens ?? 0)
      + (audit.adjudication?.usage?.outputTokens ?? 0),
    costUsd: money(totalCost),
  }).where(eq(schema.grantDeepAnalysisRuns.id, run.id));
  if (audit.verdict !== "concur") {
    await openException(input.db, run.id, actor, "independent_audit_disagreement", {
      verdict: audit.verdict,
      disagreements: audit.itemResults.filter((item) => item.verdict === "disagree"),
      auditArtifactKey: auditArtifact.key,
    });
    await finishCurrentRun({
      status: "failed",
      errorCode: "independent_audit_disagreement",
      errorMessage: "Blind audit did not concur with primary analysis",
    });
    throw new Error("Deep analysis independent audit did not concur");
  }
  if (totalCost > input.policy.perNoticeCostCapUsd) {
    await openException(input.db, run.id, actor, "per_notice_cost_cap_exceeded", {
      totalCostUsd: totalCost,
      capUsd: input.policy.perNoticeCostCapUsd,
    });
    await finishCurrentRun({
      status: "failed",
      errorCode: "per_notice_cost_cap_exceeded",
      errorMessage: "Actual primary + audit cost exceeded per-notice cap",
    });
    throw new Error("per-notice cost cap exceeded; pending_budget");
  }

  await appendVerifiedDeepAnalysisStageReceipt({
    ...receiptContext,
    stage: "analysis_complete",
    status: "passed",
    verifierVersion: DEEP_ANALYSIS_PROCESSOR_VERSION,
    evidence: {
      inputSha256: seal.inputSha256,
      outputArtifactKey: outputArtifact.key,
      auditArtifactKey: auditArtifact.key,
      axisCount: primary.result.axisAssessments.length,
      criterionCount: validation.criteria.length,
    },
  });
    await finishCurrentRun({ status: "passed" });
    await completeDeepAnalysisJob(input.db, input.job.id);
    return { runId: publicRunId, databaseRunId: run.id };
  } catch (error) {
    if (!terminalized) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await openException(input.db, run.id, actor, "processor_unhandled_failure", {
          error: message.slice(0, 2_000),
        });
      } catch {
        // 원래 실패를 보존한다. run terminalization은 별도로 한 번 더 시도한다.
      }
      try {
        await finishRun(input.db, run.id, {
          status: "failed",
          errorCode: "processor_unhandled_failure",
          errorMessage: message,
        });
      } catch {
        // worker lease/dead-letter가 후속 복구의 단서가 되므로 원래 실패를 다시 던진다.
      }
    }
    throw error;
  }
}

async function appendValidationReceipts(
  context: Parameters<typeof appendVerifiedDeepAnalysisStageReceipt>[0] extends infer T
    ? Omit<T, "stage" | "status" | "verifierVersion" | "evidence">
    : never,
  validation: ReturnType<typeof validateDeepAnalysisResult>,
  outputArtifactKey: string,
): Promise<void> {
  const rows: Array<{
    stage: "response_contract_valid" | "axis_coverage_complete" | "evidence_grounded";
    status: DeepAnalysisStageStatus;
    passed: boolean;
  }> = [
    {
      stage: "response_contract_valid",
      status: validation.responseContractValid ? "passed" : "failed",
      passed: validation.responseContractValid,
    },
    {
      stage: "axis_coverage_complete",
      status: validation.axisCoverageComplete ? "passed" : "failed",
      passed: validation.axisCoverageComplete,
    },
    {
      stage: "evidence_grounded",
      status: validation.evidenceGrounded ? "passed" : "failed",
      passed: validation.evidenceGrounded,
    },
  ];
  for (const row of rows) {
    await appendVerifiedDeepAnalysisStageReceipt({
      ...context,
      stage: row.stage,
      status: row.status,
      verifierVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      evidence: {
        passed: row.passed,
        issueCount: validation.issues.length,
        issues: validation.issues,
        outputArtifactKey,
      },
    });
  }
}

async function openException(
  db: CunoteDbSession,
  runId: string,
  actor: string,
  reasonCode: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await appendDeepAnalysisExceptionEvent(db, {
    runId,
    exceptionKey: `${runId}:${reasonCode}`,
    eventType: "opened",
    reasonCode,
    actorType: "system",
    actor,
    detail,
  });
}

async function finishRun(
  db: CunoteDbSession,
  runId: string,
  input: {
    status: "passed" | "failed" | "blocked";
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<void> {
  await db.update(schema.grantDeepAnalysisRuns).set({
    status: input.status,
    completedAt: new Date(),
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage?.slice(0, 2_000) ?? null,
  }).where(eq(schema.grantDeepAnalysisRuns.id, runId));
}

function stripRawModelResult(result: Awaited<ReturnType<typeof analyzeSealedDeepAnalysisInput>>["result"]) {
  const {
    rawResponseText: _rawResponseText,
    rawToolInput: _rawToolInput,
    ...normalized
  } = result;
  return normalized;
}

function money(value: number | null): string | null {
  return value === null ? null : value.toFixed(6);
}

function buildDeepAnalysisRunId(now: Date = new Date()): string {
  return `da-${now.toISOString().replace(/[-:.]/g, "")}-${randomUUID()}`;
}
