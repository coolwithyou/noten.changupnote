import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { applyPublishGuards } from "./promote";
import { loadConfirmedPromotionCandidates } from "./promotion-candidates";
import {
  assertManifestConfirmation,
  createPromotionReleaseManifest,
  hashFile,
  planSha256,
  promotionReleaseArtifactPath,
  readPromotionReleaseManifest,
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
import { findMonorepoRoot } from "./run-store";

loadMonorepoEnv();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function git(command: string[]): string {
  return execFileSync("git", command, {
    cwd: findMonorepoRoot(),
    encoding: "utf8",
  }).trim();
}

function assertCleanGitTree(): { gitCommit: string; buildDigest: string } {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    throw new Error("release 준비·승인은 clean git tree에서만 가능합니다. 변경을 검증하고 커밋해주세요.");
  }
  return {
    gitCommit: git(["rev-parse", "HEAD"]),
    buildDigest: git(["rev-parse", "HEAD^{tree}"]),
  };
}

function releaseIdFor(cohort: string, revision: number, now: Date, commit: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `deep-${cohort.replace(/[^A-Za-z0-9._-]/g, "-")}-r${revision}-${stamp}-${commit.slice(0, 8)}`;
}

async function assertDispatchCollected(week: string): Promise<void> {
  const db = getCunoteDb();
  const [batch] = await db
    .select({ id: schema.auditDispatchBatches.id })
    .from(schema.auditDispatchBatches)
    .where(eq(schema.auditDispatchBatches.week, week))
    .limit(1);
  if (!batch) throw new Error(`${week} 검수 배치를 찾지 못했습니다.`);
  const notices = await db
    .select({ id: schema.auditDispatchNotices.id })
    .from(schema.auditDispatchNotices)
    .where(eq(schema.auditDispatchNotices.batchId, batch.id));
  if (notices.length === 0) throw new Error(`${week} 검수 공고가 0건입니다.`);
  const items = await db
    .select({
      id: schema.auditDispatchItems.id,
      status: schema.auditDispatchItems.status,
      collectedAt: schema.auditDispatchItems.collectedAt,
      receipt: schema.auditDispatchItems.collectReceipt,
    })
    .from(schema.auditDispatchItems)
    .where(inArray(schema.auditDispatchItems.noticeId, notices.map((notice) => notice.id)));
  if (items.length === 0) throw new Error(`${week} 검수 항목이 0건입니다.`);
  const incomplete = items.filter((item) =>
    item.status !== "collected" || item.collectedAt === null || item.receipt === null);
  if (incomplete.length > 0) {
    const counts = new Map<string, number>();
    for (const item of incomplete) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    throw new Error(
      `${week} 검수 수거가 완료되지 않았습니다: ${[...counts.entries()]
        .map(([status, count]) => `${status} ${count}`)
        .join(", ")} (미완 ${incomplete.length}/${items.length})`,
    );
  }
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

async function prepare(): Promise<number> {
  const cohort = readArg("cohort")?.trim();
  const actor = readArg("actor")?.trim();
  const revision = Number(readArg("revision") ?? "1");
  if (!cohort) throw new Error("--cohort가 필요합니다. 예: --cohort=2026-W30");
  if (!actor) throw new Error("--actor에 준비 담당자 식별자가 필요합니다.");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("--revision은 1 이상의 정수여야 합니다.");
  const build = assertCleanGitTree();
  await assertDispatchCollected(cohort);

  const candidates = await loadConfirmedPromotionCandidates();
  if (candidates.length === 0) throw new Error("확정된 promotion candidate가 0건입니다.");
  const guarded = applyPublishGuards(candidates.map((candidate) => candidate.plan));
  if (guarded.refused.length > 0) {
    throw new Error(
      `발행 가드 거부 ${guarded.refused.length}건: ${guarded.refused
        .map((item) => `${item.plan.grantId}:${item.reason}`)
        .join(", ")}`,
    );
  }
  const unsafePlans = guarded.publishable.filter((plan) =>
    plan.conversion.dropped > 0
    || plan.droppedQuestionCandidates > 0
    || plan.resolutions.some((resolution) => resolution.state === "pending")
    || plan.criteria.some((criterion) => criterion.needs_review === true));
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
      costUsd: candidateByGrantId.get(plan.grantId)?.source.run.costUsd ?? null,
    });
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
    sourceArtifacts: candidates.map((candidate) => candidate.sourceArtifact),
    plans: planItems,
  });
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
  console.log(`[release] 대상 ${manifest.plans.length}건 · canary ${manifest.canaryGrantIds.join(", ")}`);
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
  assertCleanGitTree();
  const manifest = await readPromotionReleaseManifest(releaseId);
  assertManifestConfirmation(manifest, readArg("confirm"));
  const aggregate = await readGate(
    releaseId,
    "aggregate.json",
    "analysis-lab-promotion-aggregate-v1",
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
      gateSummary: {
        aggregateSha256: aggregate.sha256,
        shadowSha256: shadow.sha256,
        dryRunSha256: dryRun.sha256,
      },
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
