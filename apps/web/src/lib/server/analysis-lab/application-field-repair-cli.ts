/**
 * 검증된 current-inventory launch의 application projection만 기존 active promotion parent 아래 보완한다.
 * matching/criteria/questions와 regular promotion item은 어떤 단계에서도 쓰지 않는다.
 */
import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  APPLICATION_FIELD_REPAIR_INVENTORY_POLICY,
  createApplicationFieldRepairReleaseManifest,
  validateApplicationFieldRepairReleaseManifest,
  type ApplicationFieldRepairReleaseManifest,
} from "../analysis-serving/applicationFieldRepairContract";
import {
  applicationFieldRepairSnapshotSha256,
  loadApplicationFieldRepairSnapshot,
} from "../analysis-serving/applicationFieldRepairSnapshot";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";
import { getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  applyApplicationFieldRepairRelease,
  assertApplicationFieldRepairAdmission,
  loadCurrentApplicationFieldRepairParent,
  prepareApplicationFieldRepairReleaseLedger,
  rollbackApplicationFieldRepairRelease,
  verifyApplicationFieldRepairRelease,
} from "./application-field-repair-release";
import {
  grantApplicationPrecomputePlanSha256,
  loadGrantApplicationPrecomputePlan,
  stageGrantApplicationPrecompute,
} from "./application-precompute-prepare";
import {
  prepareAnalysisLaunchPromotionApplicationPrecomputeBundle,
  readBundledPromotionApplicationPrecompute,
  writePreparedPromotionApplicationPrecomputeBundle,
} from "./application-precompute-release";
import { loadAnalysisLaunchPromotionCohort } from "./analysis-launch-promotion";
import { loadCurrentGrantEvidence } from "./deep-repair-promotion";
import {
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  readAnalysisLaunchArtifact,
} from "./launch-batch-artifacts";
import { verifyCurrentInventoryLaunchBinding } from "./current-inventory-launch";
import { readPromotionBuildProvenance } from "./promotion-build-provenance";
import { verifyPromotionReleaseSources } from "./promotion-candidates";
import {
  hashFile,
  promotionReleaseArtifactPath,
  promotionVerificationArtifactPath,
  readApplicationFieldRepairReleaseManifest,
  writeImmutablePromotionArtifact,
} from "./promotion-release";
import { findMonorepoRoot } from "./run-store";
import { readRoundtripRunArtifacts } from "./application-roundtrip/store";
import {
  APPLICATION_FIELD_REPAIR_AGGREGATE_SCHEMA,
  APPLICATION_FIELD_REPAIR_APPROVAL_SCHEMA,
  APPLICATION_FIELD_REPAIR_DRY_RUN_SCHEMA,
  APPLICATION_FIELD_REPAIR_SHADOW_SCHEMA,
  APPLICATION_FIELD_REPAIR_VERIFICATION_SCHEMA,
  validateApplicationFieldRepairApprovalArtifact,
  validateApplicationFieldRepairGateArtifact,
  validateApplicationFieldRepairVerificationArtifact,
  type ApplicationFieldRepairArtifactBinding,
  type ApplicationFieldRepairGateExpectation,
  type ApplicationFieldRepairGateName,
} from "./application-field-repair-provenance";

loadMonorepoEnv();

const MIN_CONFIRM_PREFIX = 12;

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function exactSingleGrantId(): string {
  const grantId = readArg("grantId")?.trim();
  if (!grantId || !/^[a-f0-9-]{36}$/u.test(grantId)) throw new Error("--grantId exact 1건이 필요합니다.");
  return grantId;
}

function exactLaunchReceipt(): string {
  const receipt = readArg("launch-receipt")?.trim();
  if (!receipt || !/^[a-f0-9]{64}$/u.test(receipt)) throw new Error("--launch-receipt SHA-256이 필요합니다.");
  return receipt;
}

function exactReleaseId(): string {
  const releaseId = readArg("release")?.trim();
  if (!releaseId) throw new Error("--release가 필요합니다.");
  return releaseId;
}

function parseVerificationAttempt(value: string | undefined, required = false): number {
  if (value === undefined && !required) return 1;
  if (!value || !/^\d+$/u.test(value)) {
    throw new Error("verification attempt는 1 이상의 정수여야 합니다.");
  }
  const attempt = Number(value);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("verification attempt는 1 이상의 정수여야 합니다.");
  }
  return attempt;
}

function assertConfirmation(manifest: ApplicationFieldRepairReleaseManifest): void {
  const confirmation = readArg("confirm")?.trim().toLowerCase() ?? "";
  if (confirmation.length < MIN_CONFIRM_PREFIX || !manifest.manifestSha256.startsWith(confirmation)) {
    throw new Error(`--confirm은 manifest hash 앞 ${MIN_CONFIRM_PREFIX}자 이상과 일치해야 합니다.`);
  }
}

async function loadExactLaunchInventoryBinding(launchReceiptSha256: string, grantId: string) {
  const receipt = normalizeAnalysisLaunchReceipt(
    await readAnalysisLaunchArtifact("receipts", launchReceiptSha256),
  );
  const manifest = normalizeAnalysisLaunchManifest(
    await readAnalysisLaunchArtifact("manifests", receipt.manifestSha256),
  );
  if (
    manifest.source.kind !== "current_inventory"
    || manifest.targets.length !== 1
    || manifest.targets[0]?.grantId !== grantId
    || receipt.targets.length !== 1
    || receipt.targets[0]?.grantId !== grantId
  ) throw new Error("application repair는 current-inventory exact 1건 launch만 허용합니다.");
  const inventory = await verifyCurrentInventoryLaunchBinding(findMonorepoRoot(), manifest);
  if (
    !inventory
    || inventory.policy !== APPLICATION_FIELD_REPAIR_INVENTORY_POLICY
    || inventory.targets.length !== 1
    || inventory.targets[0]?.grantId !== grantId
  ) throw new Error("application repair missing-field inventory 결속이 다릅니다.");
  return { receipt, manifest, inventory, inventorySha256: manifest.source.planArtifactSha256 };
}

async function buildRepairManifest(input: {
  releaseId: string;
  revision: number;
  cohortLabel: string;
  gitCommit: string;
  buildDigest: string;
  launchReceiptSha256: string;
  grantId: string;
  db: CunoteDb;
}) {
  const launch = await loadExactLaunchInventoryBinding(input.launchReceiptSha256, input.grantId);
  const cohort = await loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [input.launchReceiptSha256],
    grantIds: [input.grantId],
    dependencies: {
      loadCurrentGrantEvidence: async (run) => ({
        ...await loadCurrentGrantEvidence(run, new Date()),
        hasPromotionItem: false,
      }),
    },
  });
  const candidate = cohort.candidates[0];
  if (!candidate) throw new Error("application repair launch candidate가 없습니다.");
  const sourceEvidence = candidate.sourceArtifact.localLabEvidence?.analysisLaunch;
  if (!sourceEvidence) throw new Error("application repair launch source evidence가 없습니다.");
  const preparedBundle = await prepareAnalysisLaunchPromotionApplicationPrecomputeBundle({
    releaseId: input.releaseId,
    labRun: candidate.source.run,
    sourceEvidence,
    runArtifactSha256: candidate.sourceArtifact.runSha256,
  });
  if (!preparedBundle) throw new Error("application repair precompute bundle이 없습니다.");
  const roundtripArtifacts = await readRoundtripRunArtifacts(
    input.grantId,
    preparedBundle.evidence.roundtripRunId!,
  );
  if (!roundtripArtifacts) throw new Error("application repair roundtrip artifact가 없습니다.");
  const materializationPlan = await loadGrantApplicationPrecomputePlan({
    grantId: input.grantId,
    parentLabRunId: candidate.source.run.runId,
    db: input.db,
    roundtripArtifacts,
  });
  if (!materializationPlan) throw new Error("application repair materialization plan이 없습니다.");
  const sourceArtifact = {
    ...candidate.sourceArtifact,
    applicationPrecompute: preparedBundle.evidence,
  };
  const before = await loadApplicationFieldRepairSnapshot(input.db, input.grantId);
  if (before.fields.length !== 0) throw new Error("application repair 준비 시 fieldCount가 0이 아닙니다.");
  const parent = await loadCurrentApplicationFieldRepairParent(input.db, input.grantId);
  const manifest = createApplicationFieldRepairReleaseManifest({
    releaseId: input.releaseId,
    revision: input.revision,
    createdAt: new Date().toISOString(),
    gitCommit: input.gitCommit,
    buildDigest: input.buildDigest,
    cohortLabel: input.cohortLabel,
    repair: {
      grantId: input.grantId,
      parent,
      inventory: {
        policy: APPLICATION_FIELD_REPAIR_INVENTORY_POLICY,
        seriesId: launch.inventory.seriesId,
        inventorySha256: launch.inventorySha256,
        launchManifestSha256: launch.receipt.manifestSha256,
        launchReceiptSha256: input.launchReceiptSha256,
      },
      sourceArtifact,
      readiness: candidate.readiness,
      beforeApplicationSnapshotSha256: applicationFieldRepairSnapshotSha256(before),
      fieldCountBefore: 0,
      expectedFieldCount: candidate.readiness.recognizedFieldCount,
      expectedMaterializableSurfaceCount: preparedBundle.evidence.materializableDocumentCount,
      materializationPlanSha256: grantApplicationPrecomputePlanSha256(materializationPlan),
    },
  });
  return { manifest, before, preparedBundle, materializationPlan };
}

async function inspect(): Promise<number> {
  const db = getCunoteDb();
  const grantId = exactSingleGrantId();
  const launchReceiptSha256 = exactLaunchReceipt();
  const built = await buildRepairManifest({
    releaseId: `inspect-application-field-repair-${Date.now()}`,
    revision: 1,
    cohortLabel: "application-field-repair-inspect",
    gitCommit: "read-only-inspect",
    buildDigest: "read-only-inspect",
    launchReceiptSha256,
    grantId,
    db,
  });
  console.log(JSON.stringify({
    verdict: "READY",
    grantId,
    launchReceiptSha256,
    parentPromotionItemId: built.manifest.repair.parent.promotionItemId,
    currentPromotionStateSha256: built.manifest.repair.parent.afterSha256,
    beforeApplicationSnapshotSha256: built.manifest.repair.beforeApplicationSnapshotSha256,
    fieldCountBefore: built.manifest.repair.fieldCountBefore,
    expectedFieldCount: built.manifest.repair.expectedFieldCount,
    expectedMaterializableSurfaceCount: built.manifest.repair.expectedMaterializableSurfaceCount,
  }, null, 2));
  return 0;
}

async function prepare(): Promise<number> {
  const db = getCunoteDb();
  const grantId = exactSingleGrantId();
  const launchReceiptSha256 = exactLaunchReceipt();
  const actor = readArg("actor")?.trim();
  if (!actor) throw new Error("--actor에 준비자 식별자가 필요합니다.");
  const build = readPromotionBuildProvenance();
  const releaseId = readArg("release")?.trim()
    || `application-field-repair-r1-${new Date().toISOString().replace(/[-:.]/gu, "").slice(0, 15)}-${build.gitCommit.slice(0, 8)}`;
  const built = await buildRepairManifest({
    releaseId,
    revision: Number(readArg("revision") ?? "1"),
    cohortLabel: readArg("cohort")?.trim() || "current-missing-field-repair",
    gitCommit: build.gitCommit,
    buildDigest: build.buildDigest,
    launchReceiptSha256,
    grantId,
    db,
  });
  await assertApplicationFieldRepairAdmission({ db, manifest: built.manifest, expectedSnapshot: built.before });
  await writePreparedPromotionApplicationPrecomputeBundle(built.preparedBundle);
  await writeImmutablePromotionArtifact(
    promotionReleaseArtifactPath(releaseId, "manifest.json"),
    built.manifest,
  );
  await prepareApplicationFieldRepairReleaseLedger({
    db,
    manifest: built.manifest,
    createdBy: actor,
    beforeSnapshot: built.before,
  });
  console.log(`[field-repair] 준비 완료: ${releaseId}`);
  console.log(`[field-repair] manifest: ${built.manifest.manifestSha256}`);
  console.log(`[field-repair] fields: 0 -> ${built.manifest.repair.expectedFieldCount}`);
  return 0;
}

async function verifyManifestCurrent(manifest: ApplicationFieldRepairReleaseManifest, db: CunoteDb) {
  await loadExactLaunchInventoryBinding(
    manifest.repair.inventory.launchReceiptSha256,
    manifest.repair.grantId,
  );
  const sourceDrift = await verifyPromotionReleaseSources([manifest.repair.sourceArtifact]);
  if (sourceDrift.length > 0) throw new Error(`application repair source drift: ${sourceDrift.join(",")}`);
  const before = await assertApplicationFieldRepairAdmission({ db, manifest });
  return { before, sourceDrift };
}

function artifactBinding(
  manifest: ApplicationFieldRepairReleaseManifest,
): ApplicationFieldRepairArtifactBinding {
  return {
    releaseKind: manifest.releaseKind,
    releaseId: manifest.releaseId,
    releasePlanSha256: manifest.releasePlanSha256,
    manifestSha256: manifest.manifestSha256,
    grantId: manifest.repair.grantId,
    parentPromotionItemId: manifest.repair.parent.promotionItemId,
  };
}

function assertReleaseLedgerManifest(input: {
  manifestSha256: string;
  releasePlanSha256: string;
  manifest: unknown;
  gitCommit: string;
  buildDigest: string;
}, manifest: ApplicationFieldRepairReleaseManifest): void {
  if (
    input.manifestSha256 !== manifest.manifestSha256
    || input.releasePlanSha256 !== manifest.releasePlanSha256
    || sha256Canonical(input.manifest) !== sha256Canonical(manifest)
    || input.gitCommit !== manifest.gitCommit
    || input.buildDigest !== manifest.buildDigest
  ) {
    throw new Error("application repair DB release manifest provenance가 다릅니다.");
  }
}

async function loadExactReviewedCandidate(manifest: ApplicationFieldRepairReleaseManifest) {
  const cohort = await loadAnalysisLaunchPromotionCohort({
    launchReceiptSha256s: [manifest.repair.inventory.launchReceiptSha256],
    grantIds: [manifest.repair.grantId],
    dependencies: {
      loadCurrentGrantEvidence: async (run) => ({
        ...await loadCurrentGrantEvidence(run, new Date()),
        hasPromotionItem: false,
      }),
    },
  });
  const candidate = cohort.candidates[0];
  if (cohort.candidates.length !== 1 || !candidate) {
    throw new Error("application repair 독립검수 candidate가 exact 1건이 아닙니다.");
  }
  const expectedSourceArtifact = {
    ...candidate.sourceArtifact,
    applicationPrecompute: manifest.repair.sourceArtifact.applicationPrecompute,
  };
  if (
    sha256Canonical(expectedSourceArtifact) !== sha256Canonical(manifest.repair.sourceArtifact)
    || sha256Canonical(candidate.readiness) !== sha256Canonical(manifest.repair.readiness)
  ) {
    throw new Error("application repair 독립검수 candidate provenance가 manifest와 다릅니다.");
  }
  return candidate;
}

async function writeBoundGate(input: {
  manifest: ApplicationFieldRepairReleaseManifest;
  name: ApplicationFieldRepairGateName;
  expectation: ApplicationFieldRepairGateExpectation;
}): Promise<number> {
  const { manifest } = input;
  const value = {
    schema: input.expectation.schema,
    ...artifactBinding(manifest),
    createdAt: new Date().toISOString(),
    matchingMutationCount: 0,
    ...input.expectation.evidence,
    verdict: input.expectation.verdict,
  };
  validateApplicationFieldRepairGateArtifact({
    value,
    binding: artifactBinding(manifest),
    expectation: input.expectation,
  });
  await writeImmutablePromotionArtifact(
    promotionReleaseArtifactPath(manifest.releaseId, input.name),
    value,
  );
  console.log(`[field-repair] ${input.name} ${input.expectation.verdict}: ${manifest.releaseId}`);
  return 0;
}

async function aggregate(): Promise<number> {
  const releaseId = exactReleaseId();
  const manifest = await readApplicationFieldRepairReleaseManifest(releaseId);
  const db = getCunoteDb();
  await verifyManifestCurrent(manifest, db);
  const candidate = await loadExactReviewedCandidate(manifest);
  const review = candidate.sourceArtifact.localLabEvidence?.analysisLaunch;
  if (!review) throw new Error("application repair 독립검수 evidence가 없습니다.");
  return writeBoundGate({
    manifest,
    name: "aggregate.json",
    expectation: aggregateExpectation(manifest),
  });
}

async function shadow(): Promise<number> {
  const releaseId = exactReleaseId();
  const manifest = await readApplicationFieldRepairReleaseManifest(releaseId);
  const db = getCunoteDb();
  const parentBefore = await loadCurrentApplicationFieldRepairParent(db, manifest.repair.grantId);
  const applicationBefore = await loadApplicationFieldRepairSnapshot(db, manifest.repair.grantId);
  await verifyManifestCurrent(manifest, db);
  const parentAfter = await loadCurrentApplicationFieldRepairParent(db, manifest.repair.grantId);
  const applicationAfter = await loadApplicationFieldRepairSnapshot(db, manifest.repair.grantId);
  const parentBeforeSha256 = sha256Canonical(parentBefore);
  const parentAfterSha256 = sha256Canonical(parentAfter);
  const applicationBeforeSha256 = applicationFieldRepairSnapshotSha256(applicationBefore);
  const applicationAfterSha256 = applicationFieldRepairSnapshotSha256(applicationAfter);
  if (
    parentBeforeSha256 !== parentAfterSha256
    || applicationBeforeSha256 !== applicationAfterSha256
    || applicationBeforeSha256 !== manifest.repair.beforeApplicationSnapshotSha256
  ) {
    throw new Error("application repair shadow read 사이에 parent/application 상태가 변경됐습니다.");
  }
  return writeBoundGate({
    manifest,
    name: "shadow.json",
    expectation: shadowExpectation(manifest),
  });
}

async function dryRun(): Promise<number> {
  const releaseId = exactReleaseId();
  const manifest = await readApplicationFieldRepairReleaseManifest(releaseId);
  const db = getCunoteDb();
  const { before } = await verifyManifestCurrent(manifest, db);
  const artifacts = await readBundledPromotionApplicationPrecompute(
    manifest.repair.sourceArtifact.applicationPrecompute!,
  );
  const plan = await loadGrantApplicationPrecomputePlan({
    grantId: manifest.repair.grantId,
    parentLabRunId: manifest.repair.sourceArtifact.runId,
    db,
    roundtripArtifacts: artifacts,
  });
  if (!plan) throw new Error("application repair dry-run materialization plan이 없습니다.");
  const materializable = plan.surfaces.filter((surface) =>
    surface.status === "complete" || surface.status === "partial");
  const fieldCount = materializable.reduce((total, surface) => total + surface.fields.length, 0);
  const terminalSurfaceCount = plan.surfaces.length - materializable.length;
  if (
    grantApplicationPrecomputePlanSha256(plan) !== manifest.repair.materializationPlanSha256
    || before.fields.length !== 0
    || materializable.length !== manifest.repair.expectedMaterializableSurfaceCount
    || fieldCount !== manifest.repair.expectedFieldCount
    || materializable.some((surface) => surface.fields.length === 0)
  ) {
    throw new Error("application repair dry-run plan/count/protected 검증이 실패했습니다.");
  }
  return writeBoundGate({
    manifest,
    name: "dry-run.json",
    expectation: dryRunExpectation(manifest, {
      surfaceCount: plan.surfaces.length,
      terminalSurfaceCount,
    }),
  });
}

async function approve(): Promise<number> {
  const releaseId = exactReleaseId();
  const actor = readArg("actor")?.trim();
  if (!actor) throw new Error("--actor에 승인자 식별자가 필요합니다.");
  const manifest = await readApplicationFieldRepairReleaseManifest(releaseId);
  assertConfirmation(manifest);
  const build = readPromotionBuildProvenance();
  if (build.gitCommit !== manifest.gitCommit || build.buildDigest !== manifest.buildDigest) {
    throw new Error("application repair 승인 checkout이 manifest build와 다릅니다.");
  }
  const gates = await Promise.all([
    readGate(releaseId, "aggregate.json", manifest),
    readGate(releaseId, "shadow.json", manifest),
    readGate(releaseId, "dry-run.json", manifest),
  ]);
  const db = getCunoteDb();
  await verifyManifestCurrent(manifest, db);
  const [release] = await db.select().from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId)).limit(1);
  if (!release || release.status !== "prepared") throw new Error("application repair release가 prepared가 아닙니다.");
  assertReleaseLedgerManifest(release, manifest);
  if (release.createdBy === actor) throw new Error("application repair 준비자와 승인자는 달라야 합니다.");
  const approval = {
    schema: APPLICATION_FIELD_REPAIR_APPROVAL_SCHEMA,
    releaseKind: manifest.releaseKind,
    releaseId,
    releasePlanSha256: manifest.releasePlanSha256,
    manifestSha256: manifest.manifestSha256,
    aggregateSha256: gates[0].sha256,
    shadowSha256: gates[1].sha256,
    dryRunSha256: gates[2].sha256,
    approvedBy: actor,
    approvedAt: new Date().toISOString(),
  };
  const path = promotionReleaseArtifactPath(releaseId, "approval.json");
  await writeImmutablePromotionArtifact(path, approval);
  const approvalSha256 = await hashFile(path);
  const updated = await db.update(schema.analysisLabPromotionReleases).set({
    status: "approved",
    approvedBy: actor,
    approvedAt: new Date(approval.approvedAt),
    approvalArtifactSha256: approvalSha256,
    gateSummary: {
      aggregateSha256: gates[0].sha256,
      shadowSha256: gates[1].sha256,
      dryRunSha256: gates[2].sha256,
    },
  }).where(and(
    eq(schema.analysisLabPromotionReleases.id, release.id),
    eq(schema.analysisLabPromotionReleases.status, "prepared"),
  )).returning({ id: schema.analysisLabPromotionReleases.id });
  if (updated.length !== 1) throw new Error("application repair 승인 CAS가 실패했습니다.");
  console.log(`[field-repair] 승인 완료: ${releaseId}`);
  return 0;
}

async function write(): Promise<number> {
  const releaseId = exactReleaseId();
  const actor = readArg("actor")?.trim();
  if (!actor) throw new Error("--actor에 실행자 식별자가 필요합니다.");
  const manifest = await readApplicationFieldRepairReleaseManifest(releaseId);
  assertConfirmation(manifest);
  const build = readPromotionBuildProvenance();
  if (build.gitCommit !== manifest.gitCommit || build.buildDigest !== manifest.buildDigest) {
    throw new Error("application repair 실행 checkout이 manifest build와 다릅니다.");
  }
  const db = getCunoteDb();
  const [release] = await db.select().from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId)).limit(1);
  if (!release) throw new Error("application repair release 원장이 없습니다.");
  assertReleaseLedgerManifest(release, manifest);
  const [repair] = await db.select({
    status: schema.analysisLabApplicationFieldRepairs.status,
    servingStateSha256: schema.analysisLabApplicationFieldRepairs.servingStateSha256,
  }).from(schema.analysisLabApplicationFieldRepairs)
    .where(eq(schema.analysisLabApplicationFieldRepairs.releaseDbId, release.id)).limit(1);
  if (!repair) throw new Error("application repair item 원장이 없습니다.");
  const gates = await Promise.all([
    readGate(releaseId, "aggregate.json", manifest),
    readGate(releaseId, "shadow.json", manifest),
    readGate(releaseId, "dry-run.json", manifest),
  ]);
  const approvalPath = promotionReleaseArtifactPath(releaseId, "approval.json");
  const approval = JSON.parse(await readFile(approvalPath, "utf8")) as unknown;
  validateApplicationFieldRepairApprovalArtifact({
    value: approval,
    artifactSha256: await hashFile(approvalPath),
    binding: artifactBinding(manifest),
    ledger: release,
    gateSha256s: {
      aggregateSha256: gates[0].sha256,
      shadowSha256: gates[1].sha256,
      dryRunSha256: gates[2].sha256,
    },
    executingActor: actor,
  });
  if (release.status === "canary_passed") {
    if (repair.status !== "applied" || !repair.servingStateSha256) {
      throw new Error("application repair canary receipt가 불완전합니다.");
    }
    const verificationAttempt = parseVerificationAttempt(
      readArg("verification-attempt")?.trim(),
      true,
    );
    await assertPreviousVerificationAttemptFailed({
      manifest,
      scope: "canary",
      attempt: verificationAttempt,
    });
    await readVerificationReceipt({
      manifest,
      scope: "canary",
      attempt: verificationAttempt,
      verdict: "PASS",
      expectedServingStateSha256: repair.servingStateSha256,
    });
  }
  if (release.status === "approved") await verifyManifestCurrent(manifest, db);
  let staged;
  if (release.status === "approved") {
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("application repair R2 설정이 없습니다.");
    const evidence = manifest.repair.sourceArtifact.applicationPrecompute!;
    const artifacts = await readBundledPromotionApplicationPrecompute(evidence);
    const plan = await loadGrantApplicationPrecomputePlan({
      grantId: manifest.repair.grantId,
      parentLabRunId: manifest.repair.sourceArtifact.runId,
      db,
      roundtripArtifacts: artifacts,
    });
    if (!plan) throw new Error("application repair materialization plan이 없습니다.");
    if (grantApplicationPrecomputePlanSha256(plan) !== manifest.repair.materializationPlanSha256) {
      throw new Error("application repair write materialization plan이 manifest와 다릅니다.");
    }
    staged = await stageGrantApplicationPrecompute({ db, storage, plan });
  }
  const result = await applyApplicationFieldRepairRelease({
    db,
    manifest,
    ...(staged ? { staged } : {}),
    executedBy: actor,
  });
  console.log(`[field-repair] write ${result.releaseStatus}: ${releaseId} · fields ${result.receipt.fields} · replay ${result.replayed}`);
  return 0;
}

async function verify(): Promise<number> {
  const releaseId = exactReleaseId();
  const scope = readArg("scope")?.trim();
  if (scope !== "canary" && scope !== "all") {
    throw new Error("--scope=canary|all이 필요합니다.");
  }
  const attempt = parseVerificationAttempt(readArg("attempt")?.trim());
  const manifest = await readApplicationFieldRepairReleaseManifest(releaseId);
  const db = getCunoteDb();
  const [release] = await db.select({ status: schema.analysisLabPromotionReleases.status })
    .from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId)).limit(1);
  const expectedStatus = scope === "canary" ? "canary_passed" : "active";
  if (release?.status !== expectedStatus) {
    throw new Error(`application repair ${scope} 검증 상태가 다릅니다: ${release?.status ?? "missing"}`);
  }
  await assertPreviousVerificationAttemptFailed({ manifest, scope, attempt });
  const result = await verifyApplicationFieldRepairRelease({ db, manifest });
  const verdict: "PASS" | "FAIL" = result.ok ? "PASS" : "FAIL";
  const artifact = {
    schema: APPLICATION_FIELD_REPAIR_VERIFICATION_SCHEMA,
    releaseKind: manifest.releaseKind,
    releaseId,
    releasePlanSha256: manifest.releasePlanSha256,
    manifestSha256: manifest.manifestSha256,
    createdAt: new Date().toISOString(),
    scope,
    attempt,
    grantId: manifest.repair.grantId,
    expectedFieldCount: manifest.repair.expectedFieldCount,
    currentServingStateSha256: result.currentSha256,
    reasons: result.reasons,
    verdict,
  };
  validateApplicationFieldRepairVerificationArtifact({
    value: artifact,
    binding: artifactBinding(manifest),
    scope,
    attempt,
    expectedFieldCount: manifest.repair.expectedFieldCount,
    verdict: artifact.verdict,
    ...(artifact.verdict === "PASS" && result.currentSha256
      ? { expectedServingStateSha256: result.currentSha256 }
      : {}),
  });
  const path = promotionVerificationArtifactPath(releaseId, scope, attempt);
  await writeImmutablePromotionArtifact(path, artifact);
  console.log(`[field-repair] verify ${artifact.verdict}: ${releaseId} · ${scope} attempt ${attempt}`);
  console.log(`[field-repair] verification sha256: ${await hashFile(path)}`);
  return result.ok ? 0 : 2;
}

async function rollback(): Promise<number> {
  const releaseId = exactReleaseId();
  const actor = readArg("actor")?.trim();
  if (!actor) throw new Error("--actor에 rollback 실행자 식별자가 필요합니다.");
  const manifest = await readApplicationFieldRepairReleaseManifest(releaseId);
  assertConfirmation(manifest);
  await rollbackApplicationFieldRepairRelease({ db: getCunoteDb(), manifest, executedBy: actor });
  console.log(`[field-repair] rollback 완료: ${releaseId}`);
  return 0;
}

async function readGate(
  releaseId: string,
  name: ApplicationFieldRepairGateName,
  manifest: ApplicationFieldRepairReleaseManifest,
) {
  const path = promotionReleaseArtifactPath(releaseId, name);
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  validateApplicationFieldRepairGateArtifact({
    value,
    binding: artifactBinding(manifest),
    expectation: gateExpectation(name, manifest),
  });
  return { sha256: await hashFile(path), value };
}

async function readVerificationReceipt(input: {
  manifest: ApplicationFieldRepairReleaseManifest;
  scope: "canary" | "all";
  attempt: number;
  verdict: "PASS" | "FAIL";
  expectedServingStateSha256?: string;
}) {
  const path = promotionVerificationArtifactPath(
    input.manifest.releaseId,
    input.scope,
    input.attempt,
  );
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  validateApplicationFieldRepairVerificationArtifact({
    value,
    binding: artifactBinding(input.manifest),
    scope: input.scope,
    attempt: input.attempt,
    expectedFieldCount: input.manifest.repair.expectedFieldCount,
    verdict: input.verdict,
    ...(input.expectedServingStateSha256 !== undefined
      ? { expectedServingStateSha256: input.expectedServingStateSha256 }
      : {}),
  });
  return { value, sha256: await hashFile(path) };
}

async function assertPreviousVerificationAttemptFailed(input: {
  manifest: ApplicationFieldRepairReleaseManifest;
  scope: "canary" | "all";
  attempt: number;
}): Promise<void> {
  if (input.attempt === 1) return;
  await readVerificationReceipt({
    manifest: input.manifest,
    scope: input.scope,
    attempt: input.attempt - 1,
    verdict: "FAIL",
  });
}

function aggregateExpectation(
  manifest: ApplicationFieldRepairReleaseManifest,
): ApplicationFieldRepairGateExpectation {
  const review = manifest.repair.sourceArtifact.localLabEvidence!.analysisLaunch!;
  return {
    schema: APPLICATION_FIELD_REPAIR_AGGREGATE_SCHEMA,
    verdict: "GO",
    evidence: {
      independentReviewManifestSha256: review.independentReviewManifestSha256,
      independentReviewAggregateSha256: review.independentReviewAggregateSha256,
      readinessSha256: sha256Canonical(manifest.repair.readiness),
      candidateCount: 1,
      unresolvedDefects: 0,
    },
  };
}

function shadowExpectation(
  manifest: ApplicationFieldRepairReleaseManifest,
): ApplicationFieldRepairGateExpectation {
  const parentSha256 = sha256Canonical(manifest.repair.parent);
  return {
    schema: APPLICATION_FIELD_REPAIR_SHADOW_SCHEMA,
    verdict: "PASS",
    evidence: {
      matchingStateBeforeSha256: parentSha256,
      matchingStateAfterSha256: parentSha256,
      applicationStateBeforeSha256: manifest.repair.beforeApplicationSnapshotSha256,
      applicationStateAfterSha256: manifest.repair.beforeApplicationSnapshotSha256,
      servingParentMutation: false,
    },
  };
}

function dryRunExpectation(
  manifest: ApplicationFieldRepairReleaseManifest,
  observed?: { surfaceCount: number; terminalSurfaceCount: number },
): ApplicationFieldRepairGateExpectation {
  return {
    schema: APPLICATION_FIELD_REPAIR_DRY_RUN_SCHEMA,
    verdict: "PASS",
    evidence: {
      operation: "materialize_application_fields_only",
      materializationPlanSha256: manifest.repair.materializationPlanSha256,
      fieldCountBefore: 0,
      plannedFieldCount: manifest.repair.expectedFieldCount,
      materializableSurfaceCount: manifest.repair.expectedMaterializableSurfaceCount,
      protectedSurfaceCount: 0,
      ...(observed ? observed : {}),
    },
  };
}

function gateExpectation(
  name: ApplicationFieldRepairGateName,
  manifest: ApplicationFieldRepairReleaseManifest,
): ApplicationFieldRepairGateExpectation {
  if (name === "aggregate.json") return aggregateExpectation(manifest);
  if (name === "shadow.json") return shadowExpectation(manifest);
  return dryRunExpectation(manifest);
}

async function main(): Promise<number> {
  if (hasFlag("inspect")) return inspect();
  if (hasFlag("prepare")) return prepare();
  if (hasFlag("aggregate")) return aggregate();
  if (hasFlag("shadow")) return shadow();
  if (hasFlag("dry-run")) return dryRun();
  if (hasFlag("approve")) return approve();
  if (hasFlag("write")) return write();
  if (hasFlag("verify")) return verify();
  if (hasFlag("rollback")) return rollback();
  throw new Error("--inspect|--prepare|--aggregate|--shadow|--dry-run|--approve|--write|--verify|--rollback 중 하나가 필요합니다.");
}

async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 본 결과보다 정리 오류를 우선하지 않는다.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  }).catch(async (error) => {
    console.error("[field-repair] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });
}
