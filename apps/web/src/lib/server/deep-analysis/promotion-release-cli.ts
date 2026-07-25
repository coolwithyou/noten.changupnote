import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
} from "@cunote/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { LabCurrentCriterion } from "@/features/dev/analysis-lab/contract";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  createPromotionReleaseManifest,
  planSha256,
  promotionReleaseArtifactPath,
  writeImmutablePromotionArtifact,
  type PromotionReleasePlanItem,
  type PromotionSourceArtifact,
} from "../analysis-lab/promotion-release";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotHashes,
  promotionGrantSnapshotStateSha256,
} from "../analysis-lab/promotion-snapshot";
import { verifyPromotionSourceArtifact } from "../analysis-lab/promotion-candidates";
import { findMonorepoRoot } from "../analysis-lab/run-store";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { prepareDeepAnalysisInput } from "./prepareInput";
import {
  buildDeepAnalysisPromotionPlan,
  parseDeepAnalysisNormalizedOutput,
} from "./promotion";

loadMonorepoEnv();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function git(command: string[]): string {
  return execFileSync("git", command, {
    cwd: findMonorepoRoot(),
    encoding: "utf8",
  }).trim();
}

function assertCleanGitTree(): { gitCommit: string; buildDigest: string } {
  if (git(["status", "--porcelain"])) {
    throw new Error("deep release 준비는 clean git tree에서만 가능합니다.");
  }
  return {
    gitCommit: git(["rev-parse", "HEAD"]),
    buildDigest: git(["rev-parse", "HEAD^{tree}"]),
  };
}

function releaseIdFor(now: Date, commit: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `deep-production-r1-${stamp}-${commit.slice(0, 8)}`;
}

async function prepare(): Promise<number> {
  const actor = readArg("actor")?.trim();
  const runIds = [...new Set(
    (readArg("run") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  )];
  if (!actor) throw new Error("--actor가 필요합니다.");
  if (runIds.length === 0) throw new Error("--run에 deep analysis DB run UUID가 필요합니다.");
  if (runIds.some((value) => !isUuid(value))) throw new Error("--run은 UUID CSV여야 합니다.");
  const build = assertCleanGitTree();
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 환경변수가 필요합니다.");
  const runs = await db
    .select({
      id: schema.grantDeepAnalysisRuns.id,
      runId: schema.grantDeepAnalysisRuns.runId,
      jobId: schema.grantDeepAnalysisRuns.jobId,
      grantId: schema.grantDeepAnalysisRuns.grantId,
      sourceRevisionSha256: schema.grantDeepAnalysisRuns.sourceRevisionSha256,
      inputSha256: schema.grantDeepAnalysisRuns.inputSha256,
      inputChars: schema.grantDeepAnalysisRuns.inputChars,
      outputArtifactKey: schema.grantDeepAnalysisRuns.outputArtifactKey,
      model: schema.grantDeepAnalysisRuns.model,
      promptVersion: schema.grantDeepAnalysisRuns.promptVersion,
      modelPolicyVersion: schema.grantDeepAnalysisRuns.modelPolicyVersion,
      status: schema.grantDeepAnalysisRuns.status,
      costUsd: schema.grantDeepAnalysisRuns.costUsd,
      startedAt: schema.grantDeepAnalysisRuns.startedAt,
      completedAt: schema.grantDeepAnalysisRuns.completedAt,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
    })
    .from(schema.grantDeepAnalysisRuns)
    .innerJoin(schema.grants, eq(schema.grants.id, schema.grantDeepAnalysisRuns.grantId))
    .where(inArray(schema.grantDeepAnalysisRuns.id, runIds));
  if (runs.length !== runIds.length) throw new Error("요청한 deep run 중 운영 DB에 없는 항목이 있습니다.");

  const confirmedLinks = await db
    .select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    })
    .from(schema.dedupLinks)
    .where(eq(schema.dedupLinks.confirmed, true));
  const sourceArtifacts: PromotionSourceArtifact[] = [];
  const planItems: PromotionReleasePlanItem[] = [];
  const snapshots = new Map<string, Awaited<ReturnType<typeof loadPromotionGrantSnapshot>>>();

  for (const run of runs.sort((left, right) => left.grantId.localeCompare(right.grantId))) {
    if (
      run.status !== "passed"
      || run.modelPolicyVersion !== DEEP_ANALYSIS_MODEL_POLICY_VERSION
      || !run.outputArtifactKey
      || !run.completedAt
    ) {
      throw new Error(`승격 불가능한 deep run 상태입니다: ${run.id}/${run.status}`);
    }
    const [latestJob] = await db
      .select()
      .from(schema.grantDeepAnalysisJobs)
      .where(and(
        eq(schema.grantDeepAnalysisJobs.grantId, run.grantId),
        eq(schema.grantDeepAnalysisJobs.modelPolicyVersion, DEEP_ANALYSIS_MODEL_POLICY_VERSION),
      ))
      .orderBy(desc(schema.grantDeepAnalysisJobs.createdAt), desc(schema.grantDeepAnalysisJobs.id))
      .limit(1);
    if (
      !latestJob
      || latestJob.id !== run.jobId
      || latestJob.sourceRevisionSha256 !== run.sourceRevisionSha256
    ) {
      throw new Error(`current job/source revision과 일치하지 않는 deep run입니다: ${run.id}`);
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
    if (analysisReceipt?.status !== "passed") {
      throw new Error(`S11 analysis_complete receipt가 없습니다: ${run.id}`);
    }
    const [audit] = await db
      .select()
      .from(schema.grantDeepAnalysisAudits)
      .where(eq(schema.grantDeepAnalysisAudits.runId, run.id))
      .orderBy(desc(schema.grantDeepAnalysisAudits.attempt))
      .limit(1);
    if (!audit || audit.verdict !== "concur") {
      throw new Error(`독립 감사 concur가 아닙니다: ${run.id}`);
    }
    const seal = await prepareDeepAnalysisInput({
      db,
      storage,
      grantId: run.grantId,
      maxTotalChars: DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
    });
    if (
      !seal.sealed
      || seal.sourceRevisionSha256 !== run.sourceRevisionSha256
      || seal.inputSha256 !== run.inputSha256
    ) {
      throw new Error(`prepare 시점 source/input이 deep run과 달라 stale입니다: ${run.id}`);
    }
    const outputObject = await storage.getObjectBytes(run.outputArtifactKey);
    const output = parseDeepAnalysisNormalizedOutput(
      JSON.parse(outputObject.body.toString("utf8")) as unknown,
    );
    const currentCriteriaRows = await db
      .select()
      .from(schema.grantCriteria)
      .where(eq(schema.grantCriteria.grantId, run.grantId));
    const currentCriteria: LabCurrentCriterion[] = currentCriteriaRows.map((criterion) => ({
      dimension: criterion.dimension,
      kind: criterion.kind,
      operator: criterion.operator,
      value: criterion.value,
      confidence: criterion.confidence,
      needsReview: criterion.needsReview,
      sourceSpan: criterion.sourceSpan,
    }));
    const { plan } = buildDeepAnalysisPromotionPlan({
      run: {
        runId: run.runId,
        grantId: run.grantId,
        source: run.source,
        sourceId: run.sourceId,
        title: run.title,
        model: run.model,
        promptVersion: run.promptVersion,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        inputChars: run.inputChars,
        inputSha256: run.inputSha256,
        costUsd: run.costUsd === null ? null : Number(run.costUsd),
      },
      output,
      currentCriteria,
      audit: {
        model: audit.model,
        promptVersion: audit.promptVersion,
        completedAt: audit.completedAt,
        verdict: audit.verdict,
      },
    });
    const snapshot = await loadPromotionGrantSnapshot(db, run.grantId, confirmedLinks);
    snapshots.set(run.grantId, snapshot);
    const hashes = promotionGrantSnapshotHashes(snapshot);
    const sourceArtifact: PromotionSourceArtifact = {
      grantId: run.grantId,
      runId: run.runId,
      runSha256: sha256(outputObject.body),
      auditSha256: audit.artifactSha256,
      overlaySha256: null,
      confirmationsSha256: null,
      deepAnalysisRunId: run.id,
      sourceRevisionSha256: run.sourceRevisionSha256,
      inputSha256: run.inputSha256,
      outputArtifactKey: run.outputArtifactKey,
      auditArtifactKey: audit.artifactKey,
    };
    const sourceVerification = await verifyPromotionSourceArtifact(sourceArtifact);
    if (!sourceVerification.ok) {
      throw new Error(
        `deep source artifact 검증 실패 ${run.id}: ${sourceVerification.changed.join(", ")}`,
      );
    }
    sourceArtifacts.push(sourceArtifact);
    planItems.push({
      grantId: run.grantId,
      planSha256: planSha256(plan),
      promotionPlan: plan,
      beforeCriteriaSha256: hashes.criteriaSha256,
      beforeQuestionsSha256: hashes.questionsSha256,
      dedupComponentSha256: hashes.dedupComponentSha256,
      criteriaCountBefore: snapshot.criteria.length,
      criteriaCountAfter: plan.criteria.length,
      questionCountAfter: plan.questions.length,
      pendingCount: 0,
      downgradedCount: 0,
      costUsd: run.costUsd === null ? null : Number(run.costUsd),
    });
  }

  const now = new Date();
  const releaseId = readArg("releaseId")?.trim() || releaseIdFor(now, build.gitCommit);
  const requestedCanaries = [...new Set(
    (readArg("canary") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  )];
  const planGrantIds = new Set(planItems.map((item) => item.grantId));
  const canaryGrantIds = requestedCanaries.length > 0
    ? requestedCanaries
    : planItems.slice(0, Math.min(2, planItems.length)).map((item) => item.grantId);
  if (canaryGrantIds.some((grantId) => !planGrantIds.has(grantId))) {
    throw new Error("--canary가 deep release plan 밖의 공고를 포함합니다.");
  }
  const manifest = createPromotionReleaseManifest({
    releaseId,
    revision: 1,
    createdAt: now.toISOString(),
    gitCommit: build.gitCommit,
    buildDigest: build.buildDigest,
    cohortLabel: readArg("cohort")?.trim() || "deep-production-canary",
    canaryGrantIds,
    sourceArtifacts,
    plans: planItems,
  });
  await writeImmutablePromotionArtifact(
    promotionReleaseArtifactPath(releaseId, "manifest.json"),
    manifest,
  );
  await db.transaction(async (transaction) => {
    const [release] = await transaction
      .insert(schema.analysisLabPromotionReleases)
      .values({
        releaseId,
        revision: manifest.revision,
        manifestSha256: manifest.manifestSha256,
        releasePlanSha256: manifest.releasePlanSha256,
        manifest: manifest as unknown as Record<string, unknown>,
        gitCommit: manifest.gitCommit,
        buildDigest: manifest.buildDigest,
        status: "prepared",
        createdBy: actor,
      })
      .returning({ id: schema.analysisLabPromotionReleases.id });
    if (!release) throw new Error("deep release 원장 생성에 실패했습니다.");
    await transaction.insert(schema.analysisLabPromotionItems).values(
      manifest.plans.map((item) => {
        const source = manifest.sourceArtifacts.find((artifact) => artifact.grantId === item.grantId);
        const snapshot = snapshots.get(item.grantId);
        if (!source?.deepAnalysisRunId || !snapshot) {
          throw new Error(`deep release item provenance 누락: ${item.grantId}`);
        }
        return {
          releaseDbId: release.id,
          grantId: item.grantId,
          runId: item.promotionPlan.runId,
          deepAnalysisRunId: source.deepAnalysisRunId,
          planSha256: item.planSha256,
          beforeSnapshot: snapshot as unknown as Record<string, unknown>,
          beforeSha256: promotionGrantSnapshotStateSha256(snapshot),
          status: "prepared" as const,
        };
      }),
    );
  });
  console.log(JSON.stringify({
    schema: "deep-analysis-promotion-release-prepare-v1",
    verdict: "PASS",
    releaseId,
    manifestSha256: manifest.manifestSha256,
    releasePlanSha256: manifest.releasePlanSha256,
    grantIds: manifest.plans.map((item) => item.grantId),
    canaryGrantIds: manifest.canaryGrantIds,
  }, null, 2));
  return 0;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

prepare()
  .then(async (code) => {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(
      "[deep-release] 실패:",
      error instanceof Error ? error.message : error,
    );
    try {
      const { closeCunoteDb } = await import("../db/client");
      await closeCunoteDb();
    } catch {
      // 원래 오류를 보존한다.
    }
    process.exit(1);
  });
