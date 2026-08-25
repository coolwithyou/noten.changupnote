// 일반 release:
//   pnpm deep-analysis:release -- --run=<db-run-uuid,...> --actor=<creator>
// 통합공고 child release(case 전체 gate, 개별 --run 우회 불가):
//   pnpm deep-analysis:release -- --aggregate-split-case=<case-uuid> --actor=<creator>
import { createHash } from "node:crypto";
import {
  AGGREGATE_SPLIT_RELEASE_STAGE_KEYS,
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  evaluateAggregateSplitReleaseGate,
  type AggregateSplitReleaseCaseObservation,
  type DeepAnalysisStageKey,
} from "@cunote/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { LabCurrentCriterion } from "@/lib/server/analysis-lab/lab-contract";
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
import { verifyPromotionReleaseSources } from "../analysis-lab/promotion-candidates";
import { readPromotionBuildProvenance } from "../analysis-lab/promotion-build-provenance";
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

function releaseIdFor(now: Date, commit: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `deep-production-r1-${stamp}-${commit.slice(0, 8)}`;
}

async function loadAggregateSplitReleaseContext(
  db: ReturnType<typeof getCunoteDb>,
  caseId: string,
): Promise<{
  caseId: string;
  parentGrantId: string;
  childIds: string[];
  observation: AggregateSplitReleaseCaseObservation;
}> {
  const [splitCase] = await db
    .select()
    .from(schema.grantAggregateSplitCases)
    .where(eq(schema.grantAggregateSplitCases.id, caseId))
    .limit(1);
  if (!splitCase) throw new Error(`통합공고 분리 case가 없습니다: ${caseId}`);
  const [parent] = await db
    .select({ servingState: schema.grants.servingState })
    .from(schema.grants)
    .where(eq(schema.grants.id, splitCase.grantId))
    .limit(1);
  const children = await db
    .select()
    .from(schema.grantAggregateSplitChildren)
    .where(eq(schema.grantAggregateSplitChildren.splitCaseId, caseId))
    .orderBy(schema.grantAggregateSplitChildren.ordinal);
  const childIds = children.map((child) => child.id);
  const jobIds = children.flatMap(
    (child) => child.deepAnalysisJobId ? [child.deepAnalysisJobId] : [],
  );
  const [childGrants, jobs, runRows] = await Promise.all([
    childIds.length > 0
      ? db
        .select({
          id: schema.grants.id,
          servingState: schema.grants.servingState,
        })
        .from(schema.grants)
        .where(inArray(schema.grants.id, childIds))
      : [],
    jobIds.length > 0
      ? db
        .select()
        .from(schema.grantDeepAnalysisJobs)
        .where(inArray(schema.grantDeepAnalysisJobs.id, jobIds))
      : [],
    jobIds.length > 0
      ? db
        .select()
        .from(schema.grantDeepAnalysisRuns)
        .where(inArray(schema.grantDeepAnalysisRuns.jobId, jobIds))
        .orderBy(
          desc(schema.grantDeepAnalysisRuns.startedAt),
          desc(schema.grantDeepAnalysisRuns.id),
        )
      : [],
  ]);
  const grantById = new Map(childGrants.map((grant) => [grant.id, grant]));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const latestRunByJobId = new Map<string, (typeof runRows)[number]>();
  for (const run of runRows) {
    if (!latestRunByJobId.has(run.jobId)) latestRunByJobId.set(run.jobId, run);
  }
  const latestRuns = [...latestRunByJobId.values()];
  const latestRunIds = latestRuns.map((run) => run.id);
  const [receiptRows, auditRows] = await Promise.all([
    latestRunIds.length > 0
      ? db
        .select({
          id: schema.grantDeepAnalysisStageReceipts.id,
          runId: schema.grantDeepAnalysisStageReceipts.runId,
          stage: schema.grantDeepAnalysisStageReceipts.stage,
          status: schema.grantDeepAnalysisStageReceipts.status,
          attempt: schema.grantDeepAnalysisStageReceipts.attempt,
          createdAt: schema.grantDeepAnalysisStageReceipts.createdAt,
        })
        .from(schema.grantDeepAnalysisStageReceipts)
        .where(and(
          inArray(schema.grantDeepAnalysisStageReceipts.runId, latestRunIds),
          inArray(
            schema.grantDeepAnalysisStageReceipts.stage,
            [...AGGREGATE_SPLIT_RELEASE_STAGE_KEYS],
          ),
        ))
        .orderBy(
          desc(schema.grantDeepAnalysisStageReceipts.attempt),
          desc(schema.grantDeepAnalysisStageReceipts.createdAt),
          desc(schema.grantDeepAnalysisStageReceipts.id),
        )
      : [],
    latestRunIds.length > 0
      ? db
        .select({
          id: schema.grantDeepAnalysisAudits.id,
          runId: schema.grantDeepAnalysisAudits.runId,
          inputSha256: schema.grantDeepAnalysisAudits.inputSha256,
          verdict: schema.grantDeepAnalysisAudits.verdict,
          attempt: schema.grantDeepAnalysisAudits.attempt,
          completedAt: schema.grantDeepAnalysisAudits.completedAt,
        })
        .from(schema.grantDeepAnalysisAudits)
        .where(inArray(schema.grantDeepAnalysisAudits.runId, latestRunIds))
        .orderBy(
          desc(schema.grantDeepAnalysisAudits.attempt),
          desc(schema.grantDeepAnalysisAudits.completedAt),
          desc(schema.grantDeepAnalysisAudits.id),
        )
      : [],
  ]);
  const statusesByRunId = new Map<
    string,
    Partial<Record<DeepAnalysisStageKey, string>>
  >();
  for (const receipt of receiptRows) {
    const statuses = statusesByRunId.get(receipt.runId) ?? {};
    const stage = receipt.stage as DeepAnalysisStageKey;
    if (statuses[stage] === undefined) statuses[stage] = receipt.status;
    statusesByRunId.set(receipt.runId, statuses);
  }
  const latestAuditByRunId = new Map<string, (typeof auditRows)[number]>();
  for (const audit of auditRows) {
    if (!latestAuditByRunId.has(audit.runId)) latestAuditByRunId.set(audit.runId, audit);
  }
  const observations: AggregateSplitReleaseCaseObservation["children"] = children.map(
    (child) => {
      const grant = grantById.get(child.id);
      const job = child.deepAnalysisJobId
        ? jobById.get(child.deepAnalysisJobId)
        : undefined;
      const latestRun = job ? latestRunByJobId.get(job.id) : undefined;
      const audit = latestRun ? latestAuditByRunId.get(latestRun.id) : undefined;
      return {
        childId: child.id,
        childStatus: child.status,
        sourceRevisionSha256: child.sourceRevisionSha256,
        inputSha256: child.inputSha256,
        stagedGrantAt: child.stagedGrantAt,
        servingState: grant?.servingState ?? null,
        expectedJobId: child.deepAnalysisJobId,
        job: job
          ? {
            id: job.id,
            grantId: job.grantId,
            sourceRevisionSha256: job.sourceRevisionSha256,
            modelPolicyVersion: job.modelPolicyVersion,
            status: job.status,
          }
          : null,
        latestRun: latestRun
          ? {
            id: latestRun.id,
            jobId: latestRun.jobId,
            grantId: latestRun.grantId,
            sourceRevisionSha256: latestRun.sourceRevisionSha256,
            inputSha256: latestRun.inputSha256,
            modelPolicyVersion: latestRun.modelPolicyVersion,
            status: latestRun.status,
          }
          : null,
        stageStatuses: latestRun
          ? statusesByRunId.get(latestRun.id) ?? {}
          : {},
        latestAudit: audit
          ? {
            inputSha256: audit.inputSha256,
            verdict: audit.verdict,
          }
          : null,
      };
    },
  );
  return {
    caseId,
    parentGrantId: splitCase.grantId,
    childIds,
    observation: {
      status: splitCase.status,
      materializationStatus: splitCase.materializationStatus,
      promotionStatus: splitCase.promotionStatus,
      parentServingState: parent?.servingState ?? null,
      programCount: splitCase.programCount,
      preparedChildCount: splitCase.preparedChildCount,
      stagedChildCount: splitCase.stagedChildCount,
      enqueuedChildCount: splitCase.enqueuedChildCount,
      children: observations,
    },
  };
}

async function prepare(): Promise<number> {
  const actor = readArg("actor")?.trim();
  const aggregateSplitCaseId = readArg("aggregate-split-case")?.trim();
  let runIds = [...new Set(
    (readArg("run") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  )];
  if (!actor) throw new Error("--actor가 필요합니다.");
  if (aggregateSplitCaseId && runIds.length > 0) {
    throw new Error("--aggregate-split-case와 --run은 함께 사용할 수 없습니다.");
  }
  if (!aggregateSplitCaseId && runIds.length === 0) {
    throw new Error("--run 또는 --aggregate-split-case가 필요합니다.");
  }
  if (aggregateSplitCaseId && !isUuid(aggregateSplitCaseId)) {
    throw new Error("--aggregate-split-case는 UUID여야 합니다.");
  }
  if (runIds.some((value) => !isUuid(value))) throw new Error("--run은 UUID CSV여야 합니다.");
  const build = readPromotionBuildProvenance();
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 환경변수가 필요합니다.");
  const aggregateContext = aggregateSplitCaseId
    ? await loadAggregateSplitReleaseContext(db, aggregateSplitCaseId)
    : null;
  if (aggregateContext) {
    const gate = evaluateAggregateSplitReleaseGate(aggregateContext.observation);
    if (!gate.ready) {
      const childFailures = gate.children
        .filter((child) => child.firstBlocker)
        .map((child) => `${child.childId}:${child.firstBlocker!.code}`)
        .join(", ");
      throw new Error(
        `통합공고 staged publication gate 실패: ${
          gate.firstBlocker?.code ?? "unknown"
        }${childFailures ? ` (${childFailures})` : ""}`,
      );
    }
    runIds = gate.children.map((child) => child.runId!);
  }
  const runs = await db
    .select({
      id: schema.grantDeepAnalysisRuns.id,
      runId: schema.grantDeepAnalysisRuns.runId,
      jobId: schema.grantDeepAnalysisRuns.jobId,
      grantId: schema.grantDeepAnalysisRuns.grantId,
      sourceRevisionSha256: schema.grantDeepAnalysisRuns.sourceRevisionSha256,
      inputSha256: schema.grantDeepAnalysisRuns.inputSha256,
      attachmentManifestSha256: schema.grantDeepAnalysisRuns.attachmentManifestSha256,
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
  const aggregateChildrenInRequestedRuns = await db
    .select({
      id: schema.grantAggregateSplitChildren.id,
      splitCaseId: schema.grantAggregateSplitChildren.splitCaseId,
    })
    .from(schema.grantAggregateSplitChildren)
    .where(inArray(
      schema.grantAggregateSplitChildren.id,
      runs.map((run) => run.grantId),
    ));
  if (!aggregateContext && aggregateChildrenInRequestedRuns.length > 0) {
    throw new Error(
      "통합공고 child는 --run으로 개별 release할 수 없습니다. --aggregate-split-case로 case 전체를 검증하세요.",
    );
  }
  if (
    aggregateContext
    && (
      aggregateChildrenInRequestedRuns.length !== aggregateContext.childIds.length
      || aggregateChildrenInRequestedRuns.some(
        (child) => child.splitCaseId !== aggregateContext.caseId,
      )
    )
  ) {
    throw new Error("통합공고 release run 집합이 case의 전체 child 집합과 다릅니다.");
  }

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
    if (
      !audit
      || (audit.verdict !== "concur" && audit.verdict !== "unsure")
    ) {
      throw new Error(`승격 가능한 독립 감사 결과가 아닙니다: ${run.id}`);
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
    const { plan, readiness } = buildDeepAnalysisPromotionPlan({
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
        sourceRevisionSha256: run.sourceRevisionSha256,
        attachmentManifestSha256: run.attachmentManifestSha256,
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
      auditVerdict: audit.verdict,
    };
    const sourceDrift = await verifyPromotionReleaseSources([sourceArtifact]);
    if (sourceDrift.length > 0) {
      throw new Error(
        `deep source artifact 검증 실패 ${run.id}: ${sourceDrift.join(", ")}`,
      );
    }
    sourceArtifacts.push(sourceArtifact);
    planItems.push({
      grantId: run.grantId,
      planSha256: planSha256(plan),
      promotionPlan: plan,
      deepAnalysisReadiness: readiness,
      deepAnalysisConditionalOnlyCriteria: plan.criteria.flatMap(
        (criterion, position) => criterion.needs_review === true ? [position] : [],
      ),
      beforeCriteriaSha256: hashes.criteriaSha256,
      beforeQuestionsSha256: hashes.questionsSha256,
      dedupComponentSha256: hashes.dedupComponentSha256,
      criteriaCountBefore: snapshot.criteria.length,
      criteriaCountAfter: plan.criteria.length,
      questionCountAfter: plan.questions.length,
      pendingCount: plan.resolutions.filter(
        (resolution) => resolution.state === "pending",
      ).length,
      downgradedCount: 0,
      transport: "api",
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
    cohortLabel: readArg("cohort")?.trim()
      || (aggregateContext
        ? `aggregate-split:${aggregateContext.caseId}`
        : "deep-production-canary"),
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
        gateSummary: aggregateContext
          ? {
            schema: "aggregate-split-publication-gate-v1",
            verdict: "PASS",
            splitCaseId: aggregateContext.caseId,
            parentGrantId: aggregateContext.parentGrantId,
            parentServingState: aggregateContext.observation.parentServingState,
            childCount: aggregateContext.childIds.length,
            sourceInputResealed: true,
            children: manifest.sourceArtifacts.map((source) => ({
              grantId: source.grantId,
              deepAnalysisRunId: source.deepAnalysisRunId,
              sourceRevisionSha256: source.sourceRevisionSha256,
              inputSha256: source.inputSha256,
            })),
          }
          : null,
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
    aggregateSplitCaseId: aggregateContext?.caseId ?? null,
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
