import { createHash } from "node:crypto";
import {
  createDeepRepairExperimentPlan,
  type DeepRepairExperimentPlan,
} from "./deep-repair-experiment";
import { validateDeepRepairLiveReceipt } from "./deep-repair-live-receipt";

type Sha256 = string;

export type DeepRepairRecoveryErrorCode =
  | "approval_not_found"
  | "approval_invalid"
  | "approval_expired"
  | "authority_not_found"
  | "authority_invalid"
  | "issuance_not_found"
  | "issuance_invalid"
  | "plan_not_found"
  | "plan_invalid"
  | "attempt_invalid"
  | "attempt_conflict"
  | "attempt_already_recovered"
  | "terminal_already_recorded"
  | "runtime_mismatch"
  | "runtime_not_recoverable"
  | "runtime_recovery_failed"
  | "receipt_invalid"
  | "receipt_commit_failed"
  | "aborted";

export class DeepRepairRecoveryError extends Error {
  constructor(readonly code: DeepRepairRecoveryErrorCode, message: string) {
    super(message);
    this.name = "DeepRepairRecoveryError";
  }
}

export interface DeepRepairRecoveryStoredArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface DeepRepairAttemptRecoveryArtifactReader {
  readRecoveryApproval(sha256: Sha256): Promise<DeepRepairRecoveryStoredArtifact | null>;
  readRecoveryReceipt(sha256: Sha256): Promise<DeepRepairRecoveryStoredArtifact | null>;
}

export interface DeepRepairRecoveryAttemptKey {
  readonly planSha256: Sha256;
  readonly sequence: number;
}

export interface DeepRepairRecoveryRepository {
  readRecoveryApproval(sha256: Sha256): Promise<DeepRepairRecoveryStoredArtifact | null>;
  readAuthority(sha256: Sha256): Promise<DeepRepairRecoveryStoredArtifact | null>;
  readIssuance(approvalSha256: Sha256): Promise<DeepRepairRecoveryStoredArtifact | null>;
  readPlan(planSha256: Sha256): Promise<DeepRepairRecoveryStoredArtifact | null>;
  readLiveReceipt(sha256: Sha256): Promise<DeepRepairRecoveryStoredArtifact | null>;
  readAttempt(key: DeepRepairRecoveryAttemptKey): Promise<{
    readonly claim: DeepRepairRecoveryStoredArtifact | null;
    readonly resolution: DeepRepairRecoveryStoredArtifact | null;
  }>;
  readRuntimeCleanup(key: DeepRepairRecoveryAttemptKey): Promise<DeepRepairRecoveryStoredArtifact | null>;
  readRecoveryReceipt(sha256: Sha256): Promise<DeepRepairRecoveryStoredArtifact | null>;
  writeRecoveryReceipt(sha256: Sha256, bytes: Uint8Array): Promise<void>;
  claimAttemptResolution(key: DeepRepairRecoveryAttemptKey, bytes: Uint8Array): Promise<boolean>;
  claimRuntimeCleanup(key: DeepRepairRecoveryAttemptKey, bytes: Uint8Array): Promise<boolean>;
}

export interface DeepRepairRecoveryRuntimeSnapshot {
  readonly mode: string;
  readonly generation: number;
  readonly localOwnerId: string | null;
  readonly localLeaseExpiresAt: string | null;
  readonly changedBy: string;
  readonly changeReason: string | null;
  readonly updatedAt: string;
}

export interface DeepRepairRecoveryRuntimeAdapter {
  inspect(): Promise<DeepRepairRecoveryRuntimeSnapshot>;
  recoverExpiredLease(input: {
    readonly ownerId: string;
    readonly expectedGeneration: number;
    readonly expectedLeaseExpiresAt: string;
    readonly changeReason: string;
  }): Promise<DeepRepairRecoveryRuntimeSnapshot>;
}

export interface DeepRepairRecoveryDependencies {
  readonly repository: DeepRepairRecoveryRepository;
  readonly runtime: DeepRepairRecoveryRuntimeAdapter;
  readonly now?: () => Date;
}

interface RecoveryTarget {
  readonly sequence: number;
  readonly waveId: string;
  readonly grantId: string;
}

interface MinimalRuntimeSnapshot {
  readonly mode: "paused" | "local_subscription";
  readonly generation: number;
  readonly localOwnerId: string | null;
  readonly localLeaseExpiresAt: string | null;
}

interface RecoveryApproval {
  readonly schema: "deep-repair-recovery-approval-v1";
  readonly authoritySha256: Sha256;
  readonly planSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly seriesId: string;
  readonly attemptId: string;
  readonly target: RecoveryTarget;
  readonly expectedAttempt:
    | { readonly state: "absent"; readonly claimArtifactSha256: null }
    | { readonly state: "present"; readonly claimArtifactSha256: Sha256 }
    | {
        readonly state: "terminal";
        readonly claimArtifactSha256: Sha256;
        readonly resolutionArtifactSha256: Sha256;
      };
  readonly expectedRuntime: MinimalRuntimeSnapshot;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly confirmations: {
    readonly localProcessTerminated: true;
    readonly noAutomaticRetry: true;
    readonly preserveExistingArtifacts: true;
  };
  readonly stopAfter: "recovery-only";
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

interface AuthorityIssuance {
  readonly schema: "deep-repair-authority-issuance-v1";
  readonly approvalSha256: Sha256;
  readonly operationalEvidenceSha256: Sha256;
  readonly authoritySha256: Sha256;
}

interface LiveStart {
  readonly schema: "deep-repair-live-start-v1";
  readonly planSha256: Sha256;
  readonly parentReceiptSha256: Sha256 | null;
  readonly authoritySha256: Sha256;
  readonly attemptId: string;
  readonly target: RecoveryTarget;
  readonly startedAt: string;
}

export interface DeepRepairAttemptRecoveryReceipt {
  readonly schema: "deep-repair-attempt-recovery-v1";
  readonly receiptSha256: Sha256;
  readonly recoveryApprovalSha256: Sha256;
  readonly authoritySha256: Sha256;
  readonly planSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly seriesId: string;
  readonly attemptId: string;
  readonly target: RecoveryTarget;
  readonly observedAttempt: {
    readonly state: "start_persisted_without_terminal";
    readonly claimArtifactSha256: Sha256;
  };
  readonly modelExecution: "unknown";
  readonly runtime: {
    readonly before: MinimalRuntimeSnapshot;
    readonly after: MinimalRuntimeSnapshot;
  };
  readonly seriesDisposition: "stopped";
  readonly statisticalContribution: "none";
  readonly automaticRetryAuthorized: false;
  readonly sameTargetRetryAuthorized: false;
  readonly promotionEligibility: "not_evaluated";
}

export interface DeepRepairRuntimeCleanupReceipt {
  readonly schema: "deep-repair-runtime-cleanup-v1";
  readonly receiptSha256: Sha256;
  readonly recoveryApprovalSha256: Sha256;
  readonly authoritySha256: Sha256;
  readonly planSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly seriesId: string;
  readonly attemptId: string;
  readonly target: RecoveryTarget;
  readonly recoveryKind: "runtime_cleanup";
  readonly observedAttempt:
    | { readonly state: "no_start"; readonly claimArtifactSha256: null; readonly resolutionArtifactSha256: null }
    | {
        readonly state: "terminal";
        readonly claimArtifactSha256: Sha256;
        readonly resolutionArtifactSha256: Sha256;
      };
  readonly modelExecution: "not_started" | "finished";
  readonly runtime: {
    readonly before: MinimalRuntimeSnapshot;
    readonly after: MinimalRuntimeSnapshot;
  };
  readonly seriesDisposition: "unchanged";
  readonly statisticalContribution: "none" | "unchanged";
  readonly automaticRetryAuthorized: false;
  readonly sameTargetRetryAuthorized: false;
  readonly promotionEligibility: "not_evaluated" | "unchanged";
}

export type DeepRepairRecoveryReceipt =
  | DeepRepairAttemptRecoveryReceipt
  | DeepRepairRuntimeCleanupReceipt;

export interface DeepRepairRecoveryInspection {
  readonly authorityId: Sha256;
  readonly planSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly seriesId: string;
  readonly attemptId: string;
  readonly target: RecoveryTarget;
  readonly attempt: {
    readonly state:
      | "no_start"
      | "start_persisted_without_terminal"
      | "recovered"
      | "terminal_recorded";
    readonly claimArtifactSha256: Sha256 | null;
    readonly resolutionArtifactSha256: Sha256 | null;
    readonly modelExecution: "not_started" | "unknown" | "finished";
  };
  readonly runtime: DeepRepairRecoveryRuntimeSnapshot;
  readonly runtimeDisposition:
    | "already_paused"
    | "expired_lease_recovery_required"
    | "blocked";
  readonly disposition:
    | "approval_required"
    | "already_recovered"
    | "terminal_exists"
    | "blocked";
  readonly receipt: DeepRepairRecoveryReceipt | null;
}

export type DeepRepairRecoveryResult =
  | { readonly kind: "recovered"; readonly receipt: DeepRepairRecoveryReceipt }
  | { readonly kind: "inspected"; readonly receipt: DeepRepairRecoveryReceipt };

export interface DeepRepairRecovery {
  inspect(input: { readonly authorityId: string }): Promise<DeepRepairRecoveryInspection>;
  recoverApproved(input: {
    readonly approvalId: string;
    readonly signal: AbortSignal;
  }): Promise<DeepRepairRecoveryResult>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SERIES_PATTERN = /^deep-v([1-9][0-9]*)$/u;
const MAX_APPROVAL_TTL_MS = 15 * 60_000;

/**
 * 비정상 종료된 exact attempt를 닫는 유일한 코어 seam이다. 이 Module은 모델 실행,
 * target 재선정, 기존 artifact 삭제를 노출하지 않는다.
 */
export function createDeepRepairRecovery(
  dependencies: DeepRepairRecoveryDependencies,
): DeepRepairRecovery {
  const now = dependencies.now ?? (() => new Date());

  return {
    async inspect(input) {
      const authorityId = requireSha(input.authorityId, "authorityId", "authority_invalid");
      const context = await loadAuthorityContext(dependencies.repository, authorityId);
      const [attempt, runtime] = await Promise.all([
        readAttemptState(dependencies.repository, context),
        readRuntimeSnapshot(dependencies.runtime),
      ]);
      const runtimeDisposition = classifyRuntime(context.authority, attempt, runtime, now());
      const cleanup = attempt.kind === "no_start" || attempt.kind === "terminal"
        ? await readRuntimeCleanupReceipt(
            dependencies.repository,
            attemptKey(context.authority),
            context,
          )
        : null;
      if (cleanup !== null) {
        if (attempt.kind !== "no_start" && attempt.kind !== "terminal") {
          throw failure("receipt_invalid", "runtime cleanup marker가 cleanup 불가능한 attempt에 존재합니다.");
        }
        assertRuntimeCleanupAttempt(cleanup, attempt);
        return makeInspection(
          context,
          attempt,
          runtime,
          runtimeDisposition,
          "already_recovered",
          cleanup,
        );
      }
      const disposition = attempt.kind === "recovered"
        ? "already_recovered"
        : attempt.kind === "terminal"
          ? "terminal_exists"
          : runtimeDisposition === "blocked"
            ? "blocked"
            : "approval_required";
      return makeInspection(context, attempt, runtime, runtimeDisposition, disposition);
    },

    async recoverApproved(input) {
      const approvalId = requireSha(input.approvalId, "approvalId", "approval_invalid");
      throwIfAborted(input.signal);
      const approval = await loadRecoveryApproval(
        dependencies.repository,
        approvalId,
      );
      const context = await loadAuthorityContext(
        dependencies.repository,
        approval.authoritySha256,
      );
      assertApprovalBinding(approval, context);

      let attempt = await readAttemptState(dependencies.repository, context);
      if (attempt.kind === "recovered") {
        if (attempt.receipt.recoveryApprovalSha256 !== approvalId) {
          throw failure(
            "attempt_already_recovered",
            "exact attempt가 다른 recovery approval로 이미 종결됐습니다.",
          );
        }
        return { kind: "inspected", receipt: attempt.receipt };
      }
      if (attempt.kind === "no_start" || attempt.kind === "terminal") {
        return recoverRuntimeCleanup({
          dependencies,
          now,
          approvalId,
          approval,
          context,
          attempt,
          signal: input.signal,
        });
      }
      assertExpectedAttempt(approval, attempt);

      const changeReason = `deep-repair-recovery:${approvalId}`;
      let runtime = await readRuntimeSnapshot(dependencies.runtime);
      const exactExpectedRuntime = sameMinimalRuntime(
        minimalRuntime(runtime),
        approval.expectedRuntime,
      );
      const partialRuntimeRecovery = isPartialRuntimeRecovery(
        approval,
        context.authority,
        runtime,
        changeReason,
      );
      if (!exactExpectedRuntime && !partialRuntimeRecovery) {
        throw failure(
          "runtime_mismatch",
          "현재 runtime mode/generation/owner/expiry가 recovery approval과 다릅니다.",
        );
      }
      if (!partialRuntimeRecovery) assertApprovalCurrent(approval, now());
      throwIfAborted(input.signal);

      let afterRuntime: DeepRepairRecoveryRuntimeSnapshot;
      if (partialRuntimeRecovery) {
        afterRuntime = runtime;
      } else {
        const runtimeDisposition = classifyRuntime(context.authority, attempt, runtime, now());
        if (runtimeDisposition === "blocked") {
          throw failure(
            "runtime_not_recoverable",
            "승인된 runtime snapshot은 이 attempt에서 안전하게 복구할 수 없습니다.",
          );
        }
        if (runtimeDisposition === "already_paused") {
          afterRuntime = runtime;
        } else {
          const leaseExpiresAt = runtime.localLeaseExpiresAt;
          if (leaseExpiresAt === null) {
            throw failure("runtime_not_recoverable", "만료 lease 시각이 없습니다.");
          }
          try {
            afterRuntime = normalizeRuntimeSnapshot(
              await dependencies.runtime.recoverExpiredLease({
                ownerId: context.authority.runtime.ownerId,
                expectedGeneration: runtime.generation,
                expectedLeaseExpiresAt: leaseExpiresAt,
                changeReason,
              }),
            );
          } catch (error) {
            if (error instanceof DeepRepairRecoveryError) throw error;
            throw failure(
              "runtime_recovery_failed",
              `만료 runtime lease exact CAS에 실패했습니다: ${errorMessage(error)}`,
            );
          }
          assertRecoveredRuntime(runtime, afterRuntime, changeReason);
        }
      }

      // runtime CAS 뒤에는 취소로 빠져나가지 않는다. attempt를 다시 읽고 불변 recovery
      // receipt를 봉인해야 DB만 복구된 중간 상태가 다음 호출에서 동일하게 수렴한다.
      attempt = await readAttemptState(dependencies.repository, context);
      if (attempt.kind === "recovered") {
        if (attempt.receipt.recoveryApprovalSha256 !== approvalId) {
          throw failure(
            "attempt_already_recovered",
            "runtime 복구 중 exact attempt가 다른 approval로 종결됐습니다.",
          );
        }
        return { kind: "inspected", receipt: attempt.receipt };
      }
      if (attempt.kind === "terminal") {
        throw failure(
          "terminal_already_recorded",
          "runtime 복구 중 정상 terminal receipt가 확정되어 recovery를 쓰지 않았습니다.",
        );
      }
      assertExpectedAttempt(approval, attempt);
      if (attempt.kind !== "start") {
        throw failure("attempt_conflict", "start claim이 runtime 복구 중 사라졌습니다.");
      }

      const receipt = makeRecoveryReceipt({
        approvalId,
        approval,
        context,
        attempt,
        afterRuntime,
      });
      const receiptBytes = encodeCanonical(receipt);
      try {
        await dependencies.repository.writeRecoveryReceipt(
          receipt.receiptSha256,
          receiptBytes,
        );
        await assertStoredReceipt(
          dependencies.repository,
          receipt.receiptSha256,
          receiptBytes,
          context,
        );
      } catch (error) {
        if (error instanceof DeepRepairRecoveryError) throw error;
        throw failure(
          "receipt_commit_failed",
          `content-addressed recovery receipt 저장에 실패했습니다: ${errorMessage(error)}`,
        );
      }

      const key = attemptKey(context.authority);
      let claimed: boolean;
      try {
        claimed = await dependencies.repository.claimAttemptResolution(key, receiptBytes);
      } catch (error) {
        try {
          const reconciled = await readAttemptState(dependencies.repository, context);
          if (
            reconciled.kind === "recovered"
            && reconciled.receipt.recoveryApprovalSha256 === approvalId
            && canonicalJson(reconciled.receipt) === canonicalJson(receipt)
          ) {
            return { kind: "inspected", receipt: reconciled.receipt };
          }
        } catch {
          // 원래 CAS 오류를 보존한다. read-back 자체가 실패하거나 다른 winner이면
          // 성공을 추측하지 않고 receipt_commit_failed로 남긴다.
        }
        throw failure(
          "receipt_commit_failed",
          `attempt recovery CAS 결과를 확정할 수 없습니다: ${errorMessage(error)}`,
        );
      }
      const committed = await readAttemptState(dependencies.repository, context);
      if (
        committed.kind !== "recovered"
        || committed.receipt.recoveryApprovalSha256 !== approvalId
        || canonicalJson(committed.receipt) !== canonicalJson(receipt)
      ) {
        throw failure(
          claimed ? "receipt_commit_failed" : "attempt_conflict",
          "attempt recovery CAS winner가 요청한 exact receipt와 다릅니다.",
        );
      }
      return { kind: claimed ? "recovered" : "inspected", receipt: committed.receipt };
    },
  };
}

/**
 * live 실행 경로가 attempt abandonment marker를 신뢰하기 전에 호출하는 단일 검증 seam이다.
 * canonical receipt와 content copy, 사용자 recovery approval의 exact start binding을 함께 확인한다.
 */
export async function validateDeepRepairAttemptRecoveryArtifact(input: {
  readonly reader: DeepRepairAttemptRecoveryArtifactReader;
  readonly artifact: DeepRepairRecoveryStoredArtifact;
  readonly authoritySha256: Sha256;
  readonly planSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly seriesId: string;
  readonly attemptId: string;
  readonly target: RecoveryTarget;
  readonly claimArtifactSha256: Sha256;
}): Promise<DeepRepairAttemptRecoveryReceipt> {
  const receipt = normalizeRecoveryReceipt(
    parseStoredJson(input.artifact, "attempt recovery receipt"),
    input.artifact,
  );
  if (
    receipt.authoritySha256 !== input.authoritySha256
    || receipt.planSha256 !== input.planSha256
    || receipt.manifestSha256 !== input.manifestSha256
    || receipt.seriesId !== input.seriesId
    || receipt.attemptId !== input.attemptId
    || canonicalJson(receipt.target) !== canonicalJson(input.target)
    || receipt.observedAttempt.claimArtifactSha256 !== input.claimArtifactSha256
  ) {
    throw failure("receipt_invalid", "attempt recovery receipt가 live exact attempt와 다릅니다.");
  }

  const content = await input.reader.readRecoveryReceipt(receipt.receiptSha256);
  if (
    content === null
    || Buffer.compare(Buffer.from(content.bytes), Buffer.from(input.artifact.bytes)) !== 0
  ) {
    throw failure("receipt_invalid", "attempt marker와 content-addressed recovery receipt가 다릅니다.");
  }

  const approvalArtifact = await input.reader.readRecoveryApproval(receipt.recoveryApprovalSha256);
  if (
    approvalArtifact === null
    || rawSha256(approvalArtifact.bytes) !== receipt.recoveryApprovalSha256
  ) {
    throw failure("approval_invalid", "attempt recovery approval을 exact SHA로 읽을 수 없습니다.");
  }
  const approval = normalizeApproval(parseStoredJson(approvalArtifact, "attempt recovery approval"));
  if (Buffer.compare(Buffer.from(approvalArtifact.bytes), encodeCanonical(approval)) !== 0) {
    throw failure("approval_invalid", "attempt recovery approval은 exact canonical bytes여야 합니다.");
  }
  if (
    approval.authoritySha256 !== input.authoritySha256
    || approval.planSha256 !== input.planSha256
    || approval.manifestSha256 !== input.manifestSha256
    || approval.seriesId !== input.seriesId
    || approval.attemptId !== input.attemptId
    || canonicalJson(approval.target) !== canonicalJson(input.target)
    || approval.expectedAttempt.state !== "present"
    || approval.expectedAttempt.claimArtifactSha256 !== input.claimArtifactSha256
    || receipt.recoveryApprovalSha256 !== rawSha256(approvalArtifact.bytes)
  ) {
    throw failure("approval_invalid", "attempt recovery approval이 live exact start와 다릅니다.");
  }
  return receipt;
}

async function recoverRuntimeCleanup(input: {
  readonly dependencies: DeepRepairRecoveryDependencies;
  readonly now: () => Date;
  readonly approvalId: string;
  readonly approval: RecoveryApproval;
  readonly context: AuthorityContext;
  readonly attempt: Extract<AttemptState, { kind: "no_start" | "terminal" }>;
  readonly signal: AbortSignal;
}): Promise<DeepRepairRecoveryResult> {
  if (input.attempt.kind === "terminal") {
    assertExpectedTerminal(input.approval, input.attempt);
  } else {
    assertExpectedAttempt(input.approval, input.attempt);
  }
  const key = attemptKey(input.context.authority);
  const existing = await readRuntimeCleanupReceipt(
    input.dependencies.repository,
    key,
    input.context,
  );
  if (existing !== null) {
    assertRuntimeCleanupAttempt(existing, input.attempt);
    if (existing.recoveryApprovalSha256 !== input.approvalId) {
      throw failure("attempt_already_recovered", "runtime cleanup이 다른 approval로 이미 종결됐습니다.");
    }
    return { kind: "inspected", receipt: existing };
  }

  const changeReason = `deep-repair-recovery:${input.approvalId}`;
  const before = await readRuntimeSnapshot(input.dependencies.runtime);
  const exactExpected = sameMinimalRuntime(minimalRuntime(before), input.approval.expectedRuntime);
  const partial = isPartialRuntimeRecovery(
    input.approval,
    input.context.authority,
    before,
    changeReason,
  );
  if (!exactExpected && !partial) {
    throw failure("runtime_mismatch", "현재 runtime이 terminal cleanup approval의 exact snapshot과 다릅니다.");
  }
  if (!partial) assertApprovalCurrent(input.approval, input.now());
  throwIfAborted(input.signal);

  let after = before;
  if (!partial) {
    const disposition = classifyRuntime(input.context.authority, input.attempt, before, input.now());
    if (disposition === "blocked") {
      throw failure("runtime_not_recoverable", "정상 terminal의 runtime lease를 안전하게 복구할 수 없습니다.");
    }
    if (disposition === "expired_lease_recovery_required") {
      const expiresAt = before.localLeaseExpiresAt;
      if (expiresAt === null) throw failure("runtime_not_recoverable", "만료 lease 시각이 없습니다.");
      after = normalizeRuntimeSnapshot(await input.dependencies.runtime.recoverExpiredLease({
        ownerId: input.context.authority.runtime.ownerId,
        expectedGeneration: before.generation,
        expectedLeaseExpiresAt: expiresAt,
        changeReason,
      }));
      assertRecoveredRuntime(before, after, changeReason);
    }
  }

  const current = await readAttemptState(input.dependencies.repository, input.context);
  if (!sameCleanupAttempt(current, input.attempt)) {
    throw failure("attempt_conflict", "runtime cleanup 중 terminal attempt가 변경됐습니다.");
  }

  const receipt = makeRuntimeCleanupReceipt({
    approvalId: input.approvalId,
    approval: input.approval,
    context: input.context,
    attempt: current,
    afterRuntime: after,
  });
  const bytes = encodeCanonical(receipt);
  await input.dependencies.repository.writeRecoveryReceipt(receipt.receiptSha256, bytes);
  await assertStoredRuntimeCleanupReceipt(
    input.dependencies.repository,
    receipt.receiptSha256,
    bytes,
    input.context,
  );
  let claimed: boolean;
  try {
    claimed = await input.dependencies.repository.claimRuntimeCleanup(key, bytes);
  } catch (error) {
    const reconciled = await readRuntimeCleanupReceipt(
      input.dependencies.repository,
      key,
      input.context,
    );
    if (reconciled?.recoveryApprovalSha256 === input.approvalId) {
      return { kind: "inspected", receipt: reconciled };
    }
    throw failure("receipt_commit_failed", `runtime cleanup marker를 확정할 수 없습니다: ${errorMessage(error)}`);
  }
  const committed = await readRuntimeCleanupReceipt(
    input.dependencies.repository,
    key,
    input.context,
  );
  if (
    committed === null
    || committed.recoveryApprovalSha256 !== input.approvalId
    || canonicalJson(committed) !== canonicalJson(receipt)
  ) {
    throw failure(
      claimed ? "receipt_commit_failed" : "attempt_conflict",
      "runtime cleanup marker가 요청한 exact receipt와 다릅니다.",
    );
  }
  return { kind: claimed ? "recovered" : "inspected", receipt: committed };
}

interface AuthorityContext {
  readonly authorityId: string;
  readonly authority: ExecutionAuthority;
  readonly plan: DeepRepairExperimentPlan;
  readonly target: DeepRepairExperimentPlan["sequence"][number];
}

type AttemptState =
  | {
      readonly kind: "no_start";
      readonly claimArtifactSha256: null;
      readonly modelExecution: "not_started";
    }
  | {
      readonly kind: "start";
      readonly claimArtifactSha256: Sha256;
      readonly modelExecution: "unknown";
    }
  | {
      readonly kind: "recovered";
      readonly claimArtifactSha256: Sha256;
      readonly modelExecution: "unknown";
      readonly receipt: DeepRepairAttemptRecoveryReceipt;
    }
  | {
      readonly kind: "terminal";
      readonly claimArtifactSha256: Sha256;
      readonly resolutionArtifactSha256: Sha256;
      readonly modelExecution: "finished";
    };

async function loadAuthorityContext(
  repository: DeepRepairRecoveryRepository,
  authorityId: string,
): Promise<AuthorityContext> {
  const artifact = await repository.readAuthority(authorityId);
  if (artifact === null) {
    throw failure("authority_not_found", `recovery authority를 찾지 못했습니다: ${authorityId}`);
  }
  if (rawSha256(artifact.bytes) !== authorityId) {
    throw failure("authority_invalid", "authority raw SHA-256이 authorityId와 다릅니다.");
  }
  const authority = normalizeAuthority(parseStoredJson(artifact, "authority"));
  const issuanceArtifact = await repository.readIssuance(authority.approvalSha256);
  if (issuanceArtifact === null) {
    throw failure("issuance_not_found", "authority issuance marker를 찾지 못했습니다.");
  }
  const issuance = normalizeIssuance(parseStoredJson(issuanceArtifact, "issuance"));
  if (
    issuance.approvalSha256 !== authority.approvalSha256
    || issuance.authoritySha256 !== authorityId
    || issuance.operationalEvidenceSha256 !== authority.operationalEvidenceSha256
  ) {
    throw failure("issuance_invalid", "issuance marker가 exact authority와 다릅니다.");
  }

  const planArtifact = await repository.readPlan(authority.planSha256);
  if (planArtifact === null) {
    throw failure("plan_not_found", `recovery plan을 찾지 못했습니다: ${authority.planSha256}`);
  }
  if (rawSha256(planArtifact.bytes) !== authority.planArtifactSha256) {
    throw failure("plan_invalid", "plan artifact raw SHA-256이 authority와 다릅니다.");
  }
  const plan = normalizePlan(parseStoredJson(planArtifact, "plan"), authority);
  const target = plan.sequence[authority.sequence];
  if (
    target === undefined
    || target.sequence !== authority.sequence
    || target.waveId !== authority.waveId
    || target.grantId !== authority.grantId
    || target.inputSha256 !== authority.inputSha256
    || target.attachmentManifestSha256 !== authority.attachmentManifestSha256
  ) {
    throw failure("authority_invalid", "authority가 formal plan의 exact target과 다릅니다.");
  }
  return { authorityId, authority, plan, target };
}

async function loadRecoveryApproval(
  repository: DeepRepairRecoveryRepository,
  approvalId: string,
): Promise<RecoveryApproval> {
  const artifact = await repository.readRecoveryApproval(approvalId);
  if (artifact === null) {
    throw failure("approval_not_found", `recovery approval을 찾지 못했습니다: ${approvalId}`);
  }
  if (rawSha256(artifact.bytes) !== approvalId) {
    throw failure("approval_invalid", "recovery approval raw SHA-256이 approvalId와 다릅니다.");
  }
  const approval = normalizeApproval(parseStoredJson(artifact, "recovery approval"));
  if (Buffer.compare(Buffer.from(artifact.bytes), encodeCanonical(approval)) !== 0) {
    throw failure("approval_invalid", "recovery approval은 exact canonical bytes여야 합니다.");
  }
  return approval;
}

async function readAttemptState(
  repository: DeepRepairRecoveryRepository,
  context: AuthorityContext,
): Promise<AttemptState> {
  const stored = await repository.readAttempt(attemptKey(context.authority));
  if (stored.claim === null) {
    if (stored.resolution !== null) {
      throw failure("attempt_invalid", "claim 없이 resolution만 존재하는 attempt입니다.");
    }
    return { kind: "no_start", claimArtifactSha256: null, modelExecution: "not_started" };
  }

  const claimValue = parseStoredJson(stored.claim, "attempt claim");
  const claimSchema = schemaOf(claimValue);
  if (claimSchema !== "deep-repair-live-start-v1") {
    throw failure("attempt_invalid", "attempt claim schema가 live start가 아닙니다.");
  }

  const start = normalizeLiveStart(claimValue);
  assertLiveStartBinding(start, context);
  const claimArtifactSha256 = rawSha256(stored.claim.bytes);
  if (stored.resolution === null) {
    return { kind: "start", claimArtifactSha256, modelExecution: "unknown" };
  }

  const resolutionValue = parseStoredJson(stored.resolution, "attempt resolution");
  const resolutionSchema = schemaOf(resolutionValue);
  if (resolutionSchema === "deep-repair-attempt-recovery-v1") {
    const receipt = normalizeRecoveryReceipt(resolutionValue, stored.resolution);
    assertRecoveryReceiptBinding(
      receipt,
      context,
      "start_persisted_without_terminal",
      claimArtifactSha256,
    );
    await assertContentReceiptForParsed(repository, receipt, stored.resolution, context);
    return {
      kind: "recovered",
      claimArtifactSha256,
      modelExecution: "unknown",
      receipt,
    };
  }
  if (resolutionSchema === "deep-repair-live-receipt-v1") {
    const receipt = validateTerminalReceipt(resolutionValue, context);
    const addressed = await repository.readLiveReceipt(receipt.receiptSha256);
    if (
      addressed === null
      || Buffer.compare(Buffer.from(addressed.bytes), Buffer.from(stored.resolution.bytes)) !== 0
    ) {
      throw failure("attempt_invalid", "terminal marker와 content-addressed live receipt가 다릅니다.");
    }
    validateTerminalReceipt(parseStoredJson(addressed, "content-addressed terminal"), context);
    return {
      kind: "terminal",
      claimArtifactSha256,
      resolutionArtifactSha256: rawSha256(stored.resolution.bytes),
      modelExecution: "finished",
    };
  }
  throw failure("attempt_invalid", "attempt resolution schema가 terminal 또는 recovery receipt가 아닙니다.");
}

function makeInspection(
  context: AuthorityContext,
  attempt: AttemptState,
  runtime: DeepRepairRecoveryRuntimeSnapshot,
  runtimeDisposition: DeepRepairRecoveryInspection["runtimeDisposition"],
  disposition: DeepRepairRecoveryInspection["disposition"],
  receipt: DeepRepairRecoveryReceipt | null = attempt.kind === "recovered" ? attempt.receipt : null,
): DeepRepairRecoveryInspection {
  return {
    authorityId: context.authorityId,
    planSha256: context.plan.planSha256,
    manifestSha256: context.plan.manifestSha256,
    seriesId: context.plan.manifest.seriesId,
    attemptId: context.authority.attemptId,
    target: recoveryTarget(context.authority),
    attempt: {
      state: attempt.kind === "start"
        ? "start_persisted_without_terminal"
        : attempt.kind === "terminal"
          ? "terminal_recorded"
          : attempt.kind,
      claimArtifactSha256: attempt.claimArtifactSha256,
      resolutionArtifactSha256: attempt.kind === "terminal"
        ? attempt.resolutionArtifactSha256
        : null,
      modelExecution: attempt.modelExecution,
    },
    runtime,
    runtimeDisposition,
    disposition,
    receipt,
  };
}

function assertApprovalBinding(approval: RecoveryApproval, context: AuthorityContext): void {
  const authority = context.authority;
  if (
    approval.authoritySha256 !== context.authorityId
    || approval.planSha256 !== context.plan.planSha256
    || approval.manifestSha256 !== context.plan.manifestSha256
    || approval.seriesId !== context.plan.manifest.seriesId
    || approval.attemptId !== authority.attemptId
    || canonicalJson(approval.target) !== canonicalJson(recoveryTarget(authority))
  ) {
    throw failure("approval_invalid", "recovery approval이 exact authority/plan/target/series와 다릅니다.");
  }
}

function assertExpectedAttempt(
  approval: RecoveryApproval,
  attempt: Extract<AttemptState, { kind: "no_start" | "start" }>,
): void {
  const expected = approval.expectedAttempt;
  if (
    (attempt.kind === "no_start"
      && (expected.state !== "absent" || expected.claimArtifactSha256 !== null))
    || (attempt.kind === "start"
      && (
        expected.state !== "present"
        || expected.claimArtifactSha256 !== attempt.claimArtifactSha256
      ))
  ) {
    throw failure("attempt_conflict", "현재 attempt claim이 recovery approval의 exact 관측과 다릅니다.");
  }
}

function assertExpectedTerminal(
  approval: RecoveryApproval,
  attempt: Extract<AttemptState, { kind: "terminal" }>,
): void {
  const expected = approval.expectedAttempt;
  if (
    expected.state !== "terminal"
    || expected.claimArtifactSha256 !== attempt.claimArtifactSha256
    || expected.resolutionArtifactSha256 !== attempt.resolutionArtifactSha256
  ) {
    throw failure("attempt_conflict", "현재 terminal이 recovery approval의 exact 관측과 다릅니다.");
  }
}

function sameCleanupAttempt(
  current: AttemptState,
  expected: Extract<AttemptState, { kind: "no_start" | "terminal" }>,
): current is Extract<AttemptState, { kind: "no_start" | "terminal" }> {
  return expected.kind === "no_start"
    ? current.kind === "no_start"
    : current.kind === "terminal"
      && current.claimArtifactSha256 === expected.claimArtifactSha256
      && current.resolutionArtifactSha256 === expected.resolutionArtifactSha256;
}

function assertRuntimeCleanupAttempt(
  receipt: DeepRepairRuntimeCleanupReceipt,
  attempt: Extract<AttemptState, { kind: "no_start" | "terminal" }>,
): void {
  if (
    (attempt.kind === "no_start" && receipt.observedAttempt.state !== "no_start")
    || (attempt.kind === "terminal" && (
      receipt.observedAttempt.state !== "terminal"
      || receipt.observedAttempt.claimArtifactSha256 !== attempt.claimArtifactSha256
      || receipt.observedAttempt.resolutionArtifactSha256 !== attempt.resolutionArtifactSha256
    ))
  ) {
    throw failure("receipt_invalid", "runtime cleanup receipt가 현재 exact attempt와 다릅니다.");
  }
}

function classifyRuntime(
  authority: ExecutionAuthority,
  attempt: AttemptState,
  runtime: DeepRepairRecoveryRuntimeSnapshot,
  now: Date,
): DeepRepairRecoveryInspection["runtimeDisposition"] {
  if (runtime.mode === "local_subscription") {
    if (
      runtime.generation === authority.runtime.expectedGeneration + 1
      && runtime.localOwnerId === authority.runtime.ownerId
      && runtime.localLeaseExpiresAt !== null
      && Date.parse(runtime.localLeaseExpiresAt) <= now.getTime()
    ) return "expired_lease_recovery_required";
    return "blocked";
  }
  if (
    runtime.mode === "paused"
    && runtime.localOwnerId === null
    && runtime.localLeaseExpiresAt === null
    && (
      (attempt.kind === "no_start"
        && (
          runtime.generation === authority.runtime.expectedGeneration
          || runtime.generation === authority.runtime.expectedGeneration + 2
        ))
      || ((attempt.kind === "start" || attempt.kind === "terminal")
        && runtime.generation === authority.runtime.expectedGeneration + 2)
      || attempt.kind === "recovered"
    )
  ) return "already_paused";
  return "blocked";
}

function isPartialRuntimeRecovery(
  approval: RecoveryApproval,
  authority: ExecutionAuthority,
  runtime: DeepRepairRecoveryRuntimeSnapshot,
  changeReason: string,
): boolean {
  return approval.expectedRuntime.mode === "local_subscription"
    && approval.expectedRuntime.generation === authority.runtime.expectedGeneration + 1
    && approval.expectedRuntime.localOwnerId === authority.runtime.ownerId
    && approval.expectedRuntime.localLeaseExpiresAt !== null
    && runtime.mode === "paused"
    && runtime.generation === approval.expectedRuntime.generation + 1
    && runtime.localOwnerId === null
    && runtime.localLeaseExpiresAt === null
    && runtime.changedBy === "lab:experiment:recover"
    && runtime.changeReason === changeReason;
}

function assertRecoveredRuntime(
  before: DeepRepairRecoveryRuntimeSnapshot,
  after: DeepRepairRecoveryRuntimeSnapshot,
  changeReason: string,
): void {
  if (
    after.mode !== "paused"
    || after.generation !== before.generation + 1
    || after.localOwnerId !== null
    || after.localLeaseExpiresAt !== null
    || after.changedBy !== "lab:experiment:recover"
    || after.changeReason !== changeReason
  ) {
    throw failure(
      "runtime_recovery_failed",
      "runtime recovery Adapter 결과가 exact paused successor generation이 아닙니다.",
    );
  }
}

function makeRecoveryReceipt(input: {
  readonly approvalId: string;
  readonly approval: RecoveryApproval;
  readonly context: AuthorityContext;
  readonly attempt: Extract<AttemptState, { kind: "start" }>;
  readonly afterRuntime: DeepRepairRecoveryRuntimeSnapshot;
}): DeepRepairAttemptRecoveryReceipt {
  const observedAttempt = {
    state: "start_persisted_without_terminal" as const,
    claimArtifactSha256: input.attempt.claimArtifactSha256,
  };
  const body = {
    schema: "deep-repair-attempt-recovery-v1" as const,
    recoveryApprovalSha256: input.approvalId,
    authoritySha256: input.context.authorityId,
    planSha256: input.context.plan.planSha256,
    manifestSha256: input.context.plan.manifestSha256,
    seriesId: input.context.plan.manifest.seriesId,
    attemptId: input.context.authority.attemptId,
    target: recoveryTarget(input.context.authority),
    observedAttempt,
    modelExecution: "unknown" as const,
    runtime: {
      before: input.approval.expectedRuntime,
      after: minimalRuntime(input.afterRuntime),
    },
    seriesDisposition: "stopped" as const,
    statisticalContribution: "none" as const,
    automaticRetryAuthorized: false as const,
    sameTargetRetryAuthorized: false as const,
    promotionEligibility: "not_evaluated" as const,
  };
  return { ...body, receiptSha256: canonicalSha256(body) };
}

function makeRuntimeCleanupReceipt(input: {
  readonly approvalId: string;
  readonly approval: RecoveryApproval;
  readonly context: AuthorityContext;
  readonly attempt: Extract<AttemptState, { kind: "no_start" | "terminal" }>;
  readonly afterRuntime: DeepRepairRecoveryRuntimeSnapshot;
}): DeepRepairRuntimeCleanupReceipt {
  const terminal = input.attempt.kind === "terminal";
  const body = {
    schema: "deep-repair-runtime-cleanup-v1" as const,
    recoveryApprovalSha256: input.approvalId,
    authoritySha256: input.context.authorityId,
    planSha256: input.context.plan.planSha256,
    manifestSha256: input.context.plan.manifestSha256,
    seriesId: input.context.plan.manifest.seriesId,
    attemptId: input.context.authority.attemptId,
    target: recoveryTarget(input.context.authority),
    recoveryKind: "runtime_cleanup" as const,
    observedAttempt: terminal
      ? {
          state: "terminal" as const,
          claimArtifactSha256: input.attempt.claimArtifactSha256,
          resolutionArtifactSha256: input.attempt.resolutionArtifactSha256,
        }
      : {
          state: "no_start" as const,
          claimArtifactSha256: null,
          resolutionArtifactSha256: null,
        },
    modelExecution: terminal ? "finished" as const : "not_started" as const,
    runtime: {
      before: input.approval.expectedRuntime,
      after: minimalRuntime(input.afterRuntime),
    },
    seriesDisposition: "unchanged" as const,
    statisticalContribution: terminal ? "unchanged" as const : "none" as const,
    automaticRetryAuthorized: false as const,
    sameTargetRetryAuthorized: false as const,
    promotionEligibility: terminal ? "unchanged" as const : "not_evaluated" as const,
  };
  return { ...body, receiptSha256: canonicalSha256(body) };
}

async function readRuntimeCleanupReceipt(
  repository: DeepRepairRecoveryRepository,
  key: DeepRepairRecoveryAttemptKey,
  context: AuthorityContext,
): Promise<DeepRepairRuntimeCleanupReceipt | null> {
  const artifact = await repository.readRuntimeCleanup(key);
  if (artifact === null) return null;
  const receipt = normalizeRuntimeCleanupReceipt(
    parseStoredJson(artifact, "runtime cleanup receipt"),
    artifact,
  );
  assertRuntimeCleanupReceiptBinding(receipt, context);
  const addressed = await repository.readRecoveryReceipt(receipt.receiptSha256);
  if (
    addressed === null
    || Buffer.compare(Buffer.from(addressed.bytes), Buffer.from(artifact.bytes)) !== 0
  ) {
    throw failure("receipt_invalid", "runtime cleanup marker와 content receipt bytes가 다릅니다.");
  }
  return receipt;
}

async function assertStoredRuntimeCleanupReceipt(
  repository: DeepRepairRecoveryRepository,
  receiptSha256: string,
  expectedBytes: Uint8Array,
  context: AuthorityContext,
): Promise<void> {
  const artifact = await repository.readRecoveryReceipt(receiptSha256);
  if (
    artifact === null
    || Buffer.compare(Buffer.from(artifact.bytes), Buffer.from(expectedBytes)) !== 0
  ) {
    throw failure("receipt_commit_failed", "runtime cleanup content receipt read-back이 다릅니다.");
  }
  const receipt = normalizeRuntimeCleanupReceipt(
    parseStoredJson(artifact, "runtime cleanup content receipt"),
    artifact,
  );
  assertRuntimeCleanupReceiptBinding(receipt, context);
}

function assertRuntimeCleanupReceiptBinding(
  receipt: DeepRepairRuntimeCleanupReceipt,
  context: AuthorityContext,
): void {
  if (
    receipt.authoritySha256 !== context.authorityId
    || receipt.planSha256 !== context.plan.planSha256
    || receipt.manifestSha256 !== context.plan.manifestSha256
    || receipt.seriesId !== context.plan.manifest.seriesId
    || receipt.attemptId !== context.authority.attemptId
    || canonicalJson(receipt.target) !== canonicalJson(recoveryTarget(context.authority))
  ) {
    throw failure("receipt_invalid", "runtime cleanup receipt가 exact authority/attempt와 다릅니다.");
  }
}

async function assertStoredReceipt(
  repository: DeepRepairRecoveryRepository,
  receiptSha256: string,
  expectedBytes: Uint8Array,
  context: AuthorityContext,
): Promise<void> {
  const artifact = await repository.readRecoveryReceipt(receiptSha256);
  if (artifact === null || Buffer.compare(Buffer.from(artifact.bytes), Buffer.from(expectedBytes)) !== 0) {
    throw failure("receipt_commit_failed", "recovery receipt immutable read-back이 다릅니다.");
  }
  const parsed = normalizeRecoveryReceipt(parseStoredJson(artifact, "recovery receipt"), artifact);
  assertRecoveryReceiptBinding(
    parsed,
    context,
    parsed.observedAttempt.state,
    parsed.observedAttempt.claimArtifactSha256,
  );
}

async function assertContentReceiptForParsed(
  repository: DeepRepairRecoveryRepository,
  receipt: DeepRepairAttemptRecoveryReceipt,
  attemptArtifact: DeepRepairRecoveryStoredArtifact,
  context: AuthorityContext,
): Promise<void> {
  const addressed = await repository.readRecoveryReceipt(receipt.receiptSha256);
  if (
    addressed === null
    || Buffer.compare(Buffer.from(addressed.bytes), Buffer.from(attemptArtifact.bytes)) !== 0
  ) {
    throw failure("receipt_invalid", "attempt recovery와 content-addressed receipt bytes가 다릅니다.");
  }
  const parsed = normalizeRecoveryReceipt(parseStoredJson(addressed, "addressed recovery receipt"), addressed);
  if (canonicalJson(parsed) !== canonicalJson(receipt)) {
    throw failure("receipt_invalid", "content-addressed recovery receipt 내용이 다릅니다.");
  }
  assertRecoveryReceiptBinding(
    parsed,
    context,
    parsed.observedAttempt.state,
    parsed.observedAttempt.claimArtifactSha256,
  );
}

function assertRecoveryReceiptBinding(
  receipt: DeepRepairAttemptRecoveryReceipt,
  context: AuthorityContext,
  state: DeepRepairAttemptRecoveryReceipt["observedAttempt"]["state"],
  claimArtifactSha256: string | null,
): void {
  if (
    receipt.authoritySha256 !== context.authorityId
    || receipt.planSha256 !== context.plan.planSha256
    || receipt.manifestSha256 !== context.plan.manifestSha256
    || receipt.seriesId !== context.plan.manifest.seriesId
    || receipt.attemptId !== context.authority.attemptId
    || canonicalJson(receipt.target) !== canonicalJson(recoveryTarget(context.authority))
    || receipt.observedAttempt.state !== state
    || receipt.observedAttempt.claimArtifactSha256 !== claimArtifactSha256
  ) {
    throw failure("receipt_invalid", "recovery receipt가 exact authority/attempt와 다릅니다.");
  }
}

function normalizeApproval(value: unknown): RecoveryApproval {
  try {
    const source = record(value, "recovery approval");
    const target = normalizeTarget(source.target, "recovery approval.target");
    const expectedAttemptSource = record(source.expectedAttempt, "recovery approval.expectedAttempt");
    const attemptState = oneOf(
      expectedAttemptSource.state,
      ["absent", "present", "terminal"] as const,
      "recovery approval.expectedAttempt.state",
    );
    const expectedAttempt = attemptState === "absent"
      ? {
          state: "absent" as const,
          claimArtifactSha256: nullValue(
            expectedAttemptSource.claimArtifactSha256,
            "recovery approval.expectedAttempt.claimArtifactSha256",
          ),
        }
      : attemptState === "present"
        ? {
          state: "present" as const,
          claimArtifactSha256: sha(
            expectedAttemptSource.claimArtifactSha256,
            "recovery approval.expectedAttempt.claimArtifactSha256",
          ),
        }
        : {
            state: "terminal" as const,
            claimArtifactSha256: sha(
              expectedAttemptSource.claimArtifactSha256,
              "recovery approval.expectedAttempt.claimArtifactSha256",
            ),
            resolutionArtifactSha256: sha(
              expectedAttemptSource.resolutionArtifactSha256,
              "recovery approval.expectedAttempt.resolutionArtifactSha256",
            ),
          };
    const expectedRuntimeSource = record(source.expectedRuntime, "recovery approval.expectedRuntime");
    const expectedRuntime: MinimalRuntimeSnapshot = {
      mode: oneOf(
        expectedRuntimeSource.mode,
        ["paused", "local_subscription"] as const,
        "recovery approval.expectedRuntime.mode",
      ),
      generation: positiveInteger(
        expectedRuntimeSource.generation,
        "recovery approval.expectedRuntime.generation",
      ),
      localOwnerId: nullableText(
        expectedRuntimeSource.localOwnerId,
        "recovery approval.expectedRuntime.localOwnerId",
      ),
      localLeaseExpiresAt: nullableIso(
        expectedRuntimeSource.localLeaseExpiresAt,
        "recovery approval.expectedRuntime.localLeaseExpiresAt",
      ),
    };
    assertMinimalRuntimeShape(expectedRuntime);
    const confirmationsSource = record(source.confirmations, "recovery approval.confirmations");
    const confirmations = {
      localProcessTerminated: trueValue(
        confirmationsSource.localProcessTerminated,
        "recovery approval.confirmations.localProcessTerminated",
      ),
      noAutomaticRetry: trueValue(
        confirmationsSource.noAutomaticRetry,
        "recovery approval.confirmations.noAutomaticRetry",
      ),
      preserveExistingArtifacts: trueValue(
        confirmationsSource.preserveExistingArtifacts,
        "recovery approval.confirmations.preserveExistingArtifacts",
      ),
    };
    const normalized: RecoveryApproval = {
      schema: literal(source.schema, "deep-repair-recovery-approval-v1", "recovery approval.schema"),
      authoritySha256: sha(source.authoritySha256, "recovery approval.authoritySha256"),
      planSha256: sha(source.planSha256, "recovery approval.planSha256"),
      manifestSha256: sha(source.manifestSha256, "recovery approval.manifestSha256"),
      seriesId: seriesId(source.seriesId, "recovery approval.seriesId"),
      attemptId: text(source.attemptId, "recovery approval.attemptId"),
      target,
      expectedAttempt,
      expectedRuntime,
      approvedBy: text(source.approvedBy, "recovery approval.approvedBy"),
      approvedAt: iso(source.approvedAt, "recovery approval.approvedAt"),
      expiresAt: iso(source.expiresAt, "recovery approval.expiresAt"),
      confirmations,
      stopAfter: literal(source.stopAfter, "recovery-only", "recovery approval.stopAfter"),
    };
    const ttl = Date.parse(normalized.expiresAt) - Date.parse(normalized.approvedAt);
    if (ttl <= 0 || ttl > MAX_APPROVAL_TTL_MS) {
      throw new Error("approval TTL must be 1..15 minutes");
    }
    if (canonicalJson(value) !== canonicalJson(normalized)) {
      throw new Error("approval must contain only canonical fields");
    }
    return normalized;
  } catch (error) {
    if (error instanceof DeepRepairRecoveryError) throw error;
    throw failure("approval_invalid", `recovery approval 형식이 올바르지 않습니다: ${errorMessage(error)}`);
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
      sequence: nonNegativeInteger(source.sequence, "authority.sequence"),
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
        expectedGeneration: positiveInteger(
          runtime.expectedGeneration,
          "authority.runtime.expectedGeneration",
        ),
        databaseObservedAt: iso(
          runtime.databaseObservedAt,
          "authority.runtime.databaseObservedAt",
        ),
        activeDeepLeases: zero(
          runtime.activeDeepLeases,
          "authority.runtime.activeDeepLeases",
        ),
        activeApplicationLeases: zero(
          runtime.activeApplicationLeases,
          "authority.runtime.activeApplicationLeases",
        ),
      },
      operationalEvidenceSha256: sha(
        source.operationalEvidenceSha256,
        "authority.operationalEvidenceSha256",
      ),
      approvalSha256: sha(source.approvalSha256, "authority.approvalSha256"),
    };
    if (!UUID_V4_PATTERN.test(normalized.runtime.ownerId)) throw new Error("invalid runtime owner UUID");
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("authority must be canonical");
    return normalized;
  } catch (error) {
    throw failure("authority_invalid", `authority 형식이 올바르지 않습니다: ${errorMessage(error)}`);
  }
}

function normalizeIssuance(value: unknown): AuthorityIssuance {
  try {
    const source = record(value, "issuance");
    const normalized: AuthorityIssuance = {
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
    throw failure("issuance_invalid", `issuance 형식이 올바르지 않습니다: ${errorMessage(error)}`);
  }
}

function normalizePlan(value: unknown, authority: ExecutionAuthority): DeepRepairExperimentPlan {
  try {
    const source = record(value, "plan");
    const plan = createDeepRepairExperimentPlan(source.manifest);
    if (
      plan.planSha256 !== authority.planSha256
      || plan.manifestSha256 !== authority.manifestSha256
      || canonicalJson(value) !== canonicalJson(plan)
      || plan.manifest.mode !== "formal"
      || plan.manifest.formation !== "prospective"
      || plan.manifest.policy.transport !== "claude-cli"
    ) throw new Error("unsupported or non-canonical formal plan");
    return plan;
  } catch (error) {
    throw failure("plan_invalid", `formal plan을 재구성할 수 없습니다: ${errorMessage(error)}`);
  }
}

function normalizeLiveStart(value: unknown): LiveStart {
  try {
    const source = record(value, "live start");
    const normalized: LiveStart = {
      schema: literal(source.schema, "deep-repair-live-start-v1", "live start.schema"),
      planSha256: sha(source.planSha256, "live start.planSha256"),
      parentReceiptSha256: nullableSha(source.parentReceiptSha256, "live start.parentReceiptSha256"),
      authoritySha256: sha(source.authoritySha256, "live start.authoritySha256"),
      attemptId: text(source.attemptId, "live start.attemptId"),
      target: normalizeTarget(source.target, "live start.target"),
      startedAt: iso(source.startedAt, "live start.startedAt"),
    };
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("live start must be canonical");
    return normalized;
  } catch (error) {
    throw failure("attempt_invalid", `live start 형식이 올바르지 않습니다: ${errorMessage(error)}`);
  }
}

function normalizeRecoveryReceipt(
  value: unknown,
  artifact: DeepRepairRecoveryStoredArtifact,
): DeepRepairAttemptRecoveryReceipt {
  try {
    const source = record(value, "recovery receipt");
    const observedSource = record(source.observedAttempt, "recovery receipt.observedAttempt");
    const observedAttempt = {
      state: literal(
        observedSource.state,
        "start_persisted_without_terminal",
        "recovery receipt.observedAttempt.state",
      ),
      claimArtifactSha256: sha(
        observedSource.claimArtifactSha256,
        "recovery receipt.observedAttempt.claimArtifactSha256",
      ),
    };
    const runtimeSource = record(source.runtime, "recovery receipt.runtime");
    const normalized: DeepRepairAttemptRecoveryReceipt = {
      schema: literal(source.schema, "deep-repair-attempt-recovery-v1", "recovery receipt.schema"),
      receiptSha256: sha(source.receiptSha256, "recovery receipt.receiptSha256"),
      recoveryApprovalSha256: sha(
        source.recoveryApprovalSha256,
        "recovery receipt.recoveryApprovalSha256",
      ),
      authoritySha256: sha(source.authoritySha256, "recovery receipt.authoritySha256"),
      planSha256: sha(source.planSha256, "recovery receipt.planSha256"),
      manifestSha256: sha(source.manifestSha256, "recovery receipt.manifestSha256"),
      seriesId: seriesId(source.seriesId, "recovery receipt.seriesId"),
      attemptId: text(source.attemptId, "recovery receipt.attemptId"),
      target: normalizeTarget(source.target, "recovery receipt.target"),
      observedAttempt,
      modelExecution: literal(source.modelExecution, "unknown", "recovery receipt.modelExecution"),
      runtime: {
        before: normalizeMinimalRuntime(runtimeSource.before, "recovery receipt.runtime.before"),
        after: normalizeMinimalRuntime(runtimeSource.after, "recovery receipt.runtime.after"),
      },
      seriesDisposition: literal(
        source.seriesDisposition,
        "stopped",
        "recovery receipt.seriesDisposition",
      ),
      statisticalContribution: literal(
        source.statisticalContribution,
        "none",
        "recovery receipt.statisticalContribution",
      ),
      automaticRetryAuthorized: falseValue(
        source.automaticRetryAuthorized,
        "recovery receipt.automaticRetryAuthorized",
      ),
      sameTargetRetryAuthorized: falseValue(
        source.sameTargetRetryAuthorized,
        "recovery receipt.sameTargetRetryAuthorized",
      ),
      promotionEligibility: literal(
        source.promotionEligibility,
        "not_evaluated",
        "recovery receipt.promotionEligibility",
      ),
    };
    const { receiptSha256, ...body } = normalized;
    if (canonicalSha256(body) !== receiptSha256) throw new Error("receipt self hash mismatch");
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("receipt must be canonical");
    if (Buffer.compare(Buffer.from(artifact.bytes), encodeCanonical(normalized)) !== 0) {
      throw new Error("receipt bytes must be exact canonical encoding");
    }
    return normalized;
  } catch (error) {
    if (error instanceof DeepRepairRecoveryError) throw error;
    throw failure("receipt_invalid", `recovery receipt 형식이 올바르지 않습니다: ${errorMessage(error)}`);
  }
}

function normalizeRuntimeCleanupReceipt(
  value: unknown,
  artifact: DeepRepairRecoveryStoredArtifact,
): DeepRepairRuntimeCleanupReceipt {
  try {
    const source = record(value, "runtime cleanup receipt");
    const observedSource = record(source.observedAttempt, "runtime cleanup receipt.observedAttempt");
    const observedState = oneOf(
      observedSource.state,
      ["no_start", "terminal"] as const,
      "runtime cleanup receipt.observedAttempt.state",
    );
    const observedAttempt = observedState === "no_start"
      ? {
          state: "no_start" as const,
          claimArtifactSha256: nullValue(
            observedSource.claimArtifactSha256,
            "runtime cleanup receipt.observedAttempt.claimArtifactSha256",
          ),
          resolutionArtifactSha256: nullValue(
            observedSource.resolutionArtifactSha256,
            "runtime cleanup receipt.observedAttempt.resolutionArtifactSha256",
          ),
        }
      : {
          state: "terminal" as const,
          claimArtifactSha256: sha(
            observedSource.claimArtifactSha256,
            "runtime cleanup receipt.observedAttempt.claimArtifactSha256",
          ),
          resolutionArtifactSha256: sha(
            observedSource.resolutionArtifactSha256,
            "runtime cleanup receipt.observedAttempt.resolutionArtifactSha256",
          ),
        };
    const runtime = record(source.runtime, "runtime cleanup receipt.runtime");
    const normalized: DeepRepairRuntimeCleanupReceipt = {
      schema: literal(source.schema, "deep-repair-runtime-cleanup-v1", "runtime cleanup receipt.schema"),
      receiptSha256: sha(source.receiptSha256, "runtime cleanup receipt.receiptSha256"),
      recoveryApprovalSha256: sha(
        source.recoveryApprovalSha256,
        "runtime cleanup receipt.recoveryApprovalSha256",
      ),
      authoritySha256: sha(source.authoritySha256, "runtime cleanup receipt.authoritySha256"),
      planSha256: sha(source.planSha256, "runtime cleanup receipt.planSha256"),
      manifestSha256: sha(source.manifestSha256, "runtime cleanup receipt.manifestSha256"),
      seriesId: seriesId(source.seriesId, "runtime cleanup receipt.seriesId"),
      attemptId: text(source.attemptId, "runtime cleanup receipt.attemptId"),
      target: normalizeTarget(source.target, "runtime cleanup receipt.target"),
      recoveryKind: literal(source.recoveryKind, "runtime_cleanup", "runtime cleanup receipt.recoveryKind"),
      observedAttempt,
      modelExecution: oneOf(
        source.modelExecution,
        ["not_started", "finished"] as const,
        "runtime cleanup receipt.modelExecution",
      ),
      runtime: {
        before: normalizeMinimalRuntime(runtime.before, "runtime cleanup receipt.runtime.before"),
        after: normalizeMinimalRuntime(runtime.after, "runtime cleanup receipt.runtime.after"),
      },
      seriesDisposition: literal(
        source.seriesDisposition,
        "unchanged",
        "runtime cleanup receipt.seriesDisposition",
      ),
      statisticalContribution: oneOf(
        source.statisticalContribution,
        ["none", "unchanged"] as const,
        "runtime cleanup receipt.statisticalContribution",
      ),
      automaticRetryAuthorized: falseValue(
        source.automaticRetryAuthorized,
        "runtime cleanup receipt.automaticRetryAuthorized",
      ),
      sameTargetRetryAuthorized: falseValue(
        source.sameTargetRetryAuthorized,
        "runtime cleanup receipt.sameTargetRetryAuthorized",
      ),
      promotionEligibility: oneOf(
        source.promotionEligibility,
        ["not_evaluated", "unchanged"] as const,
        "runtime cleanup receipt.promotionEligibility",
      ),
    };
    const { receiptSha256, ...body } = normalized;
    if (canonicalSha256(body) !== receiptSha256) throw new Error("receipt self hash mismatch");
    if (
      (normalized.observedAttempt.state === "no_start"
        && (
          normalized.modelExecution !== "not_started"
          || normalized.statisticalContribution !== "none"
          || normalized.promotionEligibility !== "not_evaluated"
        ))
      || (normalized.observedAttempt.state === "terminal"
        && (
          normalized.modelExecution !== "finished"
          || normalized.statisticalContribution !== "unchanged"
          || normalized.promotionEligibility !== "unchanged"
        ))
    ) throw new Error("runtime cleanup receipt state mismatch");
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("receipt must be canonical");
    if (Buffer.compare(Buffer.from(artifact.bytes), encodeCanonical(normalized)) !== 0) {
      throw new Error("receipt bytes must be exact canonical encoding");
    }
    return normalized;
  } catch (error) {
    if (error instanceof DeepRepairRecoveryError) throw error;
    throw failure("receipt_invalid", `runtime cleanup receipt 형식이 올바르지 않습니다: ${errorMessage(error)}`);
  }
}

function normalizeRuntimeSnapshot(value: DeepRepairRecoveryRuntimeSnapshot): DeepRepairRecoveryRuntimeSnapshot {
  try {
    const normalized: DeepRepairRecoveryRuntimeSnapshot = {
      mode: text(value.mode, "runtime.mode"),
      generation: positiveInteger(value.generation, "runtime.generation"),
      localOwnerId: nullableText(value.localOwnerId, "runtime.localOwnerId"),
      localLeaseExpiresAt: nullableIso(value.localLeaseExpiresAt, "runtime.localLeaseExpiresAt"),
      changedBy: text(value.changedBy, "runtime.changedBy"),
      changeReason: nullableText(value.changeReason, "runtime.changeReason"),
      updatedAt: iso(value.updatedAt, "runtime.updatedAt"),
    };
    if (normalized.localOwnerId !== null && !UUID_V4_PATTERN.test(normalized.localOwnerId)) {
      throw new Error("runtime owner must be UUID v4");
    }
    return normalized;
  } catch (error) {
    throw failure("runtime_mismatch", `runtime snapshot 형식이 올바르지 않습니다: ${errorMessage(error)}`);
  }
}

async function readRuntimeSnapshot(
  runtime: DeepRepairRecoveryRuntimeAdapter,
): Promise<DeepRepairRecoveryRuntimeSnapshot> {
  return normalizeRuntimeSnapshot(await runtime.inspect());
}

function normalizeMinimalRuntime(value: unknown, label: string): MinimalRuntimeSnapshot {
  const source = record(value, label);
  const normalized: MinimalRuntimeSnapshot = {
    mode: oneOf(source.mode, ["paused", "local_subscription"] as const, `${label}.mode`),
    generation: positiveInteger(source.generation, `${label}.generation`),
    localOwnerId: nullableText(source.localOwnerId, `${label}.localOwnerId`),
    localLeaseExpiresAt: nullableIso(source.localLeaseExpiresAt, `${label}.localLeaseExpiresAt`),
  };
  assertMinimalRuntimeShape(normalized);
  if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error(`${label} must be canonical`);
  return normalized;
}

function assertMinimalRuntimeShape(value: MinimalRuntimeSnapshot): void {
  if (
    (value.mode === "paused"
      && (value.localOwnerId !== null || value.localLeaseExpiresAt !== null))
    || (value.mode === "local_subscription"
      && (
        value.localOwnerId === null
        || !UUID_V4_PATTERN.test(value.localOwnerId)
        || value.localLeaseExpiresAt === null
      ))
  ) throw new Error("runtime mode/owner/expiry shape mismatch");
}

function assertLiveStartBinding(start: LiveStart, context: AuthorityContext): void {
  if (
    start.planSha256 !== context.plan.planSha256
    || start.parentReceiptSha256 !== context.authority.parentReceiptSha256
    || start.authoritySha256 !== context.authorityId
    || start.attemptId !== context.authority.attemptId
    || canonicalJson(start.target) !== canonicalJson(recoveryTarget(context.authority))
  ) throw failure("attempt_invalid", "live start가 exact authority/target과 다릅니다.");
}

function validateTerminalReceipt(value: unknown, context: AuthorityContext) {
  try {
    const receipt = validateDeepRepairLiveReceipt(value);
    if (
      receipt.planSha256 !== context.plan.planSha256
      || receipt.manifestSha256 !== context.plan.manifestSha256
      || receipt.authoritySha256 !== context.authorityId
      || receipt.attemptId !== context.authority.attemptId
      || canonicalJson(receipt.target)
        !== canonicalJson(recoveryTarget(context.authority))
    ) throw new Error("terminal binding mismatch");
    return receipt;
  } catch (error) {
    throw failure("attempt_invalid", `terminal receipt가 exact attempt와 다릅니다: ${errorMessage(error)}`);
  }
}

function assertApprovalCurrent(approval: RecoveryApproval, now: Date): void {
  const current = now.getTime();
  if (current < Date.parse(approval.approvedAt) || current >= Date.parse(approval.expiresAt)) {
    throw failure("approval_expired", "recovery approval 유효 시간이 지났거나 아직 시작되지 않았습니다.");
  }
}

function recoveryTarget(authority: ExecutionAuthority): RecoveryTarget {
  return {
    sequence: authority.sequence,
    waveId: authority.waveId,
    grantId: authority.grantId,
  };
}

function normalizeTarget(value: unknown, label: string): RecoveryTarget {
  const source = record(value, label);
  const normalized: RecoveryTarget = {
    sequence: nonNegativeInteger(source.sequence, `${label}.sequence`),
    waveId: text(source.waveId, `${label}.waveId`),
    grantId: text(source.grantId, `${label}.grantId`),
  };
  if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error(`${label} must be canonical`);
  return normalized;
}

function minimalRuntime(value: DeepRepairRecoveryRuntimeSnapshot): MinimalRuntimeSnapshot {
  if (value.mode !== "paused" && value.mode !== "local_subscription") {
    throw failure("runtime_not_recoverable", `지원하지 않는 runtime mode입니다: ${value.mode}`);
  }
  const normalized: MinimalRuntimeSnapshot = {
    mode: value.mode,
    generation: value.generation,
    localOwnerId: value.localOwnerId,
    localLeaseExpiresAt: value.localLeaseExpiresAt,
  };
  assertMinimalRuntimeShape(normalized);
  return normalized;
}

function sameMinimalRuntime(left: MinimalRuntimeSnapshot, right: MinimalRuntimeSnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function attemptKey(authority: ExecutionAuthority): DeepRepairRecoveryAttemptKey {
  return { planSha256: authority.planSha256, sequence: authority.sequence };
}

function seriesId(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!SERIES_PATTERN.test(normalized)) throw new Error(`${label} must be deep-vN`);
  return normalized;
}

function schemaOf(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).schema
    : undefined;
}

function parseStoredJson(artifact: DeepRepairRecoveryStoredArtifact, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(artifact.bytes).toString("utf8"));
  } catch (error) {
    throw failure("attempt_invalid", `${label} JSON을 읽을 수 없습니다: ${errorMessage(error)}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be text`);
  return value;
}

function sha(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} must be lowercase SHA-256`);
  return normalized;
}

function nullableSha(value: unknown, label: string): string | null {
  return value === null ? null : sha(value, label);
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function iso(value: unknown, label: string): string {
  const normalized = text(value, label);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new Error(`${label} must be exact ISO-8601 UTC`);
  }
  return normalized;
}

function nullableIso(value: unknown, label: string): string | null {
  return value === null ? null : iso(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function literal<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
  return expected;
}

function oneOf<T extends string>(value: unknown, expected: readonly T[], label: string): T {
  if (typeof value !== "string" || !expected.includes(value as T)) {
    throw new Error(`${label} must be one of ${expected.join(", ")}`);
  }
  return value as T;
}

function trueValue(value: unknown, label: string): true {
  if (value !== true) throw new Error(`${label} must be true`);
  return true;
}

function falseValue(value: unknown, label: string): false {
  if (value !== false) throw new Error(`${label} must be false`);
  return false;
}

function nullValue(value: unknown, label: string): null {
  if (value !== null) throw new Error(`${label} must be null`);
  return null;
}

function zero(value: unknown, label: string): 0 {
  if (value !== 0) throw new Error(`${label} must be zero`);
  return 0;
}

function requireSha(
  value: string,
  label: string,
  code: DeepRepairRecoveryErrorCode,
): string {
  if (!SHA256_PATTERN.test(value)) throw failure(code, `${label}가 exact SHA-256이 아닙니다.`);
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw failure("aborted", "recovery가 runtime 변경 전에 취소됐습니다.");
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function encodeCanonical(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .filter((key) => source[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

function failure(code: DeepRepairRecoveryErrorCode, message: string): DeepRepairRecoveryError {
  return new DeepRepairRecoveryError(code, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
