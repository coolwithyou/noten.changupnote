import { createHash } from "node:crypto";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/features/dev/analysis-lab/contract";
import { ANALYSIS_QUALITY_POLICY_VERSION } from "@/features/dev/analysis-lab/quality-contract";
import {
  createDeepRepairExperimentPlan,
  type DeepRepairExperimentPlan,
} from "./deep-repair-experiment";
import type { DeepRepairOperationalEvidence } from "./deep-repair-live-experiment";

type Sha256 = string;

export type DeepRepairAuthorizationErrorCode =
  | "approval_not_found"
  | "approval_invalid"
  | "approval_expired"
  | "proposal_not_found"
  | "proposal_invalid"
  | "plan_not_found"
  | "plan_invalid"
  | "cohort_invalid"
  | "parent_invalid"
  | "parent_not_continuable"
  | "target_drift"
  | "provenance_drift"
  | "operational_evidence_invalid"
  | "runtime_not_paused"
  | "runtime_not_quiescent"
  | "issuance_invalid"
  | "issuance_conflict"
  | "aborted";

export class DeepRepairAuthorizationError extends Error {
  constructor(readonly code: DeepRepairAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "DeepRepairAuthorizationError";
  }
}

export interface DeepRepairAuthorizationStoredArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface DeepRepairAuthorizationRepository {
  readApproval(sha256: Sha256): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readSeriesMarker(seriesId: "deep-v18"): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readProposal(sha256: Sha256): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readPlan(sha256: Sha256): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readCohort(path: string): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readLiveReceipt(sha256: Sha256): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readAttemptStart(
    planSha256: Sha256,
    sequence: number,
  ): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readOperationalEvidence(sha256: Sha256): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readAuthority(sha256: Sha256): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  readIssuance(approvalSha256: Sha256): Promise<DeepRepairAuthorizationStoredArtifact | null>;
  writeOperationalEvidence(sha256: Sha256, bytes: Uint8Array): Promise<void>;
  writeAuthority(sha256: Sha256, bytes: Uint8Array): Promise<void>;
  claimIssuance(approvalSha256: Sha256, bytes: Uint8Array): Promise<boolean>;
}

export interface DeepRepairAuthorizationDependencies {
  readonly repository: DeepRepairAuthorizationRepository;
  readonly now: () => Date;
  readonly createOwnerId: () => string;
  readonly prepareTarget: (input: {
    readonly grantId: string;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly grantId: string;
    readonly inputSha256: Sha256;
    readonly attachmentManifestSha256: Sha256;
  }>;
  readonly readExecutionProvenance: () => Promise<{
    readonly gitSha: string;
    readonly packageRuntimeSha256: Sha256;
    readonly validatorVersion: string;
  }>;
  readonly captureOperationalEvidence: (
    signal: AbortSignal,
  ) => Promise<DeepRepairOperationalEvidence>;
  readonly readRuntimeControl: () => Promise<{
    readonly mode: string;
    readonly generation: number;
    readonly localOwnerId: string | null;
    readonly localLeaseExpiresAt: string | null;
    readonly databaseObservedAt: string;
    readonly activeDeepLeases: number;
    readonly activeApplicationLeases: number;
  }>;
}

export interface DeepRepairAuthorityIssuanceResult {
  readonly kind: "issued" | "inspected";
  readonly authorityId: Sha256;
}

export interface DeepRepairAuthorityIssuer {
  issueApprovedDeepRepairAuthority(input: {
    readonly approvalId: string;
    readonly signal: AbortSignal;
  }): Promise<DeepRepairAuthorityIssuanceResult>;
}

interface UserApproval {
  readonly schema: "deep-repair-user-approval-v1";
  readonly proposalSha256: Sha256;
  readonly planSha256: Sha256;
  readonly planArtifactSha256: Sha256;
  readonly parentReceiptSha256: Sha256 | null;
  readonly sequence: number;
  readonly waveId: string;
  readonly grantId: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly stopAfter: "one-target";
}

interface ExecutionAuthority {
  readonly schema: "deep-repair-execution-authority-v1";
  readonly attemptId: string;
  readonly planSha256: Sha256;
  readonly planArtifactSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly parentReceiptSha256: Sha256 | null;
  readonly sequence: number;
  readonly waveId: string;
  readonly cohortSha256: Sha256;
  readonly grantId: string;
  readonly inputSha256: Sha256;
  readonly attachmentManifestSha256: Sha256;
  readonly lane: "deep-primary";
  readonly transport: "claude-cli";
  readonly model: string;
  readonly promptVersion: string;
  readonly validatorVersion: string;
  readonly qualityPolicyVersion: string;
  readonly runtime: {
    readonly ownerId: string;
    readonly expectedGeneration: number;
    readonly databaseObservedAt: string;
    readonly activeDeepLeases: 0;
    readonly activeApplicationLeases: 0;
  };
  readonly operationalEvidenceSha256: Sha256;
  readonly approvalSha256: Sha256;
}

interface IssuanceMarker {
  readonly schema: "deep-repair-authority-issuance-v1";
  readonly approvalSha256: Sha256;
  readonly operationalEvidenceSha256: Sha256;
  readonly authoritySha256: Sha256;
}

interface SeriesProposalMarker {
  readonly schema: "deep-repair-series-proposal-v1";
  readonly seriesId: "deep-v18";
  readonly proposalPath: string;
  readonly proposalSha256: Sha256;
  readonly planSha256: Sha256;
  readonly planArtifactSha256: Sha256;
  readonly manifestSha256: Sha256;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_APPROVAL_TTL_MS = 15 * 60_000;
const MAX_OPERATIONAL_EVIDENCE_TTL_MS = 15 * 60_000;
const PREPARATION_SEED = 20260814;
const PREPARATION_TARGET_COUNT = 30;
const PREPARATION_WAVE_SIZE = 15;

/** 승인 SHA 하나만 받아 exact-next 단건 authority를 발급한다. */
export function createDeepRepairAuthorityIssuer(
  dependencies: DeepRepairAuthorizationDependencies,
): DeepRepairAuthorityIssuer {
  return {
    async issueApprovedDeepRepairAuthority(input) {
      const approvalSha256 = requireSha(input.approvalId, "approvalId", "approval_invalid");
      throwIfAborted(input.signal);
      const approvalArtifact = await dependencies.repository.readApproval(approvalSha256);
      if (approvalArtifact === null) {
        throw failure("approval_not_found", `승인 artifact를 찾지 못했습니다: ${approvalSha256}`);
      }
      if (rawSha256(approvalArtifact.bytes) !== approvalSha256) {
        throw failure("approval_invalid", "승인 artifact raw SHA-256이 approvalId와 다릅니다.");
      }
      // Content hash는 승인 내용의 무결성만 보장한다. approvedBy의 인증된 신원과 실제
      // 승인 행위는 이 issuer 바깥의 사용자 승인 artifact 발급 경계가 보장해야 한다.
      const approval = normalizeApproval(parseJson(approvalArtifact, "approval"));

      const existing = await dependencies.repository.readIssuance(approvalSha256);
      if (existing === null) assertApprovalCurrent(approval, dependencies.now());

      const seriesMarkerArtifact = await dependencies.repository.readSeriesMarker("deep-v18");
      if (seriesMarkerArtifact === null) {
        throw failure("proposal_not_found", "deep-v18 final series commit marker를 찾지 못했습니다.");
      }
      const seriesMarker = normalizeSeriesMarker(seriesMarkerArtifact);
      if (
        seriesMarker.proposalSha256 !== approval.proposalSha256
        || seriesMarker.planSha256 !== approval.planSha256
        || seriesMarker.planArtifactSha256 !== approval.planArtifactSha256
      ) {
        throw failure("proposal_invalid", "final series marker가 승인 proposal/plan과 다릅니다.");
      }

      const proposalArtifact = await dependencies.repository.readProposal(approval.proposalSha256);
      if (proposalArtifact === null) {
        throw failure("proposal_not_found", `proposal commit marker를 찾지 못했습니다: ${approval.proposalSha256}`);
      }
      if (rawSha256(proposalArtifact.bytes) !== approval.proposalSha256) {
        throw failure("proposal_invalid", "proposal commit marker raw SHA-256이 승인과 다릅니다.");
      }
      if (proposalArtifact.path !== seriesMarker.proposalPath) {
        throw failure("proposal_invalid", "proposal artifact path가 final series marker와 다릅니다.");
      }
      const proposal = normalizeProposal(parseJson(proposalArtifact, "proposal"));

      const planArtifact = await dependencies.repository.readPlan(approval.planSha256);
      if (planArtifact === null) {
        throw failure("plan_not_found", `formal plan을 찾지 못했습니다: ${approval.planSha256}`);
      }
      if (rawSha256(planArtifact.bytes) !== approval.planArtifactSha256) {
        throw failure("plan_invalid", "plan artifact raw SHA-256이 승인과 다릅니다.");
      }
      const plan = normalizePlan(parseJson(planArtifact, "plan"), approval.planSha256);
      if (seriesMarker.manifestSha256 !== plan.manifestSha256) {
        throw failure("proposal_invalid", "final series marker manifest SHA가 plan과 다릅니다.");
      }
      const sealedProvenance = requireCompleteProvenance(plan);
      assertProposalBinding(proposal, approval, plan);
      await validateCohorts(dependencies.repository, plan);

      const nextSequence = await resolveNextSequence(
        dependencies.repository,
        approval,
        plan,
      );
      const target = plan.sequence[nextSequence];
      if (!target) throw failure("parent_invalid", "승인이 plan sequence 범위를 벗어났습니다.");
      assertApprovalBinding(approval, plan, target, nextSequence);
      const committedBeforePreflight = existing
        ?? await dependencies.repository.readIssuance(approvalSha256);
      if (committedBeforePreflight !== null) {
        return inspectIssuance(
          dependencies.repository,
          approval,
          approvalSha256,
          committedBeforePreflight,
          plan,
          target,
        );
      }
      let authoritySha256!: string;
      let marker!: IssuanceMarker;
      try {
        const existingStart = await dependencies.repository.readAttemptStart(plan.planSha256, nextSequence);
        if (existingStart !== null) {
          throw failure("issuance_conflict", "exact plan slot에 이미 start artifact가 있습니다.");
        }

        const prepared = await dependencies.prepareTarget({
          grantId: target.grantId,
          signal: input.signal,
        });
        if (
          prepared.grantId !== target.grantId
          || prepared.inputSha256 !== target.inputSha256
          || prepared.attachmentManifestSha256 !== target.attachmentManifestSha256
        ) {
          throw failure("target_drift", "현재 exact target input/attachment binding이 plan과 다릅니다.");
        }
        throwIfAborted(input.signal);

        const provenance = await dependencies.readExecutionProvenance();
        if (canonicalJson(provenance) !== canonicalJson(sealedProvenance)) {
          throw failure("provenance_drift", "현재 실행 provenance가 formal plan과 다릅니다.");
        }
        throwIfAborted(input.signal);

        const evidence = normalizeOperationalEvidence(
          await dependencies.captureOperationalEvidence(input.signal),
        );
        assertEvidenceCurrent(evidence, dependencies.now());
        throwIfAborted(input.signal);

        // 이 read 뒤에는 DB/gcloud/input/provenance 조회를 다시 하지 않고 immutable write만 수행한다.
        const runtime = await dependencies.readRuntimeControl();
        if (
          runtime.mode !== "paused"
          || !Number.isSafeInteger(runtime.generation)
          || runtime.generation < 1
          || runtime.localOwnerId !== null
          || runtime.localLeaseExpiresAt !== null
        ) {
          throw failure("runtime_not_paused", "runtime 정본이 paused exact generation 상태가 아닙니다.");
        }
        if (
          !Number.isFinite(Date.parse(runtime.databaseObservedAt))
          || runtime.activeDeepLeases !== 0
          || runtime.activeApplicationLeases !== 0
        ) {
          throw failure(
            "runtime_not_quiescent",
            "runtime DB snapshot에 active deep/application lease가 없음을 증명할 수 없습니다.",
          );
        }
        throwIfAborted(input.signal);
        const commitTime = dependencies.now();
        assertApprovalCurrent(approval, commitTime);
        assertEvidenceCurrent(evidence, commitTime);

        const ownerId = dependencies.createOwnerId();
        if (!UUID_V4.test(ownerId)) {
          throw failure("issuance_invalid", "발급 ownerId가 UUID v4가 아닙니다.");
        }
        const wave = plan.manifest.waves.find((candidate) => candidate.waveId === target.waveId)!;
        const evidenceBytes = encodeJson(evidence);
        const evidenceSha256 = rawSha256(evidenceBytes);
        const authority: ExecutionAuthority = {
          schema: "deep-repair-execution-authority-v1",
          attemptId: `deep-v18-${String(nextSequence).padStart(2, "0")}-${approvalSha256.slice(0, 12)}`,
          planSha256: plan.planSha256,
          planArtifactSha256: approval.planArtifactSha256,
          manifestSha256: plan.manifestSha256,
          parentReceiptSha256: approval.parentReceiptSha256,
          sequence: nextSequence,
          waveId: target.waveId,
          cohortSha256: wave.cohort.sha256,
          grantId: target.grantId,
          inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256!,
          lane: "deep-primary",
          transport: "claude-cli",
          model: plan.manifest.policy.model,
          promptVersion: plan.manifest.policy.promptVersion,
          validatorVersion: sealedProvenance.validatorVersion,
          qualityPolicyVersion: plan.manifest.policy.qualityPolicyVersion,
          runtime: {
            ownerId,
            expectedGeneration: runtime.generation,
            databaseObservedAt: runtime.databaseObservedAt,
            activeDeepLeases: 0,
            activeApplicationLeases: 0,
          },
          operationalEvidenceSha256: evidenceSha256,
          approvalSha256,
        };
        const authorityBytes = encodeJson(authority);
        authoritySha256 = rawSha256(authorityBytes);
        marker = {
          schema: "deep-repair-authority-issuance-v1",
          approvalSha256,
          operationalEvidenceSha256: evidenceSha256,
          authoritySha256,
        };

        await dependencies.repository.writeOperationalEvidence(evidenceSha256, evidenceBytes);
        await assertRawReadBack(
          dependencies.repository.readOperationalEvidence(evidenceSha256),
          evidenceSha256,
          "operational evidence",
        );
        await dependencies.repository.writeAuthority(authoritySha256, authorityBytes);
        await assertRawReadBack(
          dependencies.repository.readAuthority(authoritySha256),
          authoritySha256,
          "authority",
        );
        throwIfAborted(input.signal);
        const claimTime = dependencies.now();
        assertApprovalCurrent(approval, claimTime);
        assertEvidenceCurrent(evidence, claimTime);
      } catch (error) {
        const committedDuringPreflight = await dependencies.repository.readIssuance(approvalSha256);
        if (committedDuringPreflight !== null) {
          return inspectIssuance(
            dependencies.repository,
            approval,
            approvalSha256,
            committedDuringPreflight,
            plan,
            target,
          );
        }
        throw error;
      }

      let claimed: boolean;
      try {
        claimed = await dependencies.repository.claimIssuance(
          approvalSha256,
          encodeJson(marker),
        );
      } catch (error) {
        const committedAfterClaimError = await dependencies.repository.readIssuance(approvalSha256);
        if (committedAfterClaimError !== null) {
          return inspectIssuance(
            dependencies.repository,
            approval,
            approvalSha256,
            committedAfterClaimError,
            plan,
            target,
          );
        }
        throw error;
      }
      const committed = await dependencies.repository.readIssuance(approvalSha256);
      if (committed === null) {
        throw failure("issuance_invalid", "issuance commit marker read-back이 없습니다.");
      }
      const inspected = await inspectIssuance(
        dependencies.repository,
        approval,
        approvalSha256,
        committed,
        plan,
        target,
      );
      if (claimed && inspected.authorityId !== authoritySha256) {
        throw failure("issuance_conflict", "claim한 authority와 issuance read-back이 다릅니다.");
      }
      return claimed
        ? { kind: "issued" as const, authorityId: authoritySha256 }
        : inspected;
    },
  };
}

async function inspectIssuance(
  repository: DeepRepairAuthorizationRepository,
  approval: UserApproval,
  approvalSha256: string,
  artifact: DeepRepairAuthorizationStoredArtifact,
  plan: DeepRepairExperimentPlan,
  target: DeepRepairExperimentPlan["sequence"][number],
): Promise<DeepRepairAuthorityIssuanceResult> {
  const marker = normalizeIssuance(parseJson(artifact, "issuance"));
  if (marker.approvalSha256 !== approvalSha256) {
    throw failure("issuance_invalid", "issuance marker가 approval 경로와 다릅니다.");
  }
  const [authorityArtifact, evidenceArtifact] = await Promise.all([
    repository.readAuthority(marker.authoritySha256),
    repository.readOperationalEvidence(marker.operationalEvidenceSha256),
  ]);
  if (
    authorityArtifact === null
    || rawSha256(authorityArtifact.bytes) !== marker.authoritySha256
    || evidenceArtifact === null
    || rawSha256(evidenceArtifact.bytes) !== marker.operationalEvidenceSha256
  ) {
    throw failure("issuance_invalid", "issuance가 exact authority/evidence bytes와 결속되지 않았습니다.");
  }
  const authority = normalizeAuthority(parseJson(authorityArtifact, "authority"));
  const evidence = normalizeOperationalEvidence(parseJson(evidenceArtifact, "operational evidence"));
  const wave = plan.manifest.waves.find((candidate) => candidate.waveId === target.waveId);
  const expectedAttemptId =
    `deep-v18-${String(target.sequence).padStart(2, "0")}-${approvalSha256.slice(0, 12)}`;
  if (
    !wave
    || authority.attemptId !== expectedAttemptId
    || authority.approvalSha256 !== approvalSha256
    || authority.operationalEvidenceSha256 !== marker.operationalEvidenceSha256
    || authority.planSha256 !== approval.planSha256
    || authority.planArtifactSha256 !== approval.planArtifactSha256
    || authority.manifestSha256 !== plan.manifestSha256
    || authority.parentReceiptSha256 !== approval.parentReceiptSha256
    || authority.sequence !== approval.sequence
    || authority.waveId !== approval.waveId
    || authority.cohortSha256 !== wave.cohort.sha256
    || authority.grantId !== approval.grantId
    || authority.inputSha256 !== target.inputSha256
    || authority.attachmentManifestSha256 !== target.attachmentManifestSha256
    || authority.model !== approval.model
    || authority.promptVersion !== approval.promptVersion
    || authority.validatorVersion !== plan.manifest.provenance.validatorVersion
    || authority.qualityPolicyVersion !== plan.manifest.policy.qualityPolicyVersion
    || authority.runtime.expectedGeneration < 1
    || Date.parse(evidence.observedAt) < Date.parse(approval.approvedAt)
    || Date.parse(evidence.observedAt) >= Date.parse(approval.expiresAt)
  ) {
    throw failure("issuance_invalid", "기존 authority가 approval exact binding과 다릅니다.");
  }
  return { kind: "inspected", authorityId: marker.authoritySha256 };
}

async function assertRawReadBack(
  artifactPromise: Promise<DeepRepairAuthorizationStoredArtifact | null>,
  expectedSha256: string,
  label: string,
): Promise<void> {
  const artifact = await artifactPromise;
  if (artifact === null || rawSha256(artifact.bytes) !== expectedSha256) {
    throw failure("issuance_invalid", `${label} immutable write read-back이 다릅니다.`);
  }
}

function normalizeApproval(value: unknown): UserApproval {
  try {
    const source = record(value, "approval");
    const approval: UserApproval = {
      schema: literal(source.schema, "deep-repair-user-approval-v1", "approval.schema"),
      proposalSha256: sha(source.proposalSha256, "approval.proposalSha256"),
      planSha256: sha(source.planSha256, "approval.planSha256"),
      planArtifactSha256: sha(source.planArtifactSha256, "approval.planArtifactSha256"),
      parentReceiptSha256: nullableSha(source.parentReceiptSha256, "approval.parentReceiptSha256"),
      sequence: integer(source.sequence, "approval.sequence"),
      waveId: text(source.waveId, "approval.waveId"),
      grantId: text(source.grantId, "approval.grantId"),
      model: text(source.model, "approval.model"),
      promptVersion: text(source.promptVersion, "approval.promptVersion"),
      approvedBy: text(source.approvedBy, "approval.approvedBy"),
      approvedAt: iso(source.approvedAt, "approval.approvedAt"),
      expiresAt: iso(source.expiresAt, "approval.expiresAt"),
      stopAfter: literal(source.stopAfter, "one-target", "approval.stopAfter"),
    };
    const ttl = Date.parse(approval.expiresAt) - Date.parse(approval.approvedAt);
    if (ttl <= 0 || ttl > MAX_APPROVAL_TTL_MS) throw new Error("approval TTL must be 1..15 minutes");
    if (canonicalJson(value) !== canonicalJson(approval)) throw new Error("approval must be canonical");
    return approval;
  } catch (error) {
    throw failure("approval_invalid", `승인 artifact 형식이 올바르지 않습니다: ${message(error)}`);
  }
}

function normalizePlan(value: unknown, expectedSha256: string): DeepRepairExperimentPlan {
  try {
    const source = record(value, "plan");
    const plan = createDeepRepairExperimentPlan(source.manifest);
    if (
      plan.planSha256 !== expectedSha256
      || canonicalJson(value) !== canonicalJson(plan)
      || plan.manifest.seriesId !== "deep-v18"
      || plan.manifest.mode !== "formal"
      || plan.manifest.formation !== "prospective"
      || plan.manifest.objective !== "deep-primary-repair-rate"
      || plan.manifest.policy.transport !== "claude-cli"
      || plan.manifest.policy.model !== "claude-opus-5"
      || plan.manifest.policy.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION
      || plan.manifest.policy.qualityPolicyVersion !== ANALYSIS_QUALITY_POLICY_VERSION
      || plan.sequence.length !== PREPARATION_TARGET_COUNT
      || plan.manifest.waves.length !== PREPARATION_TARGET_COUNT / PREPARATION_WAVE_SIZE
      || plan.manifest.waves.some(
        (wave) => wave.cohort.seed !== PREPARATION_SEED
          || wave.targets.length !== PREPARATION_WAVE_SIZE,
      )
    ) throw new Error("unsupported or non-canonical plan");
    return plan;
  } catch (error) {
    throw failure("plan_invalid", `formal plan을 재구성할 수 없습니다: ${message(error)}`);
  }
}

function requireCompleteProvenance(plan: DeepRepairExperimentPlan): {
  readonly gitSha: string;
  readonly packageRuntimeSha256: string;
  readonly validatorVersion: string;
} {
  const provenance = plan.manifest.provenance;
  if (
    provenance.status !== "complete"
    || provenance.unavailable.length !== 0
    || provenance.gitSha === null
    || provenance.packageRuntimeSha256 === null
    || provenance.validatorVersion === null
  ) throw failure("plan_invalid", "formal plan execution provenance가 complete가 아닙니다.");
  return {
    gitSha: provenance.gitSha,
    packageRuntimeSha256: provenance.packageRuntimeSha256,
    validatorVersion: provenance.validatorVersion,
  };
}

function normalizeSeriesMarker(
  artifact: DeepRepairAuthorizationStoredArtifact,
): SeriesProposalMarker {
  try {
    if (artifact.path !== "spike-out/analysis-lab/experiments/series/deep-v18.json") {
      throw new Error("unexpected series marker path");
    }
    const source = record(parseJson(artifact, "series marker"), "series marker");
    const normalized: SeriesProposalMarker = {
      schema: literal(source.schema, "deep-repair-series-proposal-v1", "seriesMarker.schema"),
      seriesId: literal(source.seriesId, "deep-v18", "seriesMarker.seriesId"),
      proposalPath: text(source.proposalPath, "seriesMarker.proposalPath"),
      proposalSha256: sha(source.proposalSha256, "seriesMarker.proposalSha256"),
      planSha256: sha(source.planSha256, "seriesMarker.planSha256"),
      planArtifactSha256: sha(
        source.planArtifactSha256,
        "seriesMarker.planArtifactSha256",
      ),
      manifestSha256: sha(source.manifestSha256, "seriesMarker.manifestSha256"),
    };
    if (
      normalized.proposalPath
        !== `spike-out/analysis-lab/experiments/proposals/${normalized.proposalSha256}.json`
      || canonicalJson(source) !== canonicalJson(normalized)
      || Buffer.from(artifact.bytes).toString("utf8") !== `${canonicalJson(normalized)}\n`
    ) throw new Error("series marker must be exact canonical bytes");
    return normalized;
  } catch (error) {
    if (error instanceof DeepRepairAuthorizationError) throw error;
    throw failure("proposal_invalid", `final series commit marker가 올바르지 않습니다: ${message(error)}`);
  }
}

function normalizeProposal(value: unknown): Record<string, unknown> {
  try {
    const proposal = record(value, "proposal");
    literal(proposal.schema, "deep-repair-proposal-v1", "proposal.schema");
    iso(proposal.preparedAt, "proposal.preparedAt");
    record(proposal.policy, "proposal.policy");
    record(proposal.plan, "proposal.plan");
    if (!Array.isArray(proposal.cohorts) || !Array.isArray(proposal.sequence)) {
      throw new Error("proposal cohorts/sequence missing");
    }
    const safety = record(proposal.safety, "proposal.safety");
    literal(safety.artifactKind, "proposal-only", "proposal.safety.artifactKind");
    if (safety.liveExecutionAuthorized !== false) throw new Error("proposal must not authorize live execution");
    literal(safety.authorityScope, "one-authority-one-target", "proposal.safety.authorityScope");
    literal(safety.nextTarget, "new-user-approval-required", "proposal.safety.nextTarget");
    literal(
      safety.continueVerdictAction,
      "new-user-approval-required",
      "proposal.safety.continueVerdictAction",
    );
    const excluded = safety.excludedLanes;
    if (canonicalJson(excluded) !== canonicalJson(["kordoc", "review", "promotion"])) {
      throw new Error("proposal excluded lanes mismatch");
    }
    if (
      canonicalJson(safety.stopVerdicts)
        !== canonicalJson(["GO", "NO_GO", "INCONCLUSIVE", "INVALID"])
      || canonicalJson(proposal.unresolvedGateConditions) !== canonicalJson([
        "current-production-observe-only-evidence",
        "runtime-generation-and-lease",
        "per-target-user-approval-and-authority",
      ])
    ) throw new Error("proposal stop/gate safety mismatch");
    return proposal;
  } catch (error) {
    throw failure("proposal_invalid", `proposal commit marker가 올바르지 않습니다: ${message(error)}`);
  }
}

function assertProposalBinding(
  proposal: Record<string, unknown>,
  approval: UserApproval,
  plan: DeepRepairExperimentPlan,
): void {
  try {
    const policy = record(proposal.policy, "proposal.policy");
    const proposalPlan = record(proposal.plan, "proposal.plan");
    const proposalSequence = (proposal.sequence as unknown[]).map((value, index) => {
      const target = record(value, `proposal.sequence[${index}]`);
      return {
        sequence: integer(target.sequence, `proposal.sequence[${index}].sequence`),
        waveId: text(target.waveId, `proposal.sequence[${index}].waveId`),
        grantId: text(target.grantId, `proposal.sequence[${index}].grantId`),
        inputSha256: sha(target.inputSha256, `proposal.sequence[${index}].inputSha256`),
        attachmentManifestSha256: sha(
          target.attachmentManifestSha256,
          `proposal.sequence[${index}].attachmentManifestSha256`,
        ),
      };
    });
    if (
      proposalPlan.path !== `spike-out/analysis-lab/experiments/plans/${plan.planSha256}.json`
      || proposalPlan.planSha256 !== plan.planSha256
      || proposalPlan.rawSha256 !== approval.planArtifactSha256
      || proposalPlan.manifestSha256 !== plan.manifestSha256
      || policy.seriesId !== "deep-v18"
      || integer(policy.seed, "proposal.policy.seed") !== PREPARATION_SEED
      || integer(policy.targetCount, "proposal.policy.targetCount") !== plan.sequence.length
      || integer(policy.waveSize, "proposal.policy.waveSize") !== PREPARATION_WAVE_SIZE
      || policy.objective !== plan.manifest.objective
      || policy.model !== plan.manifest.policy.model
      || policy.transport !== "claude-cli"
      || policy.promptVersion !== plan.manifest.policy.promptVersion
      || policy.qualityPolicyVersion !== plan.manifest.policy.qualityPolicyVersion
      || policy.gatePolicyVersion !== plan.manifest.policy.gatePolicyVersion
      || Date.parse(text(proposal.preparedAt, "proposal.preparedAt"))
        > Date.parse(approval.approvedAt)
      || canonicalJson(proposal.provenance) !== canonicalJson(plan.manifest.provenance)
      || canonicalJson(proposal.cohorts) !== canonicalJson(plan.manifest.waves.map((wave) => ({
        waveId: wave.waveId,
        path: wave.cohort.artifactPath,
        rawSha256: wave.cohort.sha256,
      })))
      || canonicalJson(proposalSequence) !== canonicalJson(plan.sequence.map((target) => ({
        sequence: target.sequence,
        waveId: target.waveId,
        grantId: target.grantId,
        inputSha256: target.inputSha256,
        attachmentManifestSha256: target.attachmentManifestSha256,
      })))
    ) throw new Error("proposal/plan binding mismatch");
  } catch (error) {
    throw failure("proposal_invalid", `proposal가 exact plan과 결속되지 않았습니다: ${message(error)}`);
  }
}

async function validateCohorts(
  repository: DeepRepairAuthorizationRepository,
  plan: DeepRepairExperimentPlan,
): Promise<void> {
  for (const wave of plan.manifest.waves) {
    const artifact = await repository.readCohort(wave.cohort.artifactPath);
    if (
      artifact === null
      || artifact.path !== wave.cohort.artifactPath
      || rawSha256(artifact.bytes) !== wave.cohort.sha256
    ) throw failure("cohort_invalid", `exact cohort를 읽을 수 없습니다: ${wave.waveId}`);
    try {
      const source = record(parseJson(artifact, "cohort"), "cohort");
      const normalized = {
        schema: literal(source.schema, "deep-repair-cohort-v1", "cohort.schema"),
        seriesId: text(source.seriesId, "cohort.seriesId"),
        waveId: text(source.waveId, "cohort.waveId"),
        selectedAt: iso(source.selectedAt, "cohort.selectedAt"),
        seed: integer(source.seed, "cohort.seed"),
        orderedTargets: Array.isArray(source.orderedTargets)
          ? source.orderedTargets.map((value, index) => {
              const target = record(value, `cohort.orderedTargets[${index}]`);
              return {
                grantId: text(target.grantId, `cohort.orderedTargets[${index}].grantId`),
                stratum: text(target.stratum, `cohort.orderedTargets[${index}].stratum`),
              };
            })
          : [],
      };
      if (
        normalized.seriesId !== plan.manifest.seriesId
        || normalized.waveId !== wave.waveId
        || normalized.selectedAt !== wave.cohort.selectedAt
        || normalized.seed !== wave.cohort.seed
        || canonicalJson(normalized.orderedTargets) !== canonicalJson(
          wave.targets.map((target) => ({ grantId: target.grantId, stratum: target.stratum })),
        )
        || canonicalJson(source) !== canonicalJson(normalized)
      ) throw new Error("cohort binding mismatch");
    } catch (error) {
      throw failure("cohort_invalid", `cohort가 plan과 결속되지 않았습니다: ${message(error)}`);
    }
  }
}

async function resolveNextSequence(
  repository: DeepRepairAuthorizationRepository,
  approval: UserApproval,
  plan: DeepRepairExperimentPlan,
): Promise<number> {
  if (approval.parentReceiptSha256 === null) {
    if (approval.sequence !== 0) throw failure("parent_invalid", "첫 authority sequence는 0이어야 합니다.");
    return 0;
  }
  if (approval.sequence < 1) {
    throw failure("parent_invalid", "parent receipt가 있는 authority sequence는 1 이상이어야 합니다.");
  }
  const seen = new Set<string>();
  let cursor: string | null = approval.parentReceiptSha256;
  let expectedObservedCount = approval.sequence;
  while (cursor !== null) {
    if (seen.has(cursor)) throw failure("parent_invalid", "parent receipt chain에 순환이 있습니다.");
    seen.add(cursor);
    const artifact = await repository.readLiveReceipt(cursor);
    if (artifact === null) throw failure("parent_invalid", `parent receipt ancestry를 찾지 못했습니다: ${cursor}`);
    const receipt = normalizeParentReceipt(parseJson(artifact, "parent receipt"));
    if (
      expectedObservedCount === approval.sequence
      && Date.parse(approval.approvedAt) < Date.parse(receipt.finishedAt)
    ) {
      throw failure(
        "approval_invalid",
        "다음 target 승인은 immediate parent receipt가 완결된 뒤에 생성돼야 합니다.",
      );
    }
    if (
      receipt.receiptSha256 !== cursor
      || receipt.planSha256 !== plan.planSha256
      || receipt.manifestSha256 !== plan.manifestSha256
      || receipt.observedCount !== expectedObservedCount
    ) throw failure("parent_invalid", "parent receipt chain plan/ordinal이 exact prefix와 다릅니다.");
    const expectedTarget = plan.sequence[expectedObservedCount - 1];
    if (
      !expectedTarget
      || receipt.target.sequence !== expectedObservedCount - 1
      || receipt.target.waveId !== expectedTarget.waveId
      || receipt.target.grantId !== expectedTarget.grantId
    ) throw failure("parent_invalid", "parent receipt target이 plan exact prefix와 다릅니다.");
    if (
      receipt.gateVerdict !== "CONTINUE"
      || receipt.nextAction !== "awaiting_user_authority"
      || (receipt.noticeOutcome !== "publishable" && receipt.noticeOutcome !== "held")
    ) throw failure("parent_not_continuable", "parent receipt chain이 exact CONTINUE 상태가 아닙니다.");
    expectedObservedCount -= 1;
    if ((expectedObservedCount === 0) !== (receipt.parentReceiptSha256 === null)) {
      throw failure("parent_invalid", "parent receipt chain이 sequence 0까지 완결되지 않았습니다.");
    }
    cursor = receipt.parentReceiptSha256;
  }
  if (expectedObservedCount !== 0) {
    throw failure("parent_invalid", "parent receipt ancestry가 plan prefix보다 짧습니다.");
  }
  return approval.sequence;
}

function normalizeParentReceipt(value: unknown): {
  receiptSha256: string;
  planSha256: string;
  manifestSha256: string;
  parentReceiptSha256: string | null;
  finishedAt: string;
  noticeOutcome: string;
  gateVerdict: string;
  nextAction: string;
  observedCount: number;
  target: { sequence: number; waveId: string; grantId: string };
} {
  try {
    const source = record(value, "receipt");
    const target = record(source.target, "receipt.target");
    const normalized = {
      schema: literal(source.schema, "deep-repair-live-receipt-v1", "receipt.schema"),
      receiptSha256: sha(source.receiptSha256, "receipt.receiptSha256"),
      planSha256: sha(source.planSha256, "receipt.planSha256"),
      manifestSha256: sha(source.manifestSha256, "receipt.manifestSha256"),
      parentReceiptSha256: nullableSha(source.parentReceiptSha256, "receipt.parentReceiptSha256"),
      authoritySha256: sha(source.authoritySha256, "receipt.authoritySha256"),
      attemptId: text(source.attemptId, "receipt.attemptId"),
      target: {
        sequence: integer(target.sequence, "receipt.target.sequence"),
        waveId: text(target.waveId, "receipt.target.waveId"),
        grantId: text(target.grantId, "receipt.target.grantId"),
      },
      startedAt: iso(source.startedAt, "receipt.startedAt"),
      finishedAt: iso(source.finishedAt, "receipt.finishedAt"),
      lifecycle: literal(source.lifecycle, "finished", "receipt.lifecycle"),
      noticeOutcome: oneOf(
        source.noticeOutcome,
        ["publishable", "held", "failed"] as const,
        "receipt.noticeOutcome",
      ),
      promotionEligibility: literal(
        source.promotionEligibility,
        "not_evaluated",
        "receipt.promotionEligibility",
      ),
      runArtifactPath: nullableText(source.runArtifactPath, "receipt.runArtifactPath"),
      runArtifactSha256: nullableSha(source.runArtifactSha256, "receipt.runArtifactSha256"),
      observationsSha256: nullableSha(source.observationsSha256, "receipt.observationsSha256"),
      evaluatorReceiptSha256: nullableSha(
        source.evaluatorReceiptSha256,
        "receipt.evaluatorReceiptSha256",
      ),
      observedCount: integer(source.observedCount, "receipt.observedCount"),
      gateVerdict: oneOf(
        source.gateVerdict,
        ["CONTINUE", "GO", "NO_GO", "INCONCLUSIVE", "INVALID"] as const,
        "receipt.gateVerdict",
      ),
      nextAction: oneOf(
        source.nextAction,
        ["awaiting_user_authority", "new_user_authority_required", "stopped"] as const,
        "receipt.nextAction",
      ),
      failureCode: nullableText(source.failureCode, "receipt.failureCode"),
    };
    const { receiptSha256, ...body } = normalized;
    if (canonicalSha256(body) !== receiptSha256) throw new Error("receipt hash mismatch");
    if (Date.parse(normalized.finishedAt) < Date.parse(normalized.startedAt)) {
      throw new Error("receipt finishedAt precedes startedAt");
    }
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("receipt must be canonical");
    return normalized;
  } catch (error) {
    throw failure("parent_invalid", `parent receipt가 올바르지 않습니다: ${message(error)}`);
  }
}

function assertApprovalBinding(
  approval: UserApproval,
  plan: DeepRepairExperimentPlan,
  target: DeepRepairExperimentPlan["sequence"][number],
  nextSequence: number,
): void {
  if (
    approval.planSha256 !== plan.planSha256
    || approval.sequence !== nextSequence
    || approval.waveId !== target.waveId
    || approval.grantId !== target.grantId
    || approval.model !== plan.manifest.policy.model
    || approval.promptVersion !== plan.manifest.policy.promptVersion
  ) throw failure("approval_invalid", "승인이 exact next target/policy와 결속되지 않았습니다.");
}

function normalizeOperationalEvidence(value: unknown): DeepRepairOperationalEvidence {
  try {
    const source = record(value, "evidence");
    const normalized: DeepRepairOperationalEvidence = {
      schema: literal(source.schema, "deep-repair-operational-evidence-v1", "evidence.schema"),
      project: literal(source.project, "changupnote-com", "evidence.project"),
      region: literal(source.region, "asia-northeast3", "evidence.region"),
      job: literal(source.job, "cunote-deep-analysis", "evidence.job"),
      workerMode: literal(source.workerMode, "observe_only", "evidence.workerMode"),
      claimScope: literal(source.claimScope, "unconfigured", "evidence.claimScope"),
      jobUid: text(source.jobUid, "evidence.jobUid"),
      jobGeneration: text(source.jobGeneration, "evidence.jobGeneration"),
      jobEtag: text(source.jobEtag, "evidence.jobEtag"),
      jobUpdateTime: rfc3339(source.jobUpdateTime, "evidence.jobUpdateTime"),
      imageDigest: text(source.imageDigest, "evidence.imageDigest"),
      gitCommitSha: text(source.gitCommitSha, "evidence.gitCommitSha"),
      observedAt: iso(source.observedAt, "evidence.observedAt"),
      validUntil: iso(source.validUntil, "evidence.validUntil"),
    };
    const ttl = Date.parse(normalized.validUntil) - Date.parse(normalized.observedAt);
    if (
      !/^\d+$/u.test(normalized.jobGeneration)
      || !/^sha256:[a-f0-9]{64}$/u.test(normalized.imageDigest)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(normalized.gitCommitSha)
      || ttl <= 0
      || ttl > MAX_OPERATIONAL_EVIDENCE_TTL_MS
      || canonicalJson(value) !== canonicalJson(normalized)
    ) throw new Error("non-canonical operational evidence");
    return normalized;
  } catch (error) {
    throw failure("operational_evidence_invalid", `운영 evidence가 올바르지 않습니다: ${message(error)}`);
  }
}

function normalizeAuthority(value: unknown): ExecutionAuthority {
  try {
    const source = record(value, "authority");
    const runtime = record(source.runtime, "authority.runtime");
    const normalized: ExecutionAuthority = {
      schema: literal(source.schema, "deep-repair-execution-authority-v1", "authority.schema"),
      attemptId: text(source.attemptId, "authority.attemptId"),
      planSha256: sha(source.planSha256, "authority.planSha256"),
      planArtifactSha256: sha(source.planArtifactSha256, "authority.planArtifactSha256"),
      manifestSha256: sha(source.manifestSha256, "authority.manifestSha256"),
      parentReceiptSha256: nullableSha(source.parentReceiptSha256, "authority.parentReceiptSha256"),
      sequence: integer(source.sequence, "authority.sequence"),
      waveId: text(source.waveId, "authority.waveId"),
      cohortSha256: sha(source.cohortSha256, "authority.cohortSha256"),
      grantId: text(source.grantId, "authority.grantId"),
      inputSha256: sha(source.inputSha256, "authority.inputSha256"),
      attachmentManifestSha256: sha(source.attachmentManifestSha256, "authority.attachmentManifestSha256"),
      lane: literal(source.lane, "deep-primary", "authority.lane"),
      transport: literal(source.transport, "claude-cli", "authority.transport"),
      model: text(source.model, "authority.model"),
      promptVersion: text(source.promptVersion, "authority.promptVersion"),
      validatorVersion: text(source.validatorVersion, "authority.validatorVersion"),
      qualityPolicyVersion: text(source.qualityPolicyVersion, "authority.qualityPolicyVersion"),
      runtime: {
        ownerId: text(runtime.ownerId, "authority.runtime.ownerId"),
        expectedGeneration: integer(runtime.expectedGeneration, "authority.runtime.expectedGeneration"),
        databaseObservedAt: iso(runtime.databaseObservedAt, "authority.runtime.databaseObservedAt"),
        activeDeepLeases: zero(runtime.activeDeepLeases, "authority.runtime.activeDeepLeases"),
        activeApplicationLeases: zero(
          runtime.activeApplicationLeases,
          "authority.runtime.activeApplicationLeases",
        ),
      },
      operationalEvidenceSha256: sha(source.operationalEvidenceSha256, "authority.operationalEvidenceSha256"),
      approvalSha256: sha(source.approvalSha256, "authority.approvalSha256"),
    };
    if (!UUID_V4.test(normalized.runtime.ownerId)) throw new Error("authority ownerId must be UUID v4");
    if (
      normalized.runtime.activeDeepLeases !== 0
      || normalized.runtime.activeApplicationLeases !== 0
    ) {
      throw new Error("authority runtime active lease counts must both be zero");
    }
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("authority must be canonical");
    return normalized;
  } catch (error) {
    throw failure("issuance_invalid", `authority read-back이 올바르지 않습니다: ${message(error)}`);
  }
}

function normalizeIssuance(value: unknown): IssuanceMarker {
  try {
    const source = record(value, "issuance");
    const normalized: IssuanceMarker = {
      schema: literal(source.schema, "deep-repair-authority-issuance-v1", "issuance.schema"),
      approvalSha256: sha(source.approvalSha256, "issuance.approvalSha256"),
      operationalEvidenceSha256: sha(
        source.operationalEvidenceSha256,
        "issuance.operationalEvidenceSha256",
      ),
      authoritySha256: sha(source.authoritySha256, "issuance.authoritySha256"),
    };
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("issuance must be canonical");
    return normalized;
  } catch (error) {
    throw failure("issuance_invalid", `issuance marker가 올바르지 않습니다: ${message(error)}`);
  }
}

function assertApprovalCurrent(approval: UserApproval, now: Date): void {
  const current = now.getTime();
  if (
    !Number.isFinite(current)
    || Date.parse(approval.approvedAt) > current
    || Date.parse(approval.expiresAt) <= current
  ) throw failure("approval_expired", "승인이 아직 유효하지 않거나 만료됐습니다.");
}

function assertEvidenceCurrent(evidence: DeepRepairOperationalEvidence, now: Date): void {
  const current = now.getTime();
  if (
    !Number.isFinite(current)
    || Date.parse(evidence.observedAt) > current
    || Date.parse(evidence.validUntil) <= current
  ) throw failure("operational_evidence_invalid", "운영 evidence가 아직 유효하지 않거나 만료됐습니다.");
}

function parseJson(artifact: DeepRepairAuthorizationStoredArtifact, label: string): unknown {
  if (!artifact.path.trim() || artifact.bytes.byteLength === 0) {
    throw failure("issuance_invalid", `${label} artifact path/bytes가 없습니다.`);
  }
  try {
    return JSON.parse(Buffer.from(artifact.bytes).toString("utf8"));
  } catch {
    throw failure("issuance_invalid", `${label} JSON을 파싱할 수 없습니다.`);
  }
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be non-empty string`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function sha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be lowercase SHA-256`);
  return result;
}

function requireSha(
  value: unknown,
  label: string,
  code: DeepRepairAuthorizationErrorCode,
): string {
  try {
    return sha(value, label);
  } catch (error) {
    throw failure(code, message(error));
  }
}

function nullableSha(value: unknown, label: string): string | null {
  return value === null ? null : sha(value, label);
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be non-negative integer`);
  return value as number;
}

function zero(value: unknown, label: string): 0 {
  if (value !== 0) throw new Error(`${label} must be zero`);
  return 0;
}

function iso(value: unknown, label: string): string {
  const result = text(value, label);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw new Error(`${label} must be exact ISO timestamp`);
  }
  return result;
}

function rfc3339(value: unknown, label: string): string {
  const result = text(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6}|\.\d{9})?Z$/u.test(result)
    || !Number.isFinite(new Date(result).getTime())
  ) throw new Error(`${label} must be a Z-normalized RFC 3339 timestamp`);
  return result;
}

function literal<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
  return expected;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw failure("aborted", "authority 발급 signal이 중단됐습니다.");
}

function failure(code: DeepRepairAuthorizationErrorCode, detail: string): DeepRepairAuthorizationError {
  return new DeepRepairAuthorizationError(code, detail);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
