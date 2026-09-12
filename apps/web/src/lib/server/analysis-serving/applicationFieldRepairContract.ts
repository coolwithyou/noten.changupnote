import type { AuthoringFeatureReadiness } from "@cunote/contracts";
import { APPLICATION_ROUNDTRIP_VERSION } from "../application-analysis/contract";
import type { AnalysisLaunchPromotionReadiness } from "../analysis-lab/analysis-launch-promotion";
import type { PromotionApplicationPrecomputeReceipt } from "../analysis-lab/application-precompute-release";
import {
  sha256Canonical,
  type PromotionSourceArtifact,
} from "./promotionReleaseContract";
import { validatePromotionApplicationPrecomputeEvidence } from "./applicationPrecomputeEvidence";

export const APPLICATION_FIELD_REPAIR_RELEASE_SCHEMA =
  "analysis-lab-application-field-repair-release-v1" as const;
export const APPLICATION_FIELD_REPAIR_RELEASE_KIND = "application_field_repair" as const;
export const APPLICATION_FIELD_REPAIR_INVENTORY_POLICY =
  "open-visible-current-period-missing-fields-v1" as const;
export const APPLICATION_FIELD_REPAIR_RECEIPT_SCHEMA =
  "analysis-lab-application-precompute-receipt-v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export interface ApplicationFieldRepairParentBinding {
  releaseDbId: string;
  releaseId: string;
  releaseManifestSha256: string;
  releasePlanSha256: string;
  promotionItemId: string;
  runId: string;
  planSha256: string;
  afterSha256: string;
  appliedAt: string;
}

export interface ApplicationFieldRepairInventoryBinding {
  policy: typeof APPLICATION_FIELD_REPAIR_INVENTORY_POLICY;
  seriesId: string;
  inventorySha256: string;
  launchManifestSha256: string;
  launchReceiptSha256: string;
}

export interface ApplicationFieldRepairPlan {
  grantId: string;
  planSha256: string;
  parent: ApplicationFieldRepairParentBinding;
  inventory: ApplicationFieldRepairInventoryBinding;
  sourceArtifact: PromotionSourceArtifact;
  readiness: AnalysisLaunchPromotionReadiness;
  beforeApplicationSnapshotSha256: string;
  fieldCountBefore: 0;
  expectedFieldCount: number;
  expectedMaterializableSurfaceCount: number;
  materializationPlanSha256: string;
}

export interface ApplicationFieldRepairReleaseManifestBody {
  schema: typeof APPLICATION_FIELD_REPAIR_RELEASE_SCHEMA;
  releaseKind: typeof APPLICATION_FIELD_REPAIR_RELEASE_KIND;
  releaseId: string;
  revision: number;
  createdAt: string;
  gitCommit: string;
  buildDigest: string;
  cohortLabel: string;
  canaryGrantIds: [string];
  servingProvenance: "verified_local_lab";
  releasePlanSha256: string;
  repair: ApplicationFieldRepairPlan;
}

export interface ApplicationFieldRepairReleaseManifest
  extends ApplicationFieldRepairReleaseManifestBody {
  manifestSha256: string;
}

export interface ApplicationFieldRepairServingRow {
  repairId: string;
  releaseDbId: string;
  releaseId: string;
  releaseStatus: string;
  releaseManifestSha256: string;
  releaseManifest: unknown;
  grantId: string;
  parentPromotionItemId: string;
  roundtripRunId: string;
  applicationFieldAnalysisVersion: string;
  planSha256: string;
  status: string;
  applicationPrecomputeReceipt: unknown;
  servingStateSha256: string | null;
  currentServingStateSha256: string | null;
  appliedAt: Date | null;
}

export function applicationFieldRepairPlanSha256(
  plan: Omit<ApplicationFieldRepairPlan, "planSha256">,
): string {
  return sha256Canonical(plan);
}

export function createApplicationFieldRepairReleaseManifest(input: {
  releaseId: string;
  revision: number;
  createdAt: string;
  gitCommit: string;
  buildDigest: string;
  cohortLabel: string;
  repair: Omit<ApplicationFieldRepairPlan, "planSha256">;
}): ApplicationFieldRepairReleaseManifest {
  const planSha256 = applicationFieldRepairPlanSha256(input.repair);
  const repair: ApplicationFieldRepairPlan = { ...input.repair, planSha256 };
  const body: ApplicationFieldRepairReleaseManifestBody = {
    schema: APPLICATION_FIELD_REPAIR_RELEASE_SCHEMA,
    releaseKind: APPLICATION_FIELD_REPAIR_RELEASE_KIND,
    releaseId: input.releaseId,
    revision: input.revision,
    createdAt: input.createdAt,
    gitCommit: input.gitCommit,
    buildDigest: input.buildDigest,
    cohortLabel: input.cohortLabel,
    canaryGrantIds: [repair.grantId],
    servingProvenance: "verified_local_lab",
    releasePlanSha256: sha256Canonical({ releaseKind: APPLICATION_FIELD_REPAIR_RELEASE_KIND, repair }),
    repair,
  };
  return { ...body, manifestSha256: sha256Canonical(body) };
}

export function validateApplicationFieldRepairReleaseManifest(
  value: unknown,
): ApplicationFieldRepairReleaseManifest {
  if (!value || typeof value !== "object") throw new Error("application repair manifest가 객체가 아닙니다.");
  const manifest = value as Partial<ApplicationFieldRepairReleaseManifest>;
  const repair = manifest.repair;
  if (
    manifest.schema !== APPLICATION_FIELD_REPAIR_RELEASE_SCHEMA
    || manifest.releaseKind !== APPLICATION_FIELD_REPAIR_RELEASE_KIND
    || typeof manifest.releaseId !== "string"
    || !/^[a-z0-9][a-z0-9._-]{5,159}$/u.test(manifest.releaseId)
    || !Number.isSafeInteger(manifest.revision)
    || Number(manifest.revision) < 1
    || typeof manifest.createdAt !== "string"
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || typeof manifest.gitCommit !== "string"
    || !manifest.gitCommit.trim()
    || typeof manifest.buildDigest !== "string"
    || !manifest.buildDigest.trim()
    || typeof manifest.cohortLabel !== "string"
    || !manifest.cohortLabel.trim()
    || manifest.servingProvenance !== "verified_local_lab"
    || !Array.isArray(manifest.canaryGrantIds)
    || manifest.canaryGrantIds.length !== 1
    || !isSha(manifest.releasePlanSha256)
    || !isSha(manifest.manifestSha256)
    || !repair
  ) {
    throw new Error("application repair manifest 형식이 올바르지 않습니다.");
  }
  assertRepairPlan(repair);
  if (manifest.canaryGrantIds[0] !== repair.grantId) {
    throw new Error("application repair canary와 grant가 다릅니다.");
  }
  if (repair.sourceArtifact.applicationPrecompute?.releaseId !== manifest.releaseId) {
    throw new Error("application repair precompute releaseId가 다릅니다.");
  }
  const { manifestSha256: _manifestSha256, ...body } = manifest as ApplicationFieldRepairReleaseManifest;
  if (sha256Canonical(body) !== manifest.manifestSha256) {
    throw new Error("application repair manifest hash가 다릅니다.");
  }
  if (applicationFieldRepairPlanSha256(withoutPlanSha(repair)) !== repair.planSha256) {
    throw new Error("application repair plan hash가 다릅니다.");
  }
  if (
    sha256Canonical({ releaseKind: APPLICATION_FIELD_REPAIR_RELEASE_KIND, repair })
      !== manifest.releasePlanSha256
  ) {
    throw new Error("application repair release plan hash가 다릅니다.");
  }
  return manifest as ApplicationFieldRepairReleaseManifest;
}

/** 제품 serving은 기존 deep item을 유지하고, 이 exact repair가 검증될 때 작성 readiness만 덮는다. */
export function resolveApplicationFieldRepairAuthoringReadiness(
  row: ApplicationFieldRepairServingRow,
): AuthoringFeatureReadiness | null {
  if (
    row.status !== "applied"
    || !row.appliedAt
    || row.releaseStatus !== "active"
  ) return null;
  let manifest: ApplicationFieldRepairReleaseManifest;
  try {
    manifest = validateApplicationFieldRepairReleaseManifest(row.releaseManifest);
  } catch {
    return null;
  }
  const repair = manifest.repair;
  if (
    manifest.manifestSha256 !== row.releaseManifestSha256
    || manifest.releaseId !== row.releaseId
    || repair.grantId !== row.grantId
    || repair.parent.promotionItemId !== row.parentPromotionItemId
    || repair.planSha256 !== row.planSha256
    || repair.sourceArtifact.applicationPrecompute?.roundtripRunId !== row.roundtripRunId
    || repair.sourceArtifact.localLabEvidence?.analysisLaunch?.applicationFieldAnalysisVersion
      !== row.applicationFieldAnalysisVersion
    || !row.servingStateSha256
    || row.servingStateSha256 !== row.currentServingStateSha256
    || !applicationPrecomputeReceiptMatches(row.applicationPrecomputeReceipt, repair)
  ) return null;
  return {
    status: "ready",
    sourceDisposition: repair.readiness.runFeatureReadiness.authoring.sourceDisposition,
  };
}

function assertRepairPlan(repair: ApplicationFieldRepairPlan): void {
  const source = repair.sourceArtifact;
  const evidence = source.localLabEvidence;
  const launch = evidence?.analysisLaunch;
  const application = source.applicationPrecompute;
  const readiness = repair.readiness;
  if (
    !UUID.test(repair.grantId)
    || !isSha(repair.planSha256)
    || !isSha(repair.beforeApplicationSnapshotSha256)
    || repair.fieldCountBefore !== 0
    || !Number.isSafeInteger(repair.expectedFieldCount)
    || repair.expectedFieldCount < 1
    || !Number.isSafeInteger(repair.expectedMaterializableSurfaceCount)
    || repair.expectedMaterializableSurfaceCount < 1
    || !isSha(repair.materializationPlanSha256)
    || repair.inventory.policy !== APPLICATION_FIELD_REPAIR_INVENTORY_POLICY
    || !repair.inventory.seriesId.startsWith("current-field-repair-")
    || !isSha(repair.inventory.inventorySha256)
    || !isSha(repair.inventory.launchManifestSha256)
    || !isSha(repair.inventory.launchReceiptSha256)
    || !UUID.test(repair.parent.releaseDbId)
    || !UUID.test(repair.parent.promotionItemId)
    || !repair.parent.releaseId.trim()
    || !repair.parent.runId.trim()
    || !isSha(repair.parent.releaseManifestSha256)
    || !isSha(repair.parent.releasePlanSha256)
    || !isSha(repair.parent.planSha256)
    || !isSha(repair.parent.afterSha256)
    || !Number.isFinite(Date.parse(repair.parent.appliedAt))
    || source.grantId !== repair.grantId
    || source.runId !== application?.parentLabRunId
    || source.sourceRevisionSha256 !== readiness.sourceRevisionSha256
    || evidence?.reviewMethod !== "analysis_launch_independent_review"
    || evidence.inputSha256 !== readiness.inputSha256
    || !launch
    || launch.launchReceiptSha256 !== readiness.launchReceiptSha256
    || launch.launchReceiptSha256 !== repair.inventory.launchReceiptSha256
    || launch.launchManifestSha256 !== repair.inventory.launchManifestSha256
    || launch.independentReviewAggregateSha256 !== readiness.independentReviewAggregateSha256
    || launch.attachmentManifestSha256 !== readiness.attachmentManifestSha256
    || launch.sourceRevisionSha256 !== readiness.sourceRevisionSha256
    || (readiness.disposition !== "ready" && readiness.disposition !== "conditional")
    || readiness.reasons.length !== 0
    || readiness.runFeatureReadiness.authoring.status !== "ready"
    || readiness.runFeatureReadiness.authoring.sourceDisposition !== "ready"
    || readiness.runFeatureReadiness.authoring.reasons.length !== 0
    || readiness.authoringEvidenceStatus !== "verified"
    || readiness.authoringEvidenceReasons.length !== 0
    || !application
    || application.grantId !== repair.grantId
    || application.releaseId === ""
    || application.roundtripRunId !== readiness.applicationRoundtripRunId
    || application.launchAdmission?.launchReceiptSha256 !== launch.launchReceiptSha256
    || application.launchAdmission?.independentReviewAggregateSha256
      !== launch.independentReviewAggregateSha256
    || application.launchAdmission?.runArtifactSha256 !== source.runSha256
    || application.launchAdmission?.applicationFieldAnalysisVersion
      !== launch.applicationFieldAnalysisVersion
    || launch.applicationFieldAnalysisVersion !== APPLICATION_ROUNDTRIP_VERSION
  ) {
    throw new Error(`application repair exact 결속이 올바르지 않습니다: ${repair.grantId}`);
  }
  validatePromotionApplicationPrecomputeEvidence(application);
}

function applicationPrecomputeReceiptMatches(
  value: unknown,
  repair: ApplicationFieldRepairPlan,
): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<PromotionApplicationPrecomputeReceipt>;
  const evidence = repair.sourceArtifact.applicationPrecompute!;
  return receipt.schema === APPLICATION_FIELD_REPAIR_RECEIPT_SCHEMA
    && receipt.status === evidence.status
    && receipt.roundtripRunId === evidence.roundtripRunId
    && receipt.transport === evidence.transport
    && receipt.model === evidence.model
    && receipt.analysisSha256 === evidence.analysisSha256
    && receipt.manifestSha256 === evidence.manifestSha256
    && Number(receipt.materialized ?? 0) + Number(receipt.reused ?? 0) > 0
    && Number(receipt.fields ?? 0) === repair.expectedFieldCount;
}

function withoutPlanSha(
  repair: ApplicationFieldRepairPlan,
): Omit<ApplicationFieldRepairPlan, "planSha256"> {
  const { planSha256: _planSha256, ...body } = repair;
  return body;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
