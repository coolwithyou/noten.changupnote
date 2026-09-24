import type { CunoteDb } from "../db/client";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";
import type { GrantNextWorkAdapter, GrantNextWorkSnapshot } from "./grantNextWorkExecution";
import {
  applySourceRebindRelease,
  loadApprovedSourceRebindRelease,
  validateSourceRebindReleaseManifest,
  type AppliedSourceRebindResult,
  type SourceRebindReleaseManifest,
} from "./sourceRebindRelease";

export const SOURCE_REBIND_ADAPTER_RECEIPT_SCHEMA = "source-rebind-adapter-receipt-v1" as const;

export interface ApprovedSourceRebindRelease {
  readonly status: "approved" | "applying" | "active";
  readonly manifest: SourceRebindReleaseManifest;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalArtifactSha256: string;
}

export interface SourceRebindReleaseBinding {
  readonly release: ApprovedSourceRebindRelease;
  readonly manifest: SourceRebindReleaseManifest;
  readonly expectedEvidenceSha256: string;
  readonly executedBy: string;
}

export interface SourceRebindReleasePort {
  loadApprovedRelease(input: {
    readonly releaseId: string;
    readonly expectedManifestSha256: string;
    readonly grantId: string;
  }): Promise<ApprovedSourceRebindRelease>;
  applyApprovedRelease(binding: SourceRebindReleaseBinding): Promise<AppliedSourceRebindResult>;
}

/** evidence_refresh만 소비하며 모델 호출 없이 승인된 successor release를 적용한다. */
export function createSourceRebindAdapter(input: {
  readonly releaseId: string;
  readonly expectedManifestSha256: string;
  readonly executedBy: string;
  readonly port: SourceRebindReleasePort;
}): GrantNextWorkAdapter {
  const releaseId = nonEmpty(input.releaseId, "release_id");
  const expectedManifestSha256 = exactSha(input.expectedManifestSha256, "manifest");
  const executedBy = nonEmpty(input.executedBy, "executed_by");
  return {
    action: "source_rebind",
    async execute(execution) {
      if (
        execution.snapshot.nextWork.action !== "source_rebind"
        || execution.snapshot.grantId !== execution.grantId
        || execution.snapshot.evidenceSha256 !== execution.expectedEvidenceSha256
      ) throw new Error("source_rebind_snapshot_mismatch");
      const release = await input.port.loadApprovedRelease({
        releaseId,
        expectedManifestSha256,
        grantId: execution.grantId,
      });
      const binding = bindSourceRebindRelease({
        releaseId,
        expectedManifestSha256,
        executedBy,
        release,
        snapshot: execution.snapshot,
      });
      const applied = await input.port.applyApprovedRelease(binding);
      exactSha(applied.servingStateSha256, "serving_state");
      if (
        !Number.isSafeInteger(applied.reboundQuestionCount)
        || applied.reboundQuestionCount < 0
        || !Number.isSafeInteger(applied.reboundAnswerCount)
        || applied.reboundAnswerCount < 0
      ) throw new Error("source_rebind_apply_count_invalid");
      const receipt = {
        schema: SOURCE_REBIND_ADAPTER_RECEIPT_SCHEMA,
        action: "source_rebind" as const,
        grantId: execution.grantId,
        beforeEvidenceSha256: execution.expectedEvidenceSha256,
        releaseId: binding.manifest.releaseId,
        manifestSha256: binding.manifest.manifestSha256,
        releasePlanSha256: binding.manifest.releasePlanSha256,
        sourceChangeImpactSha256: binding.manifest.sourceChangeImpactSha256,
        previousSourceRevisionSha256: binding.manifest.parent.sourceRevisionSha256,
        currentSourceRevisionSha256: binding.manifest.source.currentRevisionSha256,
        currentMaterialSourceRevisionSha256:
          binding.manifest.source.currentMaterialRevisionSha256,
        approvalArtifactSha256: binding.release.approvalArtifactSha256,
        executedBy,
        servingStateSha256: applied.servingStateSha256,
        reboundQuestionCount: applied.reboundQuestionCount,
        reboundAnswerCount: applied.reboundAnswerCount,
        replayed: applied.replayed,
        modelCalls: 0,
        externalWrites: applied.replayed ? 0 : 1,
      };
      return {
        action: "source_rebind",
        receiptSha256: sha256Canonical(receipt),
        modelCalls: 0,
        externalWrites: applied.replayed ? 0 : 1,
      };
    },
  };
}

export function bindSourceRebindRelease(input: {
  readonly releaseId: string;
  readonly expectedManifestSha256: string;
  readonly executedBy: string;
  readonly release: ApprovedSourceRebindRelease;
  readonly snapshot: GrantNextWorkSnapshot;
}): SourceRebindReleaseBinding {
  if (input.release.status !== "approved" && input.release.status !== "applying" && input.release.status !== "active") {
    throw new Error("source_rebind_release_not_approved");
  }
  nonEmpty(input.release.approvedBy, "approved_by");
  if (input.release.approvedBy === nonEmpty(input.executedBy, "executed_by")) {
    throw new Error("source_rebind_actor_separation_required");
  }
  canonicalIso(input.release.approvedAt, "approved_at");
  exactSha(input.release.approvalArtifactSha256, "approval_artifact");
  const manifest = validateSourceRebindReleaseManifest(input.release.manifest);
  if (
    manifest.releaseId !== input.releaseId
    || manifest.manifestSha256 !== input.expectedManifestSha256
    || manifest.grantId !== input.snapshot.grantId
  ) throw new Error("source_rebind_manifest_mismatch");
  const impact = input.snapshot.sourceChangeImpact;
  const source = input.snapshot.readinessInput.source;
  const analysis = input.snapshot.readinessInput.analysis;
  if (
    input.snapshot.nextWork.action !== "source_rebind"
    || !impact
    || impact.classification !== "evidence_refresh"
    || impact.requiresModelRun !== false
    || impact.changedDomains.length !== 1
    || impact.changedDomains[0] !== "raw"
    || impact.previousRawSha256 !== manifest.source.previousRawSha256
    || impact.currentRawSha256 !== manifest.source.currentRawSha256
    || sha256Canonical(impact) !== manifest.sourceChangeImpactSha256
    || source.rawSha256 !== manifest.source.currentRawSha256
    || source.revisionSha256 !== manifest.source.currentRevisionSha256
    || source.materialRevisionSha256 !== manifest.source.currentMaterialRevisionSha256
    || analysis.sourceRevisionSha256 !== manifest.parent.sourceRevisionSha256
  ) throw new Error("source_rebind_snapshot_binding_mismatch");
  const activeV2 = input.snapshot.readinessInput.questions.filter((question) =>
    !question.invalidated && question.evaluationContractVersion === "confirmation-evaluation-v2");
  if (activeV2.some((question) =>
    question.sourceRevisionSha256 !== manifest.parent.sourceRevisionSha256
    || question.sourceRawSha256 !== manifest.source.previousRawSha256)) {
    throw new Error("source_rebind_question_snapshot_mismatch");
  }
  return Object.freeze({
    release: input.release,
    manifest,
    expectedEvidenceSha256: input.snapshot.evidenceSha256,
    executedBy: input.executedBy,
  });
}

export function createDrizzleSourceRebindPort(input: {
  readonly db: CunoteDb;
}): SourceRebindReleasePort {
  return {
    async loadApprovedRelease(args) {
      const release = await loadApprovedSourceRebindRelease({ db: input.db, ...args });
      if (
        (release.status !== "approved" && release.status !== "applying" && release.status !== "active")
        || !release.approvedBy
        || !release.approvedAt
        || !release.approvalArtifactSha256
      ) throw new Error("source_rebind_release_not_approved");
      return {
        status: release.status,
        manifest: release.manifest,
        approvedBy: release.approvedBy,
        approvedAt: release.approvedAt.toISOString(),
        approvalArtifactSha256: release.approvalArtifactSha256,
      };
    },
    applyApprovedRelease(binding) {
      return applySourceRebindRelease({
        db: input.db,
        manifest: binding.manifest,
        executedBy: binding.executedBy,
        beforeEvidenceSha256: binding.expectedEvidenceSha256,
      });
    },
  };
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`source_rebind_${label}_invalid`);
  return value.trim();
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`source_rebind_${label}_invalid`);
  }
  return value;
}

function canonicalIso(value: string, label: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`source_rebind_${label}_invalid`);
  }
}
