import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { applyPublishGuards } from "./promote";
import { assertReceiptBackedPromotionMutationAdmitted } from "./promotion-mutation-admission";
import { loadDeepRepairPromotionCohort } from "./deep-repair-promotion";
import {
  assertPromotionReleaseContinuationBinding,
  assertManifestConfirmation,
  createPromotionReleaseManifest,
  hashFile,
  mergePromotionApprovalGateEvidence,
  planSha256,
  PROMOTION_AGGREGATE_SCHEMA,
  promotionPlanHasUnsafeUnresolvedCriteria,
  promotionReleaseArtifactPath,
  readPromotionReleaseManifest,
  validatePromotionReleaseManifest,
  writeImmutablePromotionArtifact,
  type PromotionApprovalArtifact,
  type PromotionReleasePlanItem,
} from "./promotion-release";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotHashes,
  promotionGrantSnapshotStateSha256,
} from "./promotion-snapshot";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { readPromotionBuildProvenance } from "./promotion-build-provenance";

loadMonorepoEnv();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function releaseIdFor(cohort: string, revision: number, now: Date, commit: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `deep-${cohort.replace(/[^A-Za-z0-9._-]/g, "-")}-r${revision}-${stamp}-${commit.slice(0, 8)}`;
}

function selectCanaries(
  planItems: PromotionReleasePlanItem[],
  requested: string | undefined,
): string[] {
  if (requested?.trim()) {
    const requestedIds = [...new Set(requested.split(",").map((id) => id.trim()).filter(Boolean))];
    const allowed = new Set(planItems.map((item) => item.grantId));
    for (const id of requestedIds) {
      if (!allowed.has(id)) throw new Error(`--canary 공고가 release plan에 없습니다: ${id}`);
    }
    if (requestedIds.length === 0) throw new Error("--canary에 공고 ID가 필요합니다.");
    return requestedIds.sort();
  }
  const preferred = planItems.filter((item) => item.questionCountAfter > 0);
  const selected = (preferred.length > 0 ? preferred : planItems).slice(0, 1);
  return selected.map((item) => item.grantId).sort();
}

type PreparedGateArtifact = {
  schema?: unknown;
  releaseId?: unknown;
  releasePlanSha256?: unknown;
  manifestSha256?: unknown;
  verdict?: unknown;
};

async function readPreparedGateArtifact(
  releaseId: string,
  name: "aggregate.json" | "shadow.json" | "dry-run.json",
): Promise<PreparedGateArtifact | null> {
  try {
    return JSON.parse(await readFile(
      promotionReleaseArtifactPath(releaseId, name),
      "utf8",
    )) as PreparedGateArtifact;
  } catch {
    return null;
  }
}

function assertPreparedGateBinding(
  releaseId: string,
  manifest: ReturnType<typeof validatePromotionReleaseManifest>,
  name: string,
  artifact: PreparedGateArtifact,
): void {
  if (
    artifact.releaseId !== releaseId
    || artifact.releasePlanSha256 !== manifest.releasePlanSha256
    || artifact.manifestSha256 !== manifest.manifestSha256
  ) {
    throw new Error(`기존 prepared release ${name} 결속이 올바르지 않습니다: ${releaseId}`);
  }
}

/**
 * prepared item은 실제 승격 중복이 아니라 release revision 예약이다. 동일 exact cohort의
 * 이전 revision이 immutable gate에서 실패한 경우에만 더 높은 revision으로 재시도한다.
 * 현재 admission으로 승인할 수 없는 legacy 예약과 완전 rollback은 충돌에서 제외한다.
 * 진행 중이거나 승인 가능한 exact release, 다른 exact cohort의 부분 겹침은 fail-closed한다.
 */
async function assertPreparedRevisionCanAdvance(input: {
  cohort: string;
  revision: number;
  grantIds: readonly string[];
  plans: PromotionReleasePlanItem[];
  sourceArtifacts: ReturnType<typeof validatePromotionReleaseManifest>["sourceArtifacts"];
}): Promise<{ supersededReleaseIds: string[]; refreshedSourceGrantIds: string[] }> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      id: schema.analysisLabPromotionReleases.id,
      releaseId: schema.analysisLabPromotionReleases.releaseId,
      revision: schema.analysisLabPromotionReleases.revision,
      status: schema.analysisLabPromotionReleases.status,
      manifest: schema.analysisLabPromotionReleases.manifest,
    })
    .from(schema.analysisLabPromotionReleases)
    .innerJoin(
      schema.analysisLabPromotionItems,
      eq(schema.analysisLabPromotionItems.releaseDbId, schema.analysisLabPromotionReleases.id),
    )
    .where(inArray(schema.analysisLabPromotionItems.grantId, [...input.grantIds]));
  const releases = [...new Map(rows.map((row) => [row.id, row])).values()];
  const requested = [...input.grantIds].sort();
  const supersededReleaseIds: string[] = [];
  const refreshedSourceGrantIds = new Set<string>();
  for (const release of releases) {
    if (release.status === "rolled_back") continue;
    if (release.status !== "prepared") {
      throw new Error(
        `이미 승인·적용 수명주기에 진입한 release와 겹칩니다: ${release.releaseId} (${release.status})`,
      );
    }
    const manifest = validatePromotionReleaseManifest(release.manifest);
    try {
      assertReceiptBackedPromotionMutationAdmitted(manifest);
    } catch {
      // 현재 승인 경로도 같은 admission을 호출한다. 따라서 이 legacy prepared 행은 실제
      // 적용으로 전진할 수 없는 역사적 예약이며 신규 exact receipt release를 막지 않는다.
      continue;
    }
    const existing = manifest.plans.map((item) => item.grantId).sort();
    const sameExactCohort = manifest.cohortLabel === input.cohort
      && existing.length === requested.length
      && existing.every((grantId, index) => grantId === requested[index]);
    if (!sameExactCohort) {
      throw new Error(`다른 prepared release와 대상이 겹칩니다: ${release.releaseId}`);
    }
    if (input.revision <= release.revision) {
      throw new Error(
        `새 revision은 기존 ${release.releaseId}의 r${release.revision}보다 커야 합니다.`,
      );
    }
    const aggregate = await readPreparedGateArtifact(release.releaseId, "aggregate.json");
    if (!aggregate) {
      throw new Error(`기존 prepared release의 aggregate가 종결되지 않았습니다: ${release.releaseId}`);
    }
    assertPreparedGateBinding(release.releaseId, manifest, "aggregate", aggregate);
    if (aggregate.verdict === "ITERATE" || aggregate.verdict === "STOP") {
      const continuation = assertPromotionReleaseContinuationBinding(manifest, input);
      continuation.refreshedSourceGrantIds.forEach((grantId) => refreshedSourceGrantIds.add(grantId));
      supersededReleaseIds.push(release.releaseId);
      continue;
    }
    if (aggregate.verdict !== "GO") {
      throw new Error(`기존 prepared release aggregate 판정을 해석할 수 없습니다: ${release.releaseId}`);
    }

    const shadow = await readPreparedGateArtifact(release.releaseId, "shadow.json");
    if (!shadow) {
      throw new Error(`기존 prepared release가 shadow 진행 중입니다: ${release.releaseId}`);
    }
    assertPreparedGateBinding(release.releaseId, manifest, "shadow", shadow);
    if (shadow.verdict === "FAIL") {
      const continuation = assertPromotionReleaseContinuationBinding(manifest, input);
      continuation.refreshedSourceGrantIds.forEach((grantId) => refreshedSourceGrantIds.add(grantId));
      supersededReleaseIds.push(release.releaseId);
      continue;
    }
    if (shadow.verdict !== "PASS") {
      throw new Error(`기존 prepared release shadow 판정을 해석할 수 없습니다: ${release.releaseId}`);
    }

    const dryRun = await readPreparedGateArtifact(release.releaseId, "dry-run.json");
    if (!dryRun) {
      throw new Error(`기존 prepared release가 dry-run 진행 중입니다: ${release.releaseId}`);
    }
    assertPreparedGateBinding(release.releaseId, manifest, "dry-run", dryRun);
    if (dryRun.verdict === "FAIL") {
      const continuation = assertPromotionReleaseContinuationBinding(manifest, input);
      continuation.refreshedSourceGrantIds.forEach((grantId) => refreshedSourceGrantIds.add(grantId));
      supersededReleaseIds.push(release.releaseId);
      continue;
    }
    if (dryRun.verdict !== "PASS") {
      throw new Error(`기존 prepared release dry-run 판정을 해석할 수 없습니다: ${release.releaseId}`);
    }
    throw new Error(`기존 prepared release가 모든 gate를 통과해 대체할 수 없습니다: ${release.releaseId}`);
  }
  return {
    supersededReleaseIds,
    refreshedSourceGrantIds: [...refreshedSourceGrantIds].sort(),
  };
}

async function prepare(): Promise<number> {
  const series = readArg("series")?.trim();
  const cohort = readArg("cohort")?.trim() || series;
  const actor = readArg("actor")?.trim();
  const exactGrantIds = (readArg("grantIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const revision = Number(readArg("revision") ?? "1");
  if (!series) {
    throw new Error(
      "신규 release 준비는 receipt 기반 exact cohort만 허용합니다. --series와 --grantIds exact CSV가 필요합니다.",
    );
  }
  if (!cohort) throw new Error("--cohort가 필요합니다.");
  if (!actor) throw new Error("--actor에 준비 담당자 식별자가 필요합니다.");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("--revision은 1 이상의 정수여야 합니다.");
  if (readArg("grantId") || hasFlag("audited-local-canary")) {
    throw new Error("legacy --grantId/--audited-local-canary release 준비 경로는 폐기됐습니다.");
  }
  if (exactGrantIds.length === 0) {
    throw new Error("자동 대상 선정을 하지 않습니다. --grantIds exact CSV가 필요합니다.");
  }
  const build = readPromotionBuildProvenance();
  const deepRepairCohort = await loadDeepRepairPromotionCohort({
    seriesId: series,
    grantIds: exactGrantIds,
  });
  const excluded = [...deepRepairCohort.adminReview, ...deepRepairCohort.held];
  if (excluded.length > 0) {
    throw new Error(
      `exact cohort에 자동 release 불가 대상이 있습니다: ${excluded
        .map((item) => `${item.grantId}:${item.readiness.disposition}(${item.readiness.reasons.join("+")})`)
        .join(", ")}`,
    );
  }
  const candidates = deepRepairCohort.candidates;
  if (candidates.length === 0) throw new Error("확정된 promotion candidate가 0건입니다.");
  const guarded = applyPublishGuards(candidates.map((candidate) => candidate.plan));
  if (guarded.refused.length > 0) {
    throw new Error(
      `발행 가드 거부 ${guarded.refused.length}건: ${guarded.refused
        .map((item) => `${item.plan.grantId}:${item.reason}`)
        .join(", ")}`,
    );
  }
  const reviewBlockedPlans = guarded.publishable.filter(
    (plan) => plan.reviewRisk?.disposition === "blocked",
  );
  if (reviewBlockedPlans.length > 0) {
    throw new Error(
      `신청 가능 여부에 영향을 주는 검수 오류가 남아 release를 준비할 수 없습니다: ${reviewBlockedPlans
        .map((plan) => `${plan.grantId}(${plan.reviewRisk?.blockers.map((item) => item.code).join(",")})`)
        .join(", ")}`,
    );
  }
  const unsafePlans = guarded.publishable.filter((plan) =>
    (plan.origin === "deep_repair"
      ? plan.conversion.dropped !== (plan.scopeRejectedCriterionIndexes?.length ?? -1)
      : plan.conversion.dropped > 0 || plan.droppedQuestionCandidates > 0)
    || promotionPlanHasUnsafeUnresolvedCriteria(plan));
  if (unsafePlans.length > 0) {
    throw new Error(
      `미확정·변환 드롭·질문 앵커 상실이 남아 release를 준비할 수 없습니다: ${unsafePlans
        .map((plan) => plan.grantId)
        .join(", ")}`,
    );
  }

  const db = getCunoteDb();
  const grantIds = guarded.publishable.map((plan) => plan.grantId);
  const grantRows = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(inArray(schema.grants.id, grantIds));
  const known = new Set(grantRows.map((row) => row.id));
  const missing = grantIds.filter((grantId) => !known.has(grantId));
  if (missing.length > 0) throw new Error(`운영 DB 공고 누락: ${missing.join(", ")}`);

  const confirmedLinks = await db
    .select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    })
    .from(schema.dedupLinks)
    .where(eq(schema.dedupLinks.confirmed, true));
  const candidateByGrantId = new Map(
    candidates.map((candidate) => [candidate.plan.grantId, candidate]),
  );
  const deepRepairReadinessByGrantId = new Map(
    deepRepairCohort.candidates.map((candidate) => [
      candidate.plan.grantId,
      candidate.readiness,
    ]),
  );
  const planItems: PromotionReleasePlanItem[] = [];
  const snapshotByGrant = new Map<string, Awaited<ReturnType<typeof loadPromotionGrantSnapshot>>>();
  for (const plan of guarded.publishable) {
    const snapshot = await loadPromotionGrantSnapshot(db, plan.grantId, confirmedLinks);
    snapshotByGrant.set(plan.grantId, snapshot);
    const hashes = promotionGrantSnapshotHashes(snapshot);
    planItems.push({
      grantId: plan.grantId,
      planSha256: planSha256(plan),
      promotionPlan: plan,
      beforeCriteriaSha256: hashes.criteriaSha256,
      beforeQuestionsSha256: hashes.questionsSha256,
      dedupComponentSha256: hashes.dedupComponentSha256,
      criteriaCountBefore: snapshot.criteria.length,
      criteriaCountAfter: plan.criteria.length,
      questionCountAfter: plan.questions.length,
      pendingCount: plan.resolutions.filter((item) => item.state === "pending").length,
      downgradedCount: plan.conversion.downgraded,
      ...(deepRepairReadinessByGrantId.has(plan.grantId)
        ? { deepRepairReadiness: deepRepairReadinessByGrantId.get(plan.grantId)! }
        : {}),
      transport: candidateByGrantId.get(plan.grantId)?.source.run.transport ?? "api",
      costUsd: candidateByGrantId.get(plan.grantId)?.source.run.costUsd ?? null,
    });
  }

  const sourceArtifacts = candidates.map((candidate) => candidate.sourceArtifact);
  const continuation = await assertPreparedRevisionCanAdvance({
    cohort,
    revision,
    grantIds: exactGrantIds,
    plans: planItems,
    sourceArtifacts,
  });
  if (continuation.supersededReleaseIds.length > 0) {
    console.log(`[release] 실패 revision 대체: ${continuation.supersededReleaseIds.join(", ")}`);
  }
  if (continuation.refreshedSourceGrantIds.length > 0) {
    console.log(
      `[release] source provenance 갱신, promotion material 동일: ${continuation.refreshedSourceGrantIds.join(", ")}`,
    );
  }

  const now = new Date();
  const releaseId = readArg("releaseId")?.trim()
    || releaseIdFor(cohort, revision, now, build.gitCommit);
  const manifest = createPromotionReleaseManifest({
    releaseId,
    revision,
    createdAt: now.toISOString(),
    gitCommit: build.gitCommit,
    buildDigest: build.buildDigest,
    cohortLabel: cohort,
    canaryGrantIds: selectCanaries(planItems, readArg("canary")),
    sourceArtifacts,
    plans: planItems,
  });
  // 파일 또는 DB를 쓰기 전에 현재 mutation admission과 동일한 receipt 결속을 증명한다.
  assertReceiptBackedPromotionMutationAdmitted(manifest);
  await writeImmutablePromotionArtifact(
    promotionReleaseArtifactPath(releaseId, "manifest.json"),
    manifest,
  );
  await db.transaction(async (tx) => {
    const [release] = await tx
      .insert(schema.analysisLabPromotionReleases)
      .values({
        releaseId,
        revision,
        manifestSha256: manifest.manifestSha256,
        releasePlanSha256: manifest.releasePlanSha256,
        manifest: manifest as unknown as Record<string, unknown>,
        gitCommit: manifest.gitCommit,
        buildDigest: manifest.buildDigest,
        status: "prepared",
        createdBy: actor,
      })
      .returning({ id: schema.analysisLabPromotionReleases.id });
    if (!release) throw new Error("release 원장 생성에 실패했습니다.");
    await tx.insert(schema.analysisLabPromotionItems).values(
      manifest.plans.map((item) => ({
        releaseDbId: release.id,
        grantId: item.grantId,
        runId: item.promotionPlan.runId,
        planSha256: item.planSha256,
        beforeSnapshot: snapshotByGrant.get(item.grantId) as unknown as Record<string, unknown>,
        beforeSha256: promotionGrantSnapshotStateSha256(snapshotByGrant.get(item.grantId)!),
        status: "prepared",
      })),
    );
  });
  console.log(`[release] 준비 완료: ${releaseId}`);
  console.log(`[release] manifest: ${manifest.manifestSha256}`);
  console.log(`[release] plan: ${manifest.releasePlanSha256}`);
  console.log(
    `[release] 대상 ${manifest.plans.length}건 · 조건부 ${manifest.plans.filter(
      (item) => item.promotionPlan.reviewRisk?.disposition === "conditional"
        || item.deepRepairReadiness?.disposition === "conditional",
    ).length}건 · canary ${manifest.canaryGrantIds.join(", ")}`,
  );
  return 0;
}

async function inspectDeepRepairCohort(): Promise<number> {
  const series = readArg("series")?.trim();
  const grantIds = (readArg("grantIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!series) throw new Error("--inspect에는 --series가 필요합니다.");
  if (grantIds.length === 0) throw new Error("--inspect에는 --grantIds exact CSV가 필요합니다.");
  const cohort = await loadDeepRepairPromotionCohort({ seriesId: series, grantIds });
  console.log(JSON.stringify({
    seriesId: cohort.seriesId,
    proposalSha256: cohort.proposalSha256,
    planSha256: cohort.planSha256,
    manifestSha256: cohort.manifestSha256,
    candidates: cohort.candidates.map((candidate) => ({
      sequence: candidate.sourceArtifact.localLabEvidence?.deepRepair?.sequence,
      grantId: candidate.plan.grantId,
      runId: candidate.plan.runId,
      runSha256: candidate.sourceArtifact.runSha256,
      disposition: candidate.readiness.disposition,
      reasons: candidate.readiness.reasons,
      unresolvedAxes: candidate.readiness.unresolvedAxes,
      sourceRevisionSha256: candidate.readiness.sourceRevisionSha256,
      inputSha256: candidate.readiness.inputSha256,
      attachmentManifestSha256: candidate.readiness.attachmentManifestSha256,
      receiptSha256: candidate.readiness.receiptSha256,
      criteriaCount: candidate.plan.criteria.length,
    })),
    adminReview: cohort.adminReview,
    held: cohort.held,
  }, null, 2));
  return 0;
}

type GateArtifact = {
  schema?: unknown;
  releaseId?: unknown;
  releasePlanSha256?: unknown;
  manifestSha256?: unknown;
  verdict?: unknown;
};

async function readGate(
  releaseId: string,
  name: "aggregate.json" | "shadow.json" | "dry-run.json",
  expectedSchema: string,
  expectedVerdict: string,
  releasePlanHash: string,
  manifestHash: string,
): Promise<{ sha256: string; artifact: GateArtifact }> {
  const path = promotionReleaseArtifactPath(releaseId, name);
  const artifact = JSON.parse(await readFile(path, "utf8")) as GateArtifact;
  if (
    artifact.schema !== expectedSchema
    || artifact.releaseId !== releaseId
    || artifact.releasePlanSha256 !== releasePlanHash
    || artifact.manifestSha256 !== manifestHash
    || artifact.verdict !== expectedVerdict
  ) {
    throw new Error(
      `${name}이 schema·manifest·release plan·승인 조건(${expectedVerdict})과 일치하지 않습니다.`,
    );
  }
  return { sha256: await hashFile(path), artifact };
}

async function approve(): Promise<number> {
  const releaseId = readArg("release")?.trim();
  const actor = readArg("actor")?.trim();
  if (!releaseId) throw new Error("--release가 필요합니다.");
  if (!actor) throw new Error("--actor에 승인 담당자 식별자가 필요합니다.");
  readPromotionBuildProvenance();
  const manifest = await readPromotionReleaseManifest(releaseId);
  assertManifestConfirmation(manifest, readArg("confirm"));
  assertReceiptBackedPromotionMutationAdmitted(manifest);
  const aggregate = await readGate(
    releaseId,
    "aggregate.json",
    PROMOTION_AGGREGATE_SCHEMA,
    "GO",
    manifest.releasePlanSha256,
    manifest.manifestSha256,
  );
  const shadow = await readGate(
    releaseId,
    "shadow.json",
    "analysis-lab-promotion-shadow-v1",
    "PASS",
    manifest.releasePlanSha256,
    manifest.manifestSha256,
  );
  const dryRun = await readGate(
    releaseId,
    "dry-run.json",
    "analysis-lab-promotion-dry-run-v1",
    "PASS",
    manifest.releasePlanSha256,
    manifest.manifestSha256,
  );
  const db = getCunoteDb();
  const [release] = await db
    .select()
    .from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId))
    .limit(1);
  if (!release) throw new Error("DB release 원장을 찾지 못했습니다.");
  if (release.status !== "prepared") throw new Error(`승인 가능한 상태가 아닙니다: ${release.status}`);
  if (release.manifestSha256 !== manifest.manifestSha256) throw new Error("DB manifest hash가 다릅니다.");
  if (release.createdBy === actor) throw new Error("최초 release는 준비자와 승인자가 달라야 합니다.");

  const approval: PromotionApprovalArtifact = {
    schema: "analysis-lab-promotion-approval-v1",
    releaseId,
    releasePlanSha256: manifest.releasePlanSha256,
    manifestSha256: manifest.manifestSha256,
    aggregateSha256: aggregate.sha256,
    shadowSha256: shadow.sha256,
    dryRunSha256: dryRun.sha256,
    approvedBy: actor,
    approvedAt: new Date().toISOString(),
  };
  const approvalPath = promotionReleaseArtifactPath(releaseId, "approval.json");
  await writeImmutablePromotionArtifact(approvalPath, approval);
  const approvalSha256 = await hashFile(approvalPath);
  const updated = await db
    .update(schema.analysisLabPromotionReleases)
    .set({
      status: "approved",
      gateSummary: mergePromotionApprovalGateEvidence(release.gateSummary, {
        aggregateSha256: aggregate.sha256,
        shadowSha256: shadow.sha256,
        dryRunSha256: dryRun.sha256,
      }),
      approvedBy: actor,
      approvedAt: new Date(approval.approvedAt),
      approvalArtifactSha256: approvalSha256,
    })
    .where(and(
      eq(schema.analysisLabPromotionReleases.id, release.id),
      eq(schema.analysisLabPromotionReleases.status, "prepared"),
    ))
    .returning({ id: schema.analysisLabPromotionReleases.id });
  if (updated.length !== 1) throw new Error("release 승인 CAS가 실패했습니다.");
  console.log(`[release] 승인 완료: ${releaseId} (${actor})`);
  return 0;
}

async function main(): Promise<number> {
  if (hasFlag("inspect")) return inspectDeepRepairCohort();
  if (hasFlag("prepare")) return prepare();
  if (hasFlag("approve")) return approve();
  throw new Error("--prepare 또는 --approve 중 하나가 필요합니다.");
}

async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 종료 정리 실패는 원래 결과를 가리지 않는다.
  }
}

main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[release] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });
