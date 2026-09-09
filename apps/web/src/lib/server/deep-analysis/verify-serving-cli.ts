import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
  type CompanyProfile,
  type GrantCriterion,
  type NormalizedGrant,
} from "@cunote/contracts";
import { and, eq, inArray, max } from "drizzle-orm";
import {
  createDrizzleRepositories,
  withPromotionServingReadSnapshot,
} from "../repositories/drizzle";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  sha256Canonical,
  validatePromotionReleaseManifest,
} from "../analysis-serving/promotionReleaseContract";
import {
  resolvePromotionServingEvidence,
  type PromotionServingLedgerItem,
} from "../analysis-lab/promotion-serving";
import type { ConfirmedGrantLinkSnapshot } from "../ingestion/grantRevisionInvalidation";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
  type PromotionCriterionSnapshot,
  type PromotionGrantSnapshot,
} from "../analysis-lab/promotion-snapshot";
import { verifyAppliedPromotionSnapshot } from "../analysis-lab/verify-promotion";
import { buildGrantAnalysisShadowMatch } from "../ingestion/grantAnalysisPilotVariants";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { appendVerifiedDeepAnalysisStageReceipt } from "./receipts";
import { prepareDeepAnalysisInput } from "./prepareInput";
import {
  canonicalServingProjection,
  classifyLocalOperationalInputState,
  evaluateActiveServingMonitor,
  runActiveServingMonitorTargets,
  serializeActiveServingMonitorItemLog,
  summarizeActiveServingMonitorEvaluation,
  type ActiveServingMonitorStageResult,
  type ActiveServingMonitorTarget,
  type ActiveServingMonitorTargetResult,
} from "./servingMonitor";
import {
  loadActiveServingMonitorInventory,
  type LoadedActiveServingMonitorBinding,
} from "./servingMonitorInventory";

loadMonorepoEnv();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

export function assertServingVerificationTargets(
  items: ReadonlyArray<PromotionServingLedgerItem & { status: string }>,
): void {
  if (items.some((item) => item.status !== "applied")) {
    throw new Error("applied promotion item만 serving 검증할 수 있습니다.");
  }
  if (items.some((item) => !resolvePromotionServingEvidence(item))) {
    throw new Error("서빙 가능한 production deep run 또는 verified local lab provenance가 필요합니다.");
  }
}

async function main(): Promise<number> {
  const releaseId = readArg("release")?.trim();
  const scope = readArg("scope")?.trim();
  const active = process.argv.includes("--active");
  const publicationOnly = process.argv.includes("--publication-only");
  if (active === Boolean(releaseId)) {
    throw new Error("--active 또는 --release 중 하나만 필요합니다.");
  }
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 환경변수가 필요합니다.");

  if (active) {
    if (publicationOnly) {
      throw new Error("--publication-only는 특정 --release 검증에만 사용할 수 있습니다.");
    }
    if (scope) throw new Error("--active는 --scope를 받지 않고 active release 전체를 검증합니다.");
    const cloudRunExecution = process.env.CLOUD_RUN_EXECUTION?.trim() || null;
    const monitorExecutionId = cloudRunExecution
      || `local-${new Date().toISOString()}-${process.pid}`;
    const startedAtMs = Date.now();
    let peakRssBytes = process.memoryUsage().rss;
    const asOf = new Date();
    const before = await loadActiveServingMonitorInventory({ db, asOf });
    const results = await runActiveServingMonitorTargets(
      before.plan.targets,
      async (target) => {
        try {
          return await verifyActiveServingTarget({
            db,
            storage,
            target,
            monitorExecutionId,
            monitorRuntime: cloudRunExecution ? "cloud_run" : "local",
          });
        } finally {
          peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        }
      },
      (result, index) => {
        console.log(serializeActiveServingMonitorItemLog({
          monitorExecutionId,
          index,
          total: before.plan.targets.length,
          result,
        }));
      },
    );
    const after = await loadActiveServingMonitorInventory({ db, asOf });
    const evaluation = evaluateActiveServingMonitor({
      plan: before.plan,
      results,
      inventoryStable: before.inventorySha256 === after.inventorySha256,
    });
    const summary = summarizeActiveServingMonitorEvaluation(evaluation);
    console.log(JSON.stringify({
      ...summary,
      monitorExecutionId,
      monitorRuntime: cloudRunExecution ? "cloud_run" : "local",
      asOf: asOf.toISOString(),
      inventoryBeforeSha256: before.inventorySha256,
      inventoryAfterSha256: after.inventorySha256,
      inventoryMetrics: before.metrics,
      postInventoryMetrics: after.metrics,
      elapsedMs: Date.now() - startedAtMs,
      sampledPeakRssBytes: peakRssBytes,
      maxRssBytes: process.resourceUsage().maxRSS * 1_024,
    }));
    return evaluation.verdict === "PASS" ? 0 : 2;
  }

  if (scope !== "canary" && scope !== "all") {
    throw new Error("--scope는 canary 또는 all이어야 합니다.");
  }
  const result = await verifyDeepAnalysisReleaseServing({
    db,
    storage,
    releaseId: releaseId!,
    scope,
    observationMode: "release_verification",
    verificationMode: publicationOnly ? "publication_only" : "full",
    monitorExecutionId: null,
    monitorRuntime: "local",
  });
  console.log(JSON.stringify(result, null, 2));
  return result.failures.length === 0 ? 0 : 2;
}

export interface VerifyActiveServingTargetInput {
  db: ReturnType<typeof getCunoteDb>;
  storage: NonNullable<ReturnType<typeof createR2ObjectStorageFromEnv>>;
  target: ActiveServingMonitorTarget<
    NormalizedGrant,
    LoadedActiveServingMonitorBinding
  >;
  /** @deprecated Active verification always reloads this component inside its own RR snapshot. */
  confirmedLinks?: ConfirmedGrantLinkSnapshot[];
  monitorExecutionId: string;
  monitorRuntime: "cloud_run" | "local";
}

export async function verifyActiveServingTarget(
  input: VerifyActiveServingTargetInput,
): Promise<ActiveServingMonitorTargetResult> {
  const { binding, entry } = input.target;
  const notReached = (): ActiveServingMonitorStageResult => ({
    status: "not_reached",
    issues: [],
  });
  const result = (overrides: {
    publication: ActiveServingMonitorStageResult;
    serving?: ActiveServingMonitorStageResult;
    freshness?: ActiveServingMonitorStageResult;
  }): ActiveServingMonitorTargetResult => {
    const publication = overrides.publication;
    const serving = overrides.serving ?? notReached();
    const freshness = overrides.freshness ?? notReached();
    return {
      promotionItemId: binding.promotionItemId,
      grantId: binding.grantId,
      releaseId: binding.releaseId,
      evidenceKind: binding.evidenceKind,
      verdict: [publication, serving, freshness].every((stage) => stage.status === "passed")
        ? "PASS"
        : "FAIL",
      publication,
      serving,
      freshness,
    };
  };

  let manifest: ReturnType<typeof validatePromotionReleaseManifest>;
  let sourceArtifact: ReturnType<typeof validatePromotionReleaseManifest>["sourceArtifacts"][number];
  let currentSnapshot: PromotionGrantSnapshot;
  let verifiedSourceRevisionSha256: string;
  let publication: ActiveServingMonitorStageResult;
  try {
    manifest = validatePromotionReleaseManifest(binding.manifest);
    const planItem = manifest.plans.find((item) => item.grantId === binding.grantId);
    const foundSourceArtifact = manifest.sourceArtifacts.find(
      (artifact) => artifact.grantId === binding.grantId,
    );
    const resolvedEvidence = resolvePromotionServingEvidence({
      grantId: binding.grantId,
      runId: binding.runId,
      planSha256: binding.planSha256,
      deepAnalysisRunId: binding.deepAnalysisRunId,
      releaseManifestSha256: binding.releaseManifestSha256,
      manifest: binding.manifest,
    });
    const bindingIssues: string[] = [];
    if (
      manifest.releaseId !== binding.releaseId
      || manifest.manifestSha256 !== binding.releaseManifestSha256
      || manifest.releasePlanSha256 !== binding.releasePlanSha256
    ) bindingIssues.push("release ledger와 embedded manifest 결속이 다릅니다.");
    if (binding.release.status !== binding.releaseStatus) {
      bindingIssues.push("inventory release status 결속이 다릅니다.");
    }
    if (binding.item.status !== "applied") bindingIssues.push("promotion item이 applied가 아닙니다.");
    if (!binding.item.afterSha256) bindingIssues.push("promotion after hash가 없습니다.");
    if (!planItem || planItem.planSha256 !== binding.planSha256) {
      bindingIssues.push("promotion plan 결속이 다릅니다.");
    }
    if (!foundSourceArtifact || foundSourceArtifact.runId !== binding.runId) {
      bindingIssues.push("promotion source artifact 결속이 다릅니다.");
    }
    if (!resolvedEvidence || resolvedEvidence.kind !== binding.evidenceKind) {
      bindingIssues.push("promotion serving provenance 결속이 다릅니다.");
    }
    if (
      binding.releaseStatus === "canary_passed"
      && !manifest.canaryGrantIds.includes(binding.grantId)
    ) bindingIssues.push("canary_passed release의 applied item이 canary 집합 밖입니다.");
    if (binding.deepAnalysisRunId) {
      if (
        !binding.run
        || binding.run.id !== binding.deepAnalysisRunId
        || binding.run.grantId !== binding.grantId
        || binding.run.runId !== binding.runId
      ) bindingIssues.push("production deep run 결속이 다릅니다.");
      if (binding.run && binding.run.status !== "passed") {
        bindingIssues.push(`production deep run이 passed가 아닙니다: ${binding.run.status}`);
      }
    } else if (binding.run) {
      bindingIssues.push("local serving item에 production run이 결속됐습니다.");
    }
    if (bindingIssues.length > 0 || !planItem || !foundSourceArtifact || !resolvedEvidence) {
      publication = { status: "failed", issues: bindingIssues };
      return result({ publication });
    }
    sourceArtifact = foundSourceArtifact;
    verifiedSourceRevisionSha256 = binding.run?.sourceRevisionSha256
      ?? sourceArtifact.sourceRevisionSha256
      ?? "";
    if (!verifiedSourceRevisionSha256) {
      publication = {
        status: "failed",
        issues: ["serving source revision 결속이 없습니다."],
      };
      return result({ publication });
    }
    currentSnapshot = await withPromotionServingReadSnapshot(
      input.db,
      (session) => loadPromotionGrantSnapshot(session, binding.grantId),
    );
    const publicationIssues = verifyAppliedPromotionSnapshot({
      grantId: binding.grantId,
      planStableKeys: planItem.promotionPlan.criterionStableKeys,
      plannedQuestions: planItem.promotionPlan.questions,
      beforeSnapshot: binding.item.beforeSnapshot as unknown as PromotionGrantSnapshot,
      currentSnapshot,
      expectedStateSha256: binding.item.afterSha256!,
    }).map((issue) => `${issue.code}:${issue.detail}`);
    const evidence = {
      schema: "deep-analysis-active-serving-item-evidence-v1",
      releaseId: binding.releaseId,
      observationMode: "active_monitor",
      verificationMode: "canonical_serving",
      monitorExecutionId: input.monitorExecutionId,
      monitorRuntime: input.monitorRuntime,
      releaseDbId: binding.releaseDbId,
      promotionItemId: binding.promotionItemId,
      planSha256: binding.planSha256,
      expectedAfterSha256: binding.item.afterSha256,
      actualAfterSha256: promotionGrantSnapshotStateSha256(currentSnapshot),
      issueCount: publicationIssues.length,
      issues: publicationIssues,
    };
    if (binding.run) {
      await appendNextReceipt({
        db: input.db,
        storage: input.storage,
        run: binding.run,
        stage: "publication_complete",
        status: publicationIssues.length === 0 ? "passed" : "failed",
        evidence,
      });
    }
    publication = {
      status: publicationIssues.length === 0 ? "passed" : "failed",
      issues: publicationIssues,
      evidence,
    };
    if (publication.status !== "passed") return result({ publication });
  } catch (error) {
    publication = {
      status: "error",
      issues: [error instanceof Error ? error.message : String(error)],
    };
    return result({ publication });
  }

  let serving: ActiveServingMonitorStageResult;
  try {
    const projection = canonicalServingProjection(
      currentSnapshot.criteria as unknown as Array<Record<string, unknown>>,
      entry.criteria,
    );
    const expectedCriterionIds = currentSnapshot.criteria.map((criterion) => criterion.id).sort();
    const traceRows = FIXED_SERVING_PROFILES.map(({ id, profile }) => {
      const match = buildGrantAnalysisShadowMatch({
        entry,
        criteria: entry.criteria,
        company: profile,
        asOf: new Date(manifest.createdAt),
      });
      return {
        profileId: id,
        eligibility: match.eligibility,
        tier: match.review_gate?.tier ?? null,
        score: match.fit_score,
        ruleTrace: match.rule_trace,
      };
    });
    const servingIssues = [...projection.issues];
    for (const trace of traceRows) {
      const traceCriterionIds = trace.ruleTrace
        .map((row) => row.criterion_id)
        .filter((value): value is string => typeof value === "string")
        .sort();
      if (
        traceCriterionIds.length !== expectedCriterionIds.length
        || traceCriterionIds.some((value, index) => value !== expectedCriterionIds[index])
      ) servingIssues.push(`${trace.profileId} matcher rule_trace criterion ID 집합 불일치`);
    }
    const evidence = {
      schema: "deep-analysis-active-serving-item-evidence-v1",
      releaseId: binding.releaseId,
      observationMode: "active_monitor",
      verificationMode: "canonical_serving",
      monitorExecutionId: input.monitorExecutionId,
      monitorRuntime: input.monitorRuntime,
      promotionItemId: binding.promotionItemId,
      repository: "drizzle-canonical-active-grant-repository",
      matcher: "buildGrantAnalysisShadowMatch/matchNormalizedGrant",
      profileCorpus: FIXED_SERVING_PROFILES.map((profile) => profile.id),
      snapshotCriteriaSha256: projection.snapshotCriteriaSha256,
      repositoryCriteriaSha256: projection.repositoryCriteriaSha256,
      traceSha256: sha256Canonical(traceRows),
      issueCount: servingIssues.length,
      issues: servingIssues,
    };
    if (binding.run) {
      await appendNextReceipt({
        db: input.db,
        storage: input.storage,
        run: binding.run,
        stage: "serving_complete",
        status: servingIssues.length === 0 ? "passed" : "failed",
        evidence,
      });
    }
    serving = {
      status: servingIssues.length === 0 ? "passed" : "failed",
      issues: servingIssues,
      evidence,
    };
    if (serving.status !== "passed") return result({ publication, serving });
  } catch (error) {
    serving = {
      status: "error",
      issues: [error instanceof Error ? error.message : String(error)],
    };
    return result({ publication, serving });
  }

  let freshness: ActiveServingMonitorStageResult;
  try {
    const currentInput = await prepareDeepAnalysisInput({
      db: input.db,
      storage: input.storage,
      grantId: binding.grantId,
      maxTotalChars: DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
    });
    const freshnessIssues: string[] = [];
    const localOperationalState = binding.run
      ? null
      : classifyLocalOperationalInputState(currentInput);
    if (binding.run && !currentInput.sealed) {
      freshnessIssues.push("current input이 sealed가 아닙니다.");
    }
    if (currentInput.sourceRevisionSha256 !== verifiedSourceRevisionSha256) {
      freshnessIssues.push("current source revision이 serving source와 다릅니다.");
    }
    if (binding.run && currentInput.inputSha256 !== binding.run.inputSha256) {
      freshnessIssues.push("current input hash가 production serving run과 다릅니다.");
    }
    for (const materialIssue of localOperationalState?.materialIssues ?? []) {
      freshnessIssues.push(
        `current operational artifact verification failed (${materialIssue.code}:${materialIssue.attachmentId ?? "unknown"}).`,
      );
    }
    const evidence = {
      schema: "deep-analysis-active-serving-item-evidence-v1",
      releaseId: binding.releaseId,
      observationMode: "active_monitor",
      verificationMode: "canonical_serving",
      monitorExecutionId: input.monitorExecutionId,
      monitorRuntime: input.monitorRuntime,
      promotionItemId: binding.promotionItemId,
      servingEvidenceKind: binding.evidenceKind,
      servingSourceRevisionSha256: verifiedSourceRevisionSha256,
      currentSourceRevisionSha256: currentInput.sourceRevisionSha256,
      productionRunInputSha256: binding.run?.inputSha256 ?? null,
      currentInputSha256: binding.run ? currentInput.inputSha256 : "not_compared_for_local_lab",
      currentInputSealed: currentInput.sealed,
      freshnessProofScope: binding.run ? "production_input_exact" : "current_source_binding",
      localLabIndependentReviewReplayed: false,
      externalSourceAvailabilityFullyVerified: false,
      operationalReadinessBlockerCount: localOperationalState?.readinessBlockers.length ?? 0,
      operationalReadinessBlockerCodes: localOperationalState
        ? [...new Set(localOperationalState.readinessBlockers.map((blocker) => blocker.code))].sort()
        : [],
      operationalMaterialIssueCount: localOperationalState?.materialIssues.length ?? 0,
      operationalMaterialIssueCodes: localOperationalState
        ? [...new Set(localOperationalState.materialIssues.map((issue) => issue.code))].sort()
        : [],
      issueCount: freshnessIssues.length,
      issues: freshnessIssues,
    };
    if (binding.run) {
      await appendNextReceipt({
        db: input.db,
        storage: input.storage,
        run: binding.run,
        stage: "analysis_fresh",
        status: freshnessIssues.length === 0 ? "passed" : "stale",
        evidence,
      });
    }
    freshness = {
      status: freshnessIssues.length === 0 ? "passed" : "failed",
      issues: freshnessIssues,
      evidence,
    };
    return result({ publication, serving, freshness });
  } catch (error) {
    freshness = {
      status: "error",
      issues: [error instanceof Error ? error.message : String(error)],
    };
    return result({ publication, serving, freshness });
  }
}

export async function verifyDeepAnalysisReleaseServing(input: {
  db: ReturnType<typeof getCunoteDb>;
  storage: NonNullable<ReturnType<typeof createR2ObjectStorageFromEnv>>;
  releaseId: string;
  scope: "canary" | "all";
  observationMode: "release_verification" | "active_monitor";
  verificationMode: "publication_only" | "full";
  monitorExecutionId: string | null;
  monitorRuntime: "cloud_run" | "local";
}) {
  const {
    db,
    storage,
    releaseId,
    scope,
    observationMode,
    verificationMode,
    monitorExecutionId,
    monitorRuntime,
  } = input;
  const [release] = await db
    .select()
    .from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId))
    .limit(1);
  if (!release) throw new Error("promotion release 원장이 없습니다.");
  const manifest = validatePromotionReleaseManifest(release.manifest);
  if (
    manifest.releaseId !== releaseId
    || manifest.manifestSha256 !== release.manifestSha256
    || manifest.releasePlanSha256 !== release.releasePlanSha256
  ) {
    throw new Error("DB release 원장과 embedded manifest hash가 일치하지 않습니다.");
  }
  const expectedReleaseStatus = scope === "canary" ? "canary_passed" : "active";
  if (release.status !== expectedReleaseStatus) {
    throw new Error(`release 상태가 ${expectedReleaseStatus}가 아닙니다: ${release.status}`);
  }
  const itemRows = await db
    .select()
    .from(schema.analysisLabPromotionItems)
    .where(eq(schema.analysisLabPromotionItems.releaseDbId, release.id));
  const targetGrantIds = scope === "canary"
    ? manifest.canaryGrantIds
    : manifest.plans.map((item) => item.grantId);
  const targets = itemRows.filter((item) => targetGrantIds.includes(item.grantId));
  if (targets.length !== targetGrantIds.length) throw new Error("serving 검증 대상 item이 누락됐습니다.");
  assertServingVerificationTargets(targets.map((item) => ({
    grantId: item.grantId,
    runId: item.runId,
    planSha256: item.planSha256,
    deepAnalysisRunId: item.deepAnalysisRunId,
    releaseManifestSha256: release.manifestSha256,
    manifest: release.manifest,
    status: item.status,
  })));
  const grantStateRows = await db
    .select({
      id: schema.grants.id,
      servingState: schema.grants.servingState,
    })
    .from(schema.grants)
    .where(inArray(schema.grants.id, targetGrantIds));
  const servingStateByGrantId = new Map(
    grantStateRows.map((grant) => [grant.id, grant.servingState]),
  );
  const invisibleGrantIds = targetGrantIds.filter(
    (grantId) => servingStateByGrantId.get(grantId) !== "visible",
  );
  if (observationMode === "active_monitor" && invisibleGrantIds.length > 0) {
    return {
      schema: "deep-analysis-serving-verification-v1",
      verdict: "SKIPPED_NOT_VISIBLE",
      releaseId,
      scope,
      verificationMode,
      checked: 0,
      skipped: invisibleGrantIds.length,
      passed: [],
      failures: [],
    };
  }

  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const entries = verificationMode === "full"
    ? await repositories.grants.listGrantsByIds(targetGrantIds)
    : [];
  const entryByGrant = new Map(
    entries.flatMap((entry) => entry.grant.id ? [[entry.grant.id, entry] as const] : []),
  );
  const confirmedLinks = await db
    .select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    })
    .from(schema.dedupLinks)
    .where(eq(schema.dedupLinks.confirmed, true));
  const planByGrant = new Map(manifest.plans.map((item) => [item.grantId, item]));
  const sourceArtifactByGrant = new Map(
    manifest.sourceArtifacts.map((artifact) => [artifact.grantId, artifact]),
  );
  const failures: Array<{ grantId: string; stage: string; issues: string[] }> = [];
  const passed: Array<{
    grantId: string;
    runId: string;
    afterSha256: string;
    repositoryCriteriaSha256: string;
    traceSha256: string;
    sourceRevisionSha256: string;
    verificationMode: "publication_only" | "full";
  }> = [];

  for (const item of targets) {
    const planItem = planByGrant.get(item.grantId);
    const sourceArtifact = sourceArtifactByGrant.get(item.grantId);
    const entry = entryByGrant.get(item.grantId);
    const servingEvidence = resolvePromotionServingEvidence({
      grantId: item.grantId,
      runId: item.runId,
      planSha256: item.planSha256,
      deepAnalysisRunId: item.deepAnalysisRunId,
      releaseManifestSha256: release.manifestSha256,
      manifest: release.manifest,
    });
    const [run] = item.deepAnalysisRunId
      ? await db
        .select()
        .from(schema.grantDeepAnalysisRuns)
        .where(eq(schema.grantDeepAnalysisRuns.id, item.deepAnalysisRunId))
        .limit(1)
      : [];
    const localEvidence = servingEvidence?.kind === "verified_local_lab"
      ? servingEvidence.evidence
      : null;
    const verifiedSourceRevisionSha256 = run?.sourceRevisionSha256
      ?? sourceArtifact?.sourceRevisionSha256
      ?? null;
    if (
      !planItem
      || !item.afterSha256
      || !verifiedSourceRevisionSha256
      || (!run && (!localEvidence || !sourceArtifact))
    ) {
      failures.push({
        grantId: item.grantId,
        stage: "publication_complete",
        issues: ["promotion plan, 서빙 provenance 또는 after hash 누락"],
      });
      continue;
    }
    const appendProductionReceipt = async (input: {
      stage: "publication_complete" | "serving_complete" | "analysis_fresh";
      status: "passed" | "failed" | "stale";
      evidence: Record<string, unknown>;
    }): Promise<void> => {
      if (!run) return;
      await appendNextReceipt({ db, storage, run, ...input });
    };
    const currentSnapshot = await loadPromotionGrantSnapshot(db, item.grantId, confirmedLinks);
    const beforeSnapshot = item.beforeSnapshot as unknown as PromotionGrantSnapshot;
    const publicationIssues = verifyAppliedPromotionSnapshot({
      grantId: item.grantId,
      planStableKeys: planItem.promotionPlan.criterionStableKeys,
      plannedQuestions: planItem.promotionPlan.questions,
      beforeSnapshot,
      currentSnapshot,
      expectedStateSha256: item.afterSha256,
    }).map((issue) => `${issue.code}:${issue.detail}`);
    const publicationEvidence = {
      releaseId,
      observationMode,
      verificationMode,
      monitorExecutionId,
      monitorRuntime,
      releaseDbId: release.id,
      promotionItemId: item.id,
      planSha256: item.planSha256,
      expectedAfterSha256: item.afterSha256,
      actualAfterSha256: promotionGrantSnapshotStateSha256(currentSnapshot),
      issueCount: publicationIssues.length,
      issues: publicationIssues,
    };
    await appendProductionReceipt({
      stage: "publication_complete",
      status: publicationIssues.length === 0 ? "passed" : "failed",
      evidence: publicationEvidence,
    });
    if (publicationIssues.length > 0) {
      failures.push({
        grantId: item.grantId,
        stage: "publication_complete",
        issues: publicationIssues,
      });
      continue;
    }
    if (verificationMode === "publication_only") {
      passed.push({
        grantId: item.grantId,
        runId: run?.runId ?? item.runId,
        afterSha256: item.afterSha256,
        repositoryCriteriaSha256: "not_checked",
        traceSha256: "not_checked",
        sourceRevisionSha256: verifiedSourceRevisionSha256,
        verificationMode,
      });
      continue;
    }

    if (!entry) {
      const issues = ["production grant repository에서 공고를 읽지 못했습니다."];
      await appendProductionReceipt({
        stage: "serving_complete",
        status: "failed",
        evidence: {
          releaseId,
          observationMode,
          verificationMode,
          monitorExecutionId,
          monitorRuntime,
          promotionItemId: item.id,
          issueCount: issues.length,
          issues,
        },
      });
      failures.push({
        grantId: item.grantId,
        stage: "serving_complete",
        issues,
      });
      continue;
    }

    const servingState = servingStateByGrantId.get(item.grantId) ?? null;
    if (servingState !== "visible") {
      const issues = [
        `grant serving_state가 visible이 아닙니다: ${servingState ?? "missing"}`,
      ];
      await appendProductionReceipt({
        stage: "serving_complete",
        status: "failed",
        evidence: {
          releaseId,
          observationMode,
          verificationMode,
          monitorExecutionId,
          monitorRuntime,
          promotionItemId: item.id,
          servingState,
          issueCount: issues.length,
          issues,
        },
      });
      failures.push({
        grantId: item.grantId,
        stage: "serving_complete",
        issues,
      });
      continue;
    }

    const snapshotCriteriaSha256 = sha256Canonical(
      currentSnapshot.criteria.map(toServingCriterion).sort(byCriterionId),
    );
    const repositoryCriteriaSha256 = sha256Canonical(
      entry.criteria.map(toServingCriterion).sort(byCriterionId),
    );
    const traceRows = FIXED_SERVING_PROFILES.map(({ id, profile }) => {
      const match = buildGrantAnalysisShadowMatch({
        entry,
        criteria: entry.criteria,
        company: profile,
        asOf: new Date(manifest.createdAt),
      });
      return {
        profileId: id,
        eligibility: match.eligibility,
        tier: match.review_gate?.tier ?? null,
        score: match.fit_score,
        ruleTrace: match.rule_trace,
      };
    });
    const expectedCriterionIds = currentSnapshot.criteria.map((criterion) => criterion.id).sort();
    const traceIssues: string[] = [];
    if (snapshotCriteriaSha256 !== repositoryCriteriaSha256) {
      traceIssues.push("repository criteria hash가 promotion after snapshot과 다릅니다.");
    }
    for (const trace of traceRows) {
      const traceCriterionIds = trace.ruleTrace
        .map((row) => row.criterion_id)
        .filter((value): value is string => typeof value === "string")
        .sort();
      if (
        traceCriterionIds.length !== expectedCriterionIds.length
        || traceCriterionIds.some((value, index) => value !== expectedCriterionIds[index])
      ) {
        traceIssues.push(`${trace.profileId} matcher rule_trace criterion ID 집합 불일치`);
      }
    }
    const traceSha256 = sha256Canonical(traceRows);
    await appendProductionReceipt({
      stage: "serving_complete",
      status: traceIssues.length === 0 ? "passed" : "failed",
      evidence: {
        releaseId,
        observationMode,
        verificationMode,
        monitorExecutionId,
        monitorRuntime,
        promotionItemId: item.id,
        repository: "drizzle-production-grant-repository",
        matcher: "buildGrantAnalysisShadowMatch/matchNormalizedGrant",
        profileCorpus: FIXED_SERVING_PROFILES.map((profile) => profile.id),
        snapshotCriteriaSha256,
        repositoryCriteriaSha256,
        traceSha256,
        issueCount: traceIssues.length,
        issues: traceIssues,
      },
    });
    if (traceIssues.length > 0) {
      failures.push({
        grantId: item.grantId,
        stage: "serving_complete",
        issues: traceIssues,
      });
      continue;
    }

    const freshnessIssues: string[] = [];
    let currentSourceRevisionSha256: string;
    let currentInputSha256: string;
    if (run) {
      const currentInput = await prepareDeepAnalysisInput({
        db,
        storage,
        grantId: item.grantId,
        maxTotalChars: DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
      });
      currentSourceRevisionSha256 = currentInput.sourceRevisionSha256;
      currentInputSha256 = currentInput.inputSha256;
      if (!currentInput.sealed) freshnessIssues.push("current input이 sealed가 아닙니다.");
      if (currentSourceRevisionSha256 !== run.sourceRevisionSha256) {
        freshnessIssues.push("current source revision이 serving run과 다릅니다.");
      }
      if (currentInputSha256 !== run.inputSha256) {
        freshnessIssues.push("current input hash가 serving run과 다릅니다.");
      }
    } else {
      const { verifyPromotionReleaseSources } = await import(
        "../analysis-lab/promotion-candidates"
      );
      const drift = await verifyPromotionReleaseSources([sourceArtifact!]);
      freshnessIssues.push(...drift.map((issue) => `release source drift:${issue}`));
      currentSourceRevisionSha256 = verifiedSourceRevisionSha256;
      currentInputSha256 = localEvidence!.inputSha256;
    }
    await appendProductionReceipt({
      stage: "analysis_fresh",
      status: freshnessIssues.length === 0 ? "passed" : "stale",
      evidence: {
        releaseId,
        observationMode,
        verificationMode,
        monitorExecutionId,
        monitorRuntime,
        promotionItemId: item.id,
        runSourceRevisionSha256: run?.sourceRevisionSha256
          ?? sourceArtifact!.sourceRevisionSha256,
        currentSourceRevisionSha256,
        runInputSha256: run?.inputSha256 ?? localEvidence!.inputSha256,
        currentInputSha256,
        issueCount: freshnessIssues.length,
        issues: freshnessIssues,
      },
    });
    if (freshnessIssues.length > 0) {
      failures.push({
        grantId: item.grantId,
        stage: "analysis_fresh",
        issues: freshnessIssues,
      });
      continue;
    }
    passed.push({
      grantId: item.grantId,
      runId: run?.runId ?? item.runId,
      afterSha256: item.afterSha256,
      repositoryCriteriaSha256,
      traceSha256,
      sourceRevisionSha256: verifiedSourceRevisionSha256,
      verificationMode,
    });
  }

  return {
    schema: "deep-analysis-serving-verification-v1",
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    releaseId,
    scope,
    verificationMode,
    checked: targets.length,
    passed,
    failures,
  };
}

async function appendNextReceipt(input: {
  db: ReturnType<typeof getCunoteDb>;
  storage: NonNullable<ReturnType<typeof createR2ObjectStorageFromEnv>>;
  run: typeof schema.grantDeepAnalysisRuns.$inferSelect;
  stage: "publication_complete" | "serving_complete" | "analysis_fresh";
  status: "passed" | "failed" | "stale";
  evidence: Record<string, unknown>;
}): Promise<void> {
  const [attemptRow] = await input.db
    .select({ value: max(schema.grantDeepAnalysisStageReceipts.attempt) })
    .from(schema.grantDeepAnalysisStageReceipts)
    .where(and(
      eq(schema.grantDeepAnalysisStageReceipts.runId, input.run.id),
      eq(schema.grantDeepAnalysisStageReceipts.stage, input.stage),
    ));
  await appendVerifiedDeepAnalysisStageReceipt({
    db: input.db,
    storage: input.storage,
    grantId: input.run.grantId,
    sourceRevisionSha256: input.run.sourceRevisionSha256,
    publicRunId: input.run.runId,
    databaseRunId: input.run.id,
    stage: input.stage,
    status: input.status,
    verifierVersion: DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
    evidence: input.evidence,
    attempt: Number(attemptRow?.value ?? 0) + 1,
  });
}

function toServingCriterion(
  criterion: GrantCriterion | PromotionCriterionSnapshot,
): Record<string, unknown> {
  return {
    id: criterion.id,
    dimension: criterion.dimension,
    operator: criterion.operator,
    value: criterion.value,
    kind: criterion.kind,
    weight: criterion.weight ?? null,
    confidence: criterion.confidence,
    sourceSpan: "sourceSpan" in criterion
      ? criterion.sourceSpan
      : criterion.source_span ?? null,
    rawText: "rawText" in criterion ? criterion.rawText : criterion.raw_text ?? null,
    sourceField: "sourceField" in criterion
      ? criterion.sourceField
      : criterion.source_field ?? null,
    needsReview: "needsReview" in criterion
      ? criterion.needsReview
      : criterion.needs_review ?? false,
    parserVersion: "parserVersion" in criterion
      ? criterion.parserVersion
      : criterion.parser_version ?? null,
  };
}

function byCriterionId(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return String(left.id).localeCompare(String(right.id));
}

const FIXED_SERVING_PROFILES: Array<{ id: string; profile: CompanyProfile }> = [
  {
    id: "unknown-baseline-v1",
    profile: { confidence: {} },
  },
  {
    id: "seoul-software-mature-v1",
    profile: {
      region: { code: "11" },
      biz_age_months: 60,
      founder_age: 38,
      is_preliminary: false,
      industries: ["소프트웨어"],
      industry_codes: ["J", "62"],
      size: "small",
      revenue_krw: 1_000_000_000,
      employees_count: 12,
      business_status: { active: true },
      confidence: {},
    },
  },
  {
    id: "busan-manufacturing-preliminary-v1",
    profile: {
      region: { code: "26" },
      biz_age_months: 0,
      founder_age: 29,
      is_preliminary: true,
      industries: ["제조업"],
      industry_codes: ["C"],
      size: "micro",
      revenue_krw: 0,
      employees_count: 1,
      business_status: { active: true },
      confidence: {},
    },
  },
];

if (process.argv[1]?.endsWith("verify-serving-cli.ts")) {
  main()
    .then(async (code) => {
      const { closeCunoteDb } = await import("../db/client");
      await closeCunoteDb();
      process.exit(code);
    })
    .catch(async (error) => {
      console.error(
        "[deep-serving] 실패:",
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
}
