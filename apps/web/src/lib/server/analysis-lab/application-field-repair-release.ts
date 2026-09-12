import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  applicationFieldRepairServingStateSha256,
  applicationFieldRepairSnapshotSha256,
  loadApplicationFieldRepairSnapshot,
  type ApplicationFieldRepairSnapshot,
} from "../analysis-serving/applicationFieldRepairSnapshot";
import {
  validateApplicationFieldRepairReleaseManifest,
  type ApplicationFieldRepairParentBinding,
  type ApplicationFieldRepairReleaseManifest,
} from "../analysis-serving/applicationFieldRepairContract";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
} from "../analysis-serving/promotionSnapshot";
import { sha256Canonical, validatePromotionReleaseManifest } from "../analysis-serving/promotionReleaseContract";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import {
  applyPreparedGrantApplicationPrecompute,
} from "../documents/applicationPrecomputeMaterialization";
import { fieldCandidatesStorageKey } from "../documents/fieldCandidateStore";
import { acquireGrantPublicationLock } from "../ingestion/grantPublicationLock";
import {
  buildPromotionApplicationPrecomputeReceipt,
  type PromotionApplicationPrecomputeReceipt,
} from "./application-precompute-release";
import {
  grantApplicationPrecomputePlanSha256,
  persistStagedGrantApplicationPrecompute,
  type GrantApplicationPrecomputePlan,
  type StagedGrantApplicationPrecompute,
} from "./application-precompute-prepare";

export interface AppliedApplicationFieldRepairResult {
  releaseStatus: "canary_passed" | "active";
  replayed: boolean;
  receipt: PromotionApplicationPrecomputeReceipt;
  afterSha256: string;
  servingStateSha256: string;
}

/** application repair가 참조할 현재 serving parent를 유일하게 확정한다. */
export async function loadCurrentApplicationFieldRepairParent(
  db: CunoteDbSession,
  grantId: string,
): Promise<ApplicationFieldRepairParentBinding> {
  const rows = await db.select({
    promotionItemId: schema.analysisLabPromotionItems.id,
    releaseDbId: schema.analysisLabPromotionReleases.id,
    releaseId: schema.analysisLabPromotionReleases.releaseId,
    releaseManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
    releasePlanSha256: schema.analysisLabPromotionReleases.releasePlanSha256,
    releaseManifest: schema.analysisLabPromotionReleases.manifest,
    runId: schema.analysisLabPromotionItems.runId,
    planSha256: schema.analysisLabPromotionItems.planSha256,
    afterSha256: schema.analysisLabPromotionItems.afterSha256,
    appliedAt: schema.analysisLabPromotionItems.appliedAt,
  }).from(schema.analysisLabPromotionItems)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(schema.analysisLabPromotionReleases.id, schema.analysisLabPromotionItems.releaseDbId),
    )
    .where(and(
      eq(schema.analysisLabPromotionItems.grantId, grantId),
      eq(schema.analysisLabPromotionItems.status, "applied"),
      inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"]),
    ));
  if (rows.length !== 1) {
    throw new Error(`application repair parent가 유일하지 않습니다: ${grantId} (${rows.length})`);
  }
  const row = rows[0]!;
  if (!row.afterSha256 || !row.appliedAt) {
    throw new Error(`application repair parent receipt가 불완전합니다: ${grantId}`);
  }
  const parentManifest = validatePromotionReleaseManifest(row.releaseManifest);
  if (parentManifest.manifestSha256 !== row.releaseManifestSha256) {
    throw new Error(`application repair parent manifest가 불일치합니다: ${grantId}`);
  }
  const current = await loadPromotionGrantSnapshot(db, grantId);
  if (promotionGrantSnapshotStateSha256(current) !== row.afterSha256) {
    throw new Error(`application repair parent matching state가 변경됐습니다: ${grantId}`);
  }
  return {
    releaseDbId: row.releaseDbId,
    releaseId: row.releaseId,
    releaseManifestSha256: row.releaseManifestSha256,
    releasePlanSha256: row.releasePlanSha256,
    promotionItemId: row.promotionItemId,
    runId: row.runId,
    planSha256: row.planSha256,
    afterSha256: row.afterSha256,
    appliedAt: row.appliedAt.toISOString(),
  };
}

export async function assertApplicationFieldRepairAdmission(input: {
  db: CunoteDbSession;
  manifest: ApplicationFieldRepairReleaseManifest;
  expectedSnapshot?: ApplicationFieldRepairSnapshot;
}): Promise<ApplicationFieldRepairSnapshot> {
  const manifest = validateApplicationFieldRepairReleaseManifest(input.manifest);
  const parent = await loadCurrentApplicationFieldRepairParent(input.db, manifest.repair.grantId);
  if (sha256Canonical(parent) !== sha256Canonical(manifest.repair.parent)) {
    throw new Error(`application repair expected parent가 변경됐습니다: ${manifest.repair.grantId}`);
  }
  const [existingRepair] = await input.db.select({
    id: schema.analysisLabApplicationFieldRepairs.id,
    releaseDbId: schema.analysisLabApplicationFieldRepairs.releaseDbId,
    releaseId: schema.analysisLabPromotionReleases.releaseId,
  }).from(schema.analysisLabApplicationFieldRepairs)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(schema.analysisLabPromotionReleases.id, schema.analysisLabApplicationFieldRepairs.releaseDbId),
    )
    .where(eq(
      schema.analysisLabApplicationFieldRepairs.parentPromotionItemId,
      parent.promotionItemId,
    )).limit(1);
  if (existingRepair && existingRepair.releaseId !== manifest.releaseId) {
    throw new Error(`application repair successor가 이미 존재합니다: ${manifest.repair.grantId}`);
  }
  const snapshot = await loadApplicationFieldRepairSnapshot(input.db, manifest.repair.grantId);
  const snapshotSha256 = applicationFieldRepairSnapshotSha256(snapshot);
  if (
    snapshot.fields.length !== 0
    || manifest.repair.fieldCountBefore !== 0
    || snapshotSha256 !== manifest.repair.beforeApplicationSnapshotSha256
    || (input.expectedSnapshot
      && snapshotSha256 !== applicationFieldRepairSnapshotSha256(input.expectedSnapshot))
  ) {
    throw new Error(`application repair field/surface baseline이 변경됐습니다: ${manifest.repair.grantId}`);
  }
  const eligibleSurfaces = snapshot.surfaces.filter((surface) =>
    surface.type === "file_template"
    && (surface.format === "hwp" || surface.format === "hwpx")
    && surface.sourceAttachment
    && surface.archiveSha256);
  if (eligibleSurfaces.length < manifest.repair.expectedMaterializableSurfaceCount) {
    throw new Error(`application repair 원본 surface가 부족합니다: ${manifest.repair.grantId}`);
  }
  return snapshot;
}

/** 기존 release 승인 원장과 전용 repair item을 같은 transaction에서 준비한다. */
export async function prepareApplicationFieldRepairReleaseLedger(input: {
  db: CunoteDb;
  manifest: ApplicationFieldRepairReleaseManifest;
  createdBy: string;
  beforeSnapshot: ApplicationFieldRepairSnapshot;
}): Promise<{ releaseDbId: string; repairId: string }> {
  const manifest = validateApplicationFieldRepairReleaseManifest(input.manifest);
  return input.db.transaction(async (tx) => {
    await acquireGrantPublicationLock(tx, manifest.repair.grantId);
    await assertApplicationFieldRepairAdmission({
      db: tx,
      manifest,
      expectedSnapshot: input.beforeSnapshot,
    });
    const [release] = await tx.insert(schema.analysisLabPromotionReleases).values({
      releaseId: manifest.releaseId,
      revision: manifest.revision,
      manifestSha256: manifest.manifestSha256,
      releasePlanSha256: manifest.releasePlanSha256,
      manifest: manifest as unknown as Record<string, unknown>,
      gitCommit: manifest.gitCommit,
      buildDigest: manifest.buildDigest,
      status: "prepared",
      createdBy: input.createdBy,
    }).returning({ id: schema.analysisLabPromotionReleases.id });
    if (!release) throw new Error("application repair release 원장 생성에 실패했습니다.");
    const [repair] = await tx.insert(schema.analysisLabApplicationFieldRepairs).values({
      releaseDbId: release.id,
      grantId: manifest.repair.grantId,
      parentPromotionItemId: manifest.repair.parent.promotionItemId,
      roundtripRunId: manifest.repair.sourceArtifact.applicationPrecompute!.roundtripRunId!,
      applicationFieldAnalysisVersion:
        manifest.repair.sourceArtifact.localLabEvidence!.analysisLaunch!.applicationFieldAnalysisVersion!,
      planSha256: manifest.repair.planSha256,
      beforeSnapshot: input.beforeSnapshot as unknown as Record<string, unknown>,
      beforeSha256: manifest.repair.beforeApplicationSnapshotSha256,
      status: "prepared",
    }).returning({ id: schema.analysisLabApplicationFieldRepairs.id });
    if (!repair) throw new Error("application repair item 원장 생성에 실패했습니다.");
    return { releaseDbId: release.id, repairId: repair.id };
  });
}

/** exact app projection과 ledger/release 상태를 원자적으로 전진시킨다. */
export async function applyApplicationFieldRepairRelease(input: {
  db: CunoteDb;
  manifest: ApplicationFieldRepairReleaseManifest;
  staged?: StagedGrantApplicationPrecompute;
  executedBy: string;
}): Promise<AppliedApplicationFieldRepairResult> {
  const manifest = validateApplicationFieldRepairReleaseManifest(input.manifest);
  return input.db.transaction(async (tx) => {
    await acquireGrantPublicationLock(tx, manifest.repair.grantId);
    const { release, repair } = await loadReleaseAndRepair(tx, manifest);
    const receipt = repair.applicationPrecomputeReceipt as PromotionApplicationPrecomputeReceipt | null;
    if (repair.status === "applied") {
      if (!receipt || !repair.afterSha256 || !repair.servingStateSha256) {
        throw new Error("applied application repair receipt가 없습니다.");
      }
      await assertAppliedRepairServingCurrent(tx, manifest, repair.servingStateSha256);
      if (release.status === "canary_passed") {
        await updateReleaseStatus(tx, release.id, "canary_passed", "active", input.executedBy);
        return { releaseStatus: "active", replayed: true, receipt, afterSha256: repair.afterSha256, servingStateSha256: repair.servingStateSha256 };
      }
      if (release.status === "active") {
        return { releaseStatus: "active", replayed: true, receipt, afterSha256: repair.afterSha256, servingStateSha256: repair.servingStateSha256 };
      }
      throw new Error(`applied application repair release 상태가 잘못됐습니다: ${release.status}`);
    }
    if (release.status !== "approved" || repair.status !== "prepared") {
      throw new Error(`application repair write 상태가 잘못됐습니다: ${release.status}/${repair.status}`);
    }
    if (!input.staged) throw new Error("application repair staged materialization plan이 없습니다.");
    await lockRepairSurfaceIds(tx, input.staged.surfaces.map((surface) => surface.surfaceId));
    const before = await assertApplicationFieldRepairAdmission({ db: tx, manifest });
    assertStagedApplicationFieldRepairPlan(manifest, input.staged, before);
    if (repair.beforeSha256 !== applicationFieldRepairSnapshotSha256(before)) {
      throw new Error(`application repair ledger baseline이 다릅니다: ${manifest.repair.grantId}`);
    }
    await tx.update(schema.analysisLabApplicationFieldRepairs)
      .set({ status: "applying", error: null, updatedAt: new Date() })
      .where(and(
        eq(schema.analysisLabApplicationFieldRepairs.id, repair.id),
        eq(schema.analysisLabApplicationFieldRepairs.status, "prepared"),
      ));
    const prepared = await persistStagedGrantApplicationPrecompute({ db: tx, staged: input.staged });
    const applied = await applyPreparedGrantApplicationPrecompute({ db: tx, prepared });
    const applicationReceipt = buildPromotionApplicationPrecomputeReceipt({
      evidence: manifest.repair.sourceArtifact.applicationPrecompute!,
      applied,
    });
    const after = await loadApplicationFieldRepairSnapshot(tx, manifest.repair.grantId);
    const afterSha256 = applicationFieldRepairSnapshotSha256(after);
    const servingStateSha256 = applicationFieldRepairServingStateSha256(after);
    if (
      after.fields.length !== manifest.repair.expectedFieldCount
      || applicationReceipt.fields !== manifest.repair.expectedFieldCount
      || sha256Canonical(after.drafts) !== sha256Canonical(before.drafts)
    ) {
      throw new Error(`application repair materialization 결과가 plan과 다릅니다: ${manifest.repair.grantId}`);
    }
    await assertPromotionParentStateUnchanged(tx, manifest);
    const updated = await tx.update(schema.analysisLabApplicationFieldRepairs).set({
      afterSnapshot: after as unknown as Record<string, unknown>,
      afterSha256,
      servingStateSha256,
      applicationPrecomputeReceipt: applicationReceipt as unknown as Record<string, unknown>,
      status: "applied",
      error: null,
      appliedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.analysisLabApplicationFieldRepairs.id, repair.id),
      eq(schema.analysisLabApplicationFieldRepairs.status, "applying"),
    )).returning({ id: schema.analysisLabApplicationFieldRepairs.id });
    if (updated.length !== 1) throw new Error("application repair receipt CAS가 실패했습니다.");
    await updateReleaseStatus(tx, release.id, "approved", "canary_passed", input.executedBy);
    return {
      releaseStatus: "canary_passed",
      replayed: false,
      receipt: applicationReceipt,
      afterSha256,
      servingStateSha256,
    };
  });
}

export async function verifyApplicationFieldRepairRelease(input: {
  db: CunoteDbSession;
  manifest: ApplicationFieldRepairReleaseManifest;
}): Promise<{ ok: boolean; reasons: string[]; currentSha256: string | null }> {
  const manifest = validateApplicationFieldRepairReleaseManifest(input.manifest);
  const reasons: string[] = [];
  let currentSha256: string | null = null;
  try {
    const { release, repair } = await loadReleaseAndRepair(input.db, manifest);
    if (release.status !== "canary_passed" && release.status !== "active") reasons.push(`release_status:${release.status}`);
    if (repair.status !== "applied") reasons.push(`repair_status:${repair.status}`);
    const current = await loadApplicationFieldRepairSnapshot(input.db, manifest.repair.grantId);
    currentSha256 = applicationFieldRepairServingStateSha256(current);
    if (!repair.servingStateSha256 || repair.servingStateSha256 !== currentSha256) reasons.push("application_state_drift");
    if (current.fields.length !== manifest.repair.expectedFieldCount) reasons.push("field_count_mismatch");
    if (!repair.applicationPrecomputeReceipt) reasons.push("receipt_missing");
    await assertPromotionParentStateUnchanged(input.db, manifest);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: reasons.length === 0, reasons, currentSha256 };
}

/** regular parent rollback은 적용된 field repair를 고아로 만들 수 있으므로 명시적으로 차단한다. */
export async function assertNoAppliedApplicationFieldRepairForParent(
  db: CunoteDbSession,
  parentPromotionItemId: string,
): Promise<void> {
  const rows = await db.select({ id: schema.analysisLabApplicationFieldRepairs.id })
    .from(schema.analysisLabApplicationFieldRepairs)
    .where(and(
      eq(schema.analysisLabApplicationFieldRepairs.parentPromotionItemId, parentPromotionItemId),
      eq(schema.analysisLabApplicationFieldRepairs.status, "applied"),
    ));
  if (rows.length > 0) throw new Error("application_field_repair_applied");
}

export async function rollbackApplicationFieldRepairRelease(input: {
  db: CunoteDb;
  manifest: ApplicationFieldRepairReleaseManifest;
  executedBy: string;
}): Promise<void> {
  validateApplicationFieldRepairReleaseManifest(input.manifest);
  void input.db;
  void input.executedBy;
  throw new Error(
    "application field repair release는 append-only이며 서비스 DB rollback을 지원하지 않습니다. "
      + "문서 편집기의 사용자 Undo는 별도 경로입니다.",
  );
}

async function loadReleaseAndRepair(
  db: CunoteDbSession,
  manifest: ApplicationFieldRepairReleaseManifest,
) {
  const [release] = await db.select().from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, manifest.releaseId)).limit(1);
  if (!release) throw new Error("application repair release 원장이 없습니다.");
  if (
    release.manifestSha256 !== manifest.manifestSha256
    || release.releasePlanSha256 !== manifest.releasePlanSha256
    || sha256Canonical(release.manifest) !== sha256Canonical(manifest)
  ) throw new Error("application repair DB manifest 결속이 다릅니다.");
  const [repair] = await db.select().from(schema.analysisLabApplicationFieldRepairs)
    .where(eq(schema.analysisLabApplicationFieldRepairs.releaseDbId, release.id)).limit(1);
  if (
    !repair
    || repair.grantId !== manifest.repair.grantId
    || repair.parentPromotionItemId !== manifest.repair.parent.promotionItemId
    || repair.planSha256 !== manifest.repair.planSha256
    || repair.roundtripRunId !== manifest.repair.sourceArtifact.applicationPrecompute?.roundtripRunId
    || repair.applicationFieldAnalysisVersion
      !== manifest.repair.sourceArtifact.localLabEvidence?.analysisLaunch?.applicationFieldAnalysisVersion
    || repair.beforeSha256 !== manifest.repair.beforeApplicationSnapshotSha256
  ) throw new Error("application repair item 결속이 다릅니다.");
  return { release, repair };
}

async function lockRepairSurfaceIds(
  tx: CunoteDbSession,
  ids: readonly string[],
): Promise<void> {
  const surfaceIds = [...new Set(ids)].sort();
  for (const surfaceId of surfaceIds) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${surfaceId}))`);
  }
}

async function assertPromotionParentStateUnchanged(
  db: CunoteDbSession,
  manifest: ApplicationFieldRepairReleaseManifest,
): Promise<void> {
  const parent = await loadCurrentApplicationFieldRepairParent(db, manifest.repair.grantId);
  if (sha256Canonical(parent) !== sha256Canonical(manifest.repair.parent)) {
    throw new Error(`application repair parent drift: ${manifest.repair.grantId}`);
  }
}

async function assertAppliedRepairServingCurrent(
  db: CunoteDbSession,
  manifest: ApplicationFieldRepairReleaseManifest,
  expectedAfterSha256: string,
): Promise<void> {
  const current = await loadApplicationFieldRepairSnapshot(db, manifest.repair.grantId);
  if (applicationFieldRepairServingStateSha256(current) !== expectedAfterSha256) {
    throw new Error(`application repair after_drift: ${manifest.repair.grantId}`);
  }
  await assertPromotionParentStateUnchanged(db, manifest);
}


async function updateReleaseStatus(
  tx: CunoteDbSession,
  releaseDbId: string,
  expected: string,
  status: "canary_passed" | "active",
  executedBy: string,
): Promise<void> {
  const updated = await tx.update(schema.analysisLabPromotionReleases).set({
    status,
    executedBy,
    ...(status === "canary_passed" ? { startedAt: new Date() } : {}),
    ...(status === "active" ? { completedAt: new Date() } : {}),
  }).where(and(
    eq(schema.analysisLabPromotionReleases.id, releaseDbId),
    eq(schema.analysisLabPromotionReleases.status, expected),
  )).returning({ id: schema.analysisLabPromotionReleases.id });
  if (updated.length !== 1) throw new Error("application repair release 상태 CAS가 실패했습니다.");
}

export function assertStagedApplicationFieldRepairPlan(
  manifest: ApplicationFieldRepairReleaseManifest,
  staged: StagedGrantApplicationPrecompute,
  before: ApplicationFieldRepairSnapshot,
): void {
  const evidence = manifest.repair.sourceArtifact.applicationPrecompute!;
  const plan: GrantApplicationPrecomputePlan = {
    grantId: staged.grantId,
    parentLabRunId: staged.parentLabRunId,
    roundtripRunId: staged.roundtripRunId,
    surfaces: staged.surfaces.map(({ stagedArtifact: _stagedArtifact, ...surface }) => surface),
  };
  const surfaceById = new Map(before.surfaces.map((surface) => [surface.id, surface]));
  if (
    staged.grantId !== manifest.repair.grantId
    || staged.parentLabRunId !== manifest.repair.sourceArtifact.runId
    || staged.parentLabRunId !== evidence.parentLabRunId
    || staged.roundtripRunId !== evidence.roundtripRunId
    || grantApplicationPrecomputePlanSha256(plan) !== manifest.repair.materializationPlanSha256
    || staged.surfaces.some((surface) =>
      !surfaceById.has(surface.surfaceId)
      || surface.stagedArtifact.surfaceId !== surface.surfaceId
      || surface.stagedArtifact.sha256 !== sha256Json(surface.candidateSet)
      || surface.stagedArtifact.storageKey !== fieldCandidatesStorageKey({
        source: surfaceById.get(surface.surfaceId)!.source,
        sourceId: surfaceById.get(surface.surfaceId)!.sourceId,
        set: surface.candidateSet,
      })
      || sha256Canonical(surface.stagedArtifact.metadata) !== sha256Canonical({
        ...surface.metadata,
        engine: surface.candidateSet.engine,
        engineVersion: surface.candidateSet.engineVersion,
        layer: surface.candidateSet.layer,
        candidateCount: surface.candidateSet.candidates.length,
        extractedAt: surface.candidateSet.extractedAt,
      }))
  ) {
    throw new Error("application repair staged plan exact 결속이 다릅니다.");
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
