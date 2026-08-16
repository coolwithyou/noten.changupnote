import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import { ANALYSIS_QUALITY_POLICY_VERSION } from "@/features/dev/analysis-lab/quality-contract";
import {
  createDeepRepairExperimentPlan,
  replayDeepRepairExperiment,
  type DeepRepairExperimentPlan,
  type DeepRepairExperimentReceipt,
} from "./deep-repair-experiment";
import { evaluateAnalysisQuality } from "./quality-graph";
import { classifyLabRunOutcome } from "./run-outcome";
import { validateDeepRepairAttemptRecoveryArtifact } from "./deep-repair-recovery";
import { validateDeepRepairLiveReceipt } from "./deep-repair-live-receipt";

type Sha256 = string;

export type DeepRepairLiveExecutionErrorCode =
  | "authority_not_found"
  | "authority_invalid"
  | "authority_binding_mismatch"
  | "approval_not_found"
  | "approval_invalid"
  | "approval_expired"
  | "approval_binding_mismatch"
  | "issuance_not_found"
  | "issuance_invalid"
  | "plan_not_found"
  | "plan_not_canonical"
  | "parent_receipt_not_found"
  | "parent_receipt_invalid"
  | "attempt_recovered"
  | "attempt_artifact_invalid"
  | "gate_not_continuable"
  | "production_guard_not_found"
  | "production_guard_invalid"
  | "production_guard_stale"
  | "execution_provenance_drift"
  | "target_input_drift"
  | "aborted_before_start"
  | "aborted_after_start"
  | "start_commit_ambiguous"
  | "cli_cleanup_failed"
  | "run_artifact_invalid"
  | "runtime_authority_failed"
  | "receipt_commit_failed";

export class DeepRepairLiveExecutionError extends Error {
  constructor(
    readonly code: DeepRepairLiveExecutionErrorCode,
    message: string,
    readonly noModelStarted: boolean,
  ) {
    super(message);
    this.name = "DeepRepairLiveExecutionError";
  }
}

export interface DeepRepairOperationalEvidence {
  readonly schema: "deep-repair-operational-evidence-v1";
  readonly project: "changupnote-com";
  readonly region: "asia-northeast3";
  readonly job: "cunote-deep-analysis";
  readonly workerMode: "observe_only";
  readonly claimScope: "unconfigured";
  readonly jobUid: string;
  readonly jobGeneration: string;
  readonly jobEtag: string;
  readonly jobUpdateTime: string;
  readonly imageDigest: string;
  readonly gitCommitSha: string;
  readonly observedAt: string;
  readonly validUntil: string;
}

interface DeepRepairExecutionAuthority {
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

interface DeepRepairUserApproval {
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

interface DeepRepairAuthorityIssuanceMarker {
  readonly schema: "deep-repair-authority-issuance-v1";
  readonly approvalSha256: Sha256;
  readonly operationalEvidenceSha256: Sha256;
  readonly authoritySha256: Sha256;
}

interface DeepRepairLiveStart {
  readonly schema: "deep-repair-live-start-v1";
  readonly planSha256: Sha256;
  readonly parentReceiptSha256: Sha256 | null;
  readonly authoritySha256: Sha256;
  readonly attemptId: string;
  readonly target: {
    readonly sequence: number;
    readonly waveId: string;
    readonly grantId: string;
  };
  readonly startedAt: string;
}

export interface DeepRepairLiveReceipt {
  readonly schema: "deep-repair-live-receipt-v1";
  readonly receiptSha256: Sha256;
  readonly planSha256: Sha256;
  readonly manifestSha256: Sha256;
  readonly parentReceiptSha256: Sha256 | null;
  readonly authoritySha256: Sha256;
  readonly attemptId: string;
  readonly target: {
    readonly sequence: number;
    readonly waveId: string;
    readonly grantId: string;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lifecycle: "finished";
  readonly noticeOutcome: "publishable" | "held" | "failed";
  readonly promotionEligibility: "not_evaluated";
  readonly runArtifactPath: string | null;
  readonly runArtifactSha256: Sha256 | null;
  readonly observationsSha256: Sha256 | null;
  readonly evaluatorReceiptSha256: Sha256 | null;
  readonly observedCount: number;
  readonly gateVerdict: "CONTINUE" | "GO" | "NO_GO" | "INCONCLUSIVE" | "INVALID";
  readonly nextAction: "awaiting_user_authority" | "new_user_authority_required" | "stopped";
  readonly failureCode: string | null;
}

export interface DeepRepairLiveArtifactRepository {
  readAuthority(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readApproval(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readIssuance(approvalSha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readOperationalEvidence(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readPlan(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readCohort(path: string): Promise<DeepRepairLiveStoredArtifact | null>;
  readLiveReceipt(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readObservations(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readEvaluatorReceipt(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readRecoveryApproval(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readRecoveryReceipt(sha256: Sha256): Promise<DeepRepairLiveStoredArtifact | null>;
  readAttempt(key: DeepRepairLiveAttemptKey): Promise<{
    readonly start: DeepRepairLiveStoredArtifact;
    readonly terminal: DeepRepairLiveStoredArtifact | null;
  } | null>;
  claimStart(key: DeepRepairLiveAttemptKey, start: DeepRepairLiveStart): Promise<boolean>;
  writeObservations(sha256: Sha256, value: unknown): Promise<void>;
  writeEvaluatorReceipt(sha256: Sha256, value: DeepRepairExperimentReceipt): Promise<void>;
  commitTerminal(
    key: DeepRepairLiveAttemptKey,
    receiptSha256: Sha256,
    value: DeepRepairLiveReceipt,
  ): Promise<void>;
}

export interface DeepRepairLiveAttemptKey {
  readonly planSha256: Sha256;
  readonly sequence: number;
}

export interface DeepRepairLiveStoredArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface DeepRepairLivePreparedTarget {
  readonly binding: {
    readonly grantId: string;
    readonly inputSha256: Sha256;
    readonly attachmentManifestSha256: Sha256;
  };
  execute(input: { readonly signal: AbortSignal }): Promise<{
    readonly artifactPath: string;
  }>;
}

export interface DeepRepairLiveExecutionBinding {
  readonly authoritySha256: string;
  readonly grantId: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly model: string;
  readonly transport: "claude-cli";
  readonly promptVersion: string;
}

const verifiedLiveExecution = new AsyncLocalStorage<DeepRepairLiveExecutionBinding>();

/** 읽기 전용 capability 조회. 실행 문맥을 여는 함수는 이 Module 밖으로 내보내지 않는다. */
export function currentDeepRepairLiveExecutionBinding(): DeepRepairLiveExecutionBinding | null {
  return verifiedLiveExecution.getStore() ?? null;
}

export interface DeepRepairLiveTargetExecutor {
  prepare(input: {
    readonly grantId: string;
    readonly inputSha256: Sha256;
    readonly attachmentManifestSha256: Sha256;
    readonly model: string;
    readonly transport: "claude-cli";
    readonly promptVersion: string;
    readonly signal: AbortSignal;
  }): Promise<DeepRepairLivePreparedTarget>;
}

export interface DeepRepairLiveRuntimeAuthority {
  runExclusive<T>(
    binding: {
      readonly ownerId: string;
      readonly expectedGeneration: number;
      readonly signal: AbortSignal;
    },
    run: (executionSignal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

interface ExecutionProvenance {
  readonly gitSha: string;
  readonly packageRuntimeSha256: Sha256;
  readonly validatorVersion: string;
}

export interface DeepRepairLiveDependencies {
  readonly repository: DeepRepairLiveArtifactRepository;
  readonly targetExecutor: DeepRepairLiveTargetExecutor;
  readonly runtimeAuthority: DeepRepairLiveRuntimeAuthority;
  readonly readRunArtifact: (path: string) => Promise<DeepRepairLiveStoredArtifact | null>;
  readonly verifyOperationalEvidence: (
    evidence: DeepRepairOperationalEvidence,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly currentExecutionProvenance: () => Promise<ExecutionProvenance>;
  readonly now?: () => Date;
}

export type DeepRepairCanaryResult =
  | { readonly kind: "recorded"; readonly started: "now"; readonly receipt: DeepRepairLiveReceipt }
  | { readonly kind: "inspected"; readonly started: "earlier"; readonly receipt: DeepRepairLiveReceipt }
  | { readonly kind: "ambiguous"; readonly start: unknown };

export interface DeepRepairLiveExperiment {
  runApprovedCanary(input: {
    readonly authorityId: string;
    readonly signal: AbortSignal;
  }): Promise<DeepRepairCanaryResult>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OWNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_USER_APPROVAL_TTL_MS = 15 * 60_000;

/**
 * 내부 조립 seam. production에서는 고정 조합 모듈만 호출할 수 있으며, 다른 production
 * source의 사용은 admission 정적 회귀 테스트가 거부한다.
 */
export function createDeepRepairLiveExperiment(
  dependencies: DeepRepairLiveDependencies,
): DeepRepairLiveExperiment {
  const now = dependencies.now ?? (() => new Date());
  return {
    async runApprovedCanary(input): Promise<DeepRepairCanaryResult> {
      const authoritySha256 = requireSha256(input.authorityId, "authorityId", "authority_invalid");
      assertNotAborted(input.signal);

      const authorityRaw = await dependencies.repository.readAuthority(authoritySha256);
      if (authorityRaw === null) {
        throw rejection("authority_not_found", `실행 authority를 찾지 못했습니다: ${authoritySha256}`, true);
      }
      if (rawSha256(authorityRaw.bytes) !== authoritySha256) {
        throw rejection("authority_invalid", "authority artifact SHA-256이 ID와 일치하지 않습니다.", true);
      }
      const authority = normalizeAuthority(parseStoredJson(authorityRaw, "authority"));
      const approval = await loadAndValidateApproval(dependencies.repository, authority);
      await assertCommittedIssuance(
        dependencies.repository,
        authority,
        authoritySha256,
      );

      const planRaw = await dependencies.repository.readPlan(authority.planSha256);
      if (planRaw === null) {
        throw rejection("plan_not_found", `실험 plan을 찾지 못했습니다: ${authority.planSha256}`, true);
      }
      if (rawSha256(planRaw.bytes) !== authority.planArtifactSha256) {
        throw rejection("plan_not_canonical", "plan artifact bytes SHA-256이 authority와 일치하지 않습니다.", true);
      }
      const plan = normalizePlan(parseStoredJson(planRaw, "plan"), authority.planSha256);
      const parentState = await loadAndValidateParentChain({
        repository: dependencies.repository,
        readRunArtifact: dependencies.readRunArtifact,
        plan,
        planArtifactSha256: rawSha256(planRaw.bytes),
        parentReceiptSha256: authority.parentReceiptSha256,
      });
      const parent = parentState.latest;
      const nextSequence = parent?.observedCount ?? 0;
      if (parent && parent.gateVerdict !== "CONTINUE") {
        throw rejection("gate_not_continuable", `직전 gate가 ${parent.gateVerdict}이므로 다음 실행을 시작할 수 없습니다.`, true);
      }
      assertAuthorityBinding({ authority, authoritySha256, plan, nextSequence });
      const target = plan.sequence[nextSequence]!;
      const attemptKey = { planSha256: plan.planSha256, sequence: nextSequence };
      const existing = await dependencies.repository.readAttempt(attemptKey);
      if (existing) {
        const start = normalizeLiveStart(parseAttemptArtifact(existing.start, "live start", true));
        assertLiveStartBinding(start, { authority, authoritySha256, plan, target, nextSequence });
        assertApprovalTime(approval, new Date(start.startedAt));
        if (existing.terminal) {
          await rejectIfAttemptRecovery({
            repository: dependencies.repository,
            artifact: existing.terminal,
            authority,
            authoritySha256,
            plan,
            target,
            claimArtifactSha256: rawSha256(existing.start.bytes),
          });
          const receipt = normalizeLiveReceipt(parseAttemptArtifact(existing.terminal, "terminal receipt", true));
          assertLiveReceiptBinding(receipt, { authority, authoritySha256, plan, target, nextSequence });
          await assertContentAddressedReceipt(dependencies.repository, receipt);
          await validateLiveTerminalEvidence({
            repository: dependencies.repository,
            readRunArtifact: dependencies.readRunArtifact,
            plan,
            receipt,
            previousReceipt: parentState.latest,
            previousNotices: parentState.observations.notices,
          });
          return { kind: "inspected", started: "earlier", receipt };
        }
        return { kind: "ambiguous", start };
      }
      assertApprovalTime(approval, now());
      const targetWave = plan.manifest.waves.find((wave) => wave.waveId === target.waveId)!;
      const cohortArtifact = await dependencies.repository.readCohort(targetWave.cohort.artifactPath);
      if (
        cohortArtifact === null
        || cohortArtifact.path !== targetWave.cohort.artifactPath
        || rawSha256(cohortArtifact.bytes) !== targetWave.cohort.sha256
      ) {
        throw rejection("authority_binding_mismatch", "plan의 exact cohort artifact bytes를 재검증할 수 없습니다.", true);
      }
      assertCohortArtifactBinding(
        parseStoredJson(cohortArtifact, "cohort"),
        plan,
        targetWave.waveId,
      );

      const evidenceRaw = await dependencies.repository.readOperationalEvidence(
        authority.operationalEvidenceSha256,
      );
      if (evidenceRaw === null) {
        throw rejection("production_guard_not_found", "운영 worker observe_only 증거를 찾지 못했습니다.", true);
      }
      if (rawSha256(evidenceRaw.bytes) !== authority.operationalEvidenceSha256) {
        throw rejection("production_guard_invalid", "운영 worker 증거 SHA-256이 일치하지 않습니다.", true);
      }
      const evidence = normalizeOperationalEvidence(parseStoredJson(evidenceRaw, "operational evidence"));
      assertOperationalEvidenceFresh(evidence, now());

      const expectedProvenance = plan.manifest.provenance;
      await assertExecutionProvenance(dependencies.currentExecutionProvenance, expectedProvenance);
      const prepared = await dependencies.targetExecutor.prepare({
        grantId: target.grantId,
        inputSha256: target.inputSha256,
        attachmentManifestSha256: target.attachmentManifestSha256!,
        model: plan.manifest.policy.model,
        transport: "claude-cli",
        promptVersion: plan.manifest.policy.promptVersion,
        signal: input.signal,
      });
      if (
        prepared.binding.grantId !== target.grantId
        || prepared.binding.inputSha256 !== target.inputSha256
        || prepared.binding.attachmentManifestSha256 !== target.attachmentManifestSha256
      ) {
        throw rejection("target_input_drift", "실행 직전 조립 입력이 plan의 exact target binding과 다릅니다.", true);
      }
      assertNotAborted(input.signal);

      let startClaimed = false;
      try {
        return await dependencies.runtimeAuthority.runExclusive(
          {
            ownerId: authority.runtime.ownerId,
            expectedGeneration: authority.runtime.expectedGeneration,
            signal: input.signal,
          },
          async (executionSignal) => {
          assertNotAborted(executionSignal);
          assertApprovalTime(approval, now());
          assertOperationalEvidenceFresh(evidence, now());
          try {
            await dependencies.verifyOperationalEvidence(evidence, executionSignal);
          } catch (error) {
            if (executionSignal.aborted) assertNotAborted(executionSignal);
            throw rejection(
              "production_guard_invalid",
              `운영 worker current state 재검증에 실패했습니다: ${errorMessage(error)}`,
              true,
            );
          }
          assertNotAborted(executionSignal);
          const executionProvenance = await assertExecutionProvenance(
            dependencies.currentExecutionProvenance,
            expectedProvenance,
          );
          assertNotAborted(executionSignal);
          const currentApproval = await loadAndValidateApproval(dependencies.repository, authority);
          assertNotAborted(executionSignal);
          const claimTime = now();
          assertApprovalTime(currentApproval, claimTime);
          assertOperationalEvidenceFresh(evidence, claimTime);
          const startedAt = claimTime.toISOString();
          const start: DeepRepairLiveStart = {
            schema: "deep-repair-live-start-v1",
            planSha256: plan.planSha256,
            parentReceiptSha256: authority.parentReceiptSha256,
            authoritySha256,
            attemptId: authority.attemptId,
            target: {
              sequence: nextSequence,
              waveId: target.waveId,
              grantId: target.grantId,
            },
            startedAt,
          };
          let claimed: boolean;
          try {
            claimed = await dependencies.repository.claimStart(attemptKey, start);
          } catch (error) {
            throw rejection(
              "start_commit_ambiguous",
              `start receipt 저장 여부를 확정할 수 없습니다: ${errorMessage(error)}`,
              true,
            );
          }
          if (!claimed) {
            const raced = await dependencies.repository.readAttempt(attemptKey);
            if (raced?.terminal) {
              await rejectIfAttemptRecovery({
                repository: dependencies.repository,
                artifact: raced.terminal,
                authority,
                authoritySha256,
                plan,
                target,
                claimArtifactSha256: rawSha256(raced.start.bytes),
              });
              const receipt = normalizeLiveReceipt(parseAttemptArtifact(raced.terminal, "terminal receipt", true));
              assertLiveReceiptBinding(receipt, { authority, authoritySha256, plan, target, nextSequence });
              await assertContentAddressedReceipt(dependencies.repository, receipt);
              await validateLiveTerminalEvidence({
                repository: dependencies.repository,
                readRunArtifact: dependencies.readRunArtifact,
                plan,
                receipt,
                previousReceipt: parentState.latest,
                previousNotices: parentState.observations.notices,
              });
              return {
                kind: "inspected" as const,
                started: "earlier" as const,
                receipt,
              };
            }
            if (raced?.start) {
              const racedStart = normalizeLiveStart(parseAttemptArtifact(raced.start, "live start", true));
              assertLiveStartBinding(racedStart, { authority, authoritySha256, plan, target, nextSequence });
              return { kind: "ambiguous" as const, start: racedStart };
            }
            return { kind: "ambiguous" as const, start };
          }
          startClaimed = true;

          let executed: Awaited<ReturnType<DeepRepairLivePreparedTarget["execute"]>>;
          try {
            const executionBinding = Object.freeze({
              authoritySha256,
              grantId: target.grantId,
              inputSha256: target.inputSha256,
              attachmentManifestSha256: target.attachmentManifestSha256!,
              model: plan.manifest.policy.model,
              transport: "claude-cli" as const,
              promptVersion: plan.manifest.policy.promptVersion,
            });
            executed = await verifiedLiveExecution.run(
              executionBinding,
              () => prepared.execute({ signal: executionSignal }),
            );
          } catch (error) {
            throw rejection(
              "run_artifact_invalid",
              `모델 착수 뒤 exact terminal artifact를 확인하지 못했습니다: ${errorMessage(error)}`,
              false,
            );
          }
          assertNotAborted(executionSignal, false);
          const runArtifact = await dependencies.readRunArtifact(executed.artifactPath);
          if (runArtifact === null || runArtifact.path !== executed.artifactPath) {
            throw rejection("run_artifact_invalid", "저장된 run artifact를 exact path로 다시 읽을 수 없습니다.", false);
          }
          const runArtifactSha256 = rawSha256(runArtifact.bytes);
          const run = parseRunArtifact(runArtifact.bytes, runArtifact.path);
          const runOutcome = classifyLabRunOutcome(run);
          if (
            run.grantId !== target.grantId
            || run.inputSha256 !== target.inputSha256
            || run.attachmentManifestSha256 !== target.attachmentManifestSha256
            || run.model !== plan.manifest.policy.model
            || run.transport !== "claude-cli"
            || run.promptVersion !== plan.manifest.policy.promptVersion
          ) {
            throw rejection("run_artifact_invalid", "저장된 run artifact가 exact target/policy binding과 다릅니다.", false);
          }

          const previousObservations = parentState.observations;
          let observationsSha256 = parent?.observationsSha256 ?? null;
          let evaluatorReceiptSha256 = parent?.evaluatorReceiptSha256 ?? null;
          let observedCount = parent?.observedCount ?? 0;
          let gateVerdict = parent?.gateVerdict ?? "CONTINUE";
          let noticeOutcome: DeepRepairLiveReceipt["noticeOutcome"] = "failed";
          let failureCode: string | null = run.error ? run.error.slice(0, 500) : null;

          if (runOutcome === "publishable" || runOutcome === "held") {
            noticeOutcome = runOutcome;
            failureCode = null;
            const notices = [
              ...previousObservations.notices,
              buildFormalObservation({
                plan,
                target,
                run,
                artifactPath: runArtifact.path,
                artifactSha256: runArtifactSha256,
              }),
            ];
            const replayInput = {
              executionProvenance,
              notices,
              waveLifecycles: buildWaveLifecycles(plan, notices),
            };
            const evaluator = replayDeepRepairExperiment(plan, replayInput);
            observationsSha256 = canonicalSha256(replayInput);
            await dependencies.repository.writeObservations(observationsSha256, replayInput);
            await dependencies.repository.writeEvaluatorReceipt(evaluator.receiptSha256, evaluator);
            const [storedObservations, storedEvaluator] = await Promise.all([
              dependencies.repository.readObservations(observationsSha256),
              dependencies.repository.readEvaluatorReceipt(evaluator.receiptSha256),
            ]);
            if (
              storedObservations === null
              || canonicalSha256(parseStoredJson(storedObservations, "stored observations")) !== observationsSha256
              || storedEvaluator === null
              || canonicalJson(parseStoredJson(storedEvaluator, "stored evaluator receipt")) !== canonicalJson(evaluator)
            ) {
              throw rejection("receipt_commit_failed", "observations/evaluator receipt 저장 후 read-back 검증에 실패했습니다.", false);
            }
            evaluatorReceiptSha256 = evaluator.receiptSha256;
            observedCount = evaluator.observedCount;
            gateVerdict = evaluator.verdict;
          }

          const receipt = makeLiveReceipt({
            planSha256: plan.planSha256,
            manifestSha256: plan.manifestSha256,
            parentReceiptSha256: authority.parentReceiptSha256,
            authoritySha256,
            attemptId: authority.attemptId,
            target: start.target,
            startedAt,
            finishedAt: now().toISOString(),
            lifecycle: "finished",
            noticeOutcome,
            promotionEligibility: "not_evaluated",
            runArtifactPath: executed.artifactPath,
            runArtifactSha256,
            observationsSha256,
            evaluatorReceiptSha256,
            observedCount,
            gateVerdict: noticeOutcome === "failed" ? "INVALID" : gateVerdict,
            nextAction: noticeOutcome === "failed"
              ? "stopped"
              : gateVerdict === "CONTINUE"
                ? "awaiting_user_authority"
                : "stopped",
            failureCode,
          });
          try {
            assertNotAborted(executionSignal, false);
            await dependencies.repository.commitTerminal(
              attemptKey,
              receipt.receiptSha256,
              receipt,
            );
            const committed = await dependencies.repository.readAttempt(attemptKey);
            if (!committed?.terminal) throw new Error("terminal receipt read-back missing");
            const storedReceipt = normalizeLiveReceipt(
              parseAttemptArtifact(committed.terminal, "committed terminal receipt", false),
            );
            const addressedArtifact = await dependencies.repository.readLiveReceipt(receipt.receiptSha256);
            if (!addressedArtifact) throw new Error("content-addressed receipt read-back missing");
            const addressedReceipt = normalizeLiveReceipt(
              parseStoredJson(addressedArtifact, "content-addressed terminal receipt"),
            );
            if (
              canonicalJson(storedReceipt) !== canonicalJson(receipt)
              || canonicalJson(addressedReceipt) !== canonicalJson(receipt)
            ) {
              throw new Error("terminal receipt read-back mismatch");
            }
          } catch (error) {
            throw rejection(
              "receipt_commit_failed",
              `terminal receipt 저장에 실패했습니다: ${errorMessage(error)}`,
              false,
            );
          }
          return { kind: "recorded" as const, started: "now" as const, receipt };
          },
        );
      } catch (error) {
        if (error instanceof DeepRepairLiveExecutionError) throw error;
        throw rejection(
          "runtime_authority_failed",
          `runtime authority 실행 또는 정리에 실패했습니다: ${errorMessage(error)}`,
          !startClaimed,
        );
      }
    },
  };
}

function normalizePlan(value: unknown, expectedPlanSha256: string): DeepRepairExperimentPlan {
  try {
    const source = asRecord(value, "plan");
    const canonical = createDeepRepairExperimentPlan(source.manifest);
    if (
      canonical.planSha256 !== expectedPlanSha256
      || canonicalJson(value) !== canonicalJson(canonical)
    ) {
      throw new Error("plan canonical mismatch");
    }
    if (
      canonical.manifest.mode !== "formal"
      || canonical.manifest.formation !== "prospective"
      || canonical.manifest.objective !== "deep-primary-repair-rate"
      || canonical.manifest.policy.transport !== "claude-cli"
      || canonical.manifest.policy.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION
      || canonical.manifest.policy.qualityPolicyVersion !== ANALYSIS_QUALITY_POLICY_VERSION
    ) {
      throw new Error("unsupported formal policy");
    }
    return canonical;
  } catch (error) {
    throw rejection("plan_not_canonical", `formal plan을 canonical하게 재구성할 수 없습니다: ${errorMessage(error)}`, true);
  }
}

function normalizeAuthority(value: unknown): DeepRepairExecutionAuthority {
  try {
    const source = asRecord(value, "authority");
    const runtime = asRecord(source.runtime, "authority.runtime");
    const normalized: DeepRepairExecutionAuthority = {
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
        expectedGeneration: nonNegativeInteger(runtime.expectedGeneration, "authority.runtime.expectedGeneration"),
        databaseObservedAt: isoDate(
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
      operationalEvidenceSha256: sha(source.operationalEvidenceSha256, "authority.operationalEvidenceSha256"),
      approvalSha256: sha(source.approvalSha256, "authority.approvalSha256"),
    };
    if (!OWNER_ID_PATTERN.test(normalized.runtime.ownerId)) throw new Error("runtime ownerId must be UUID v4");
    if (
      normalized.runtime.activeDeepLeases !== 0
      || normalized.runtime.activeApplicationLeases !== 0
    ) {
      throw new Error("runtime active lease counts must both be zero");
    }
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("authority must be canonical");
    return normalized;
  } catch (error) {
    throw rejection("authority_invalid", `실행 authority 형식이 올바르지 않습니다: ${errorMessage(error)}`, true);
  }
}

function normalizeApproval(value: unknown): DeepRepairUserApproval {
  try {
    const source = asRecord(value, "approval");
    const normalized: DeepRepairUserApproval = {
      schema: literal(source.schema, "deep-repair-user-approval-v1", "approval.schema"),
      proposalSha256: sha(source.proposalSha256, "approval.proposalSha256"),
      planSha256: sha(source.planSha256, "approval.planSha256"),
      planArtifactSha256: sha(source.planArtifactSha256, "approval.planArtifactSha256"),
      parentReceiptSha256: nullableSha(source.parentReceiptSha256, "approval.parentReceiptSha256"),
      sequence: nonNegativeInteger(source.sequence, "approval.sequence"),
      waveId: text(source.waveId, "approval.waveId"),
      grantId: text(source.grantId, "approval.grantId"),
      model: text(source.model, "approval.model"),
      promptVersion: text(source.promptVersion, "approval.promptVersion"),
      approvedBy: text(source.approvedBy, "approval.approvedBy"),
      approvedAt: isoDate(source.approvedAt, "approval.approvedAt"),
      expiresAt: isoDate(source.expiresAt, "approval.expiresAt"),
      stopAfter: literal(source.stopAfter, "one-target", "approval.stopAfter"),
    };
    const approvedAt = new Date(normalized.approvedAt).getTime();
    const expiresAt = new Date(normalized.expiresAt).getTime();
    if (expiresAt <= approvedAt || expiresAt - approvedAt > MAX_USER_APPROVAL_TTL_MS) {
      throw new Error("approval validity window must be positive and at most 15 minutes");
    }
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("approval must be canonical");
    return normalized;
  } catch (error) {
    throw rejection("approval_invalid", `사용자 승인 artifact 형식이 올바르지 않습니다: ${errorMessage(error)}`, true);
  }
}

function normalizeIssuance(value: unknown): DeepRepairAuthorityIssuanceMarker {
  try {
    const source = asRecord(value, "issuance");
    const normalized: DeepRepairAuthorityIssuanceMarker = {
      schema: literal(
        source.schema,
        "deep-repair-authority-issuance-v1",
        "issuance.schema",
      ),
      approvalSha256: sha(source.approvalSha256, "issuance.approvalSha256"),
      operationalEvidenceSha256: sha(
        source.operationalEvidenceSha256,
        "issuance.operationalEvidenceSha256",
      ),
      authoritySha256: sha(source.authoritySha256, "issuance.authoritySha256"),
    };
    if (canonicalJson(value) !== canonicalJson(normalized)) {
      throw new Error("issuance must be canonical");
    }
    return normalized;
  } catch (error) {
    throw rejection(
      "issuance_invalid",
      `authority issuance marker 형식이 올바르지 않습니다: ${errorMessage(error)}`,
      true,
    );
  }
}

/**
 * Content-addressed SHA 검증은 승인 내용의 무결성과 결속만 증명한다.
 * approvedBy 문자열의 인증된 사용자 신원이나 실제 승인 행위는 외부 발급 경계가 보장해야 한다.
 */
async function loadAndValidateApproval(
  repository: DeepRepairLiveArtifactRepository,
  authority: DeepRepairExecutionAuthority,
): Promise<DeepRepairUserApproval> {
  const raw = await repository.readApproval(authority.approvalSha256);
  if (raw === null) {
    throw rejection("approval_not_found", `사용자 승인 artifact를 찾지 못했습니다: ${authority.approvalSha256}`, true);
  }
  if (rawSha256(raw.bytes) !== authority.approvalSha256) {
    throw rejection("approval_invalid", "사용자 승인 artifact SHA-256이 authority와 일치하지 않습니다.", true);
  }
  let approval: DeepRepairUserApproval;
  try {
    approval = normalizeApproval(parseStoredJson(raw, "approval"));
  } catch (error) {
    if (error instanceof DeepRepairLiveExecutionError) throw error;
    throw rejection("approval_invalid", `사용자 승인 artifact를 읽을 수 없습니다: ${errorMessage(error)}`, true);
  }
  assertApprovalBinding(approval, authority);
  return approval;
}

async function assertCommittedIssuance(
  repository: DeepRepairLiveArtifactRepository,
  authority: DeepRepairExecutionAuthority,
  authoritySha256: string,
): Promise<void> {
  const raw = await repository.readIssuance(authority.approvalSha256);
  if (raw === null) {
    throw rejection(
      "issuance_not_found",
      `approval에 commit된 authority issuance marker가 없습니다: ${authority.approvalSha256}`,
      true,
    );
  }
  const marker = normalizeIssuance(parseStoredJson(raw, "authority issuance marker"));
  if (
    marker.approvalSha256 !== authority.approvalSha256
    || marker.operationalEvidenceSha256 !== authority.operationalEvidenceSha256
    || marker.authoritySha256 !== authoritySha256
  ) {
    throw rejection(
      "issuance_invalid",
      "요청 authority가 approval-key issuance CAS winner와 일치하지 않습니다.",
      true,
    );
  }
}

function normalizeOperationalEvidence(value: unknown): DeepRepairOperationalEvidence {
  try {
    const source = asRecord(value, "operationalEvidence");
    const normalized: DeepRepairOperationalEvidence = {
      schema: literal(source.schema, "deep-repair-operational-evidence-v1", "operationalEvidence.schema"),
      project: literal(source.project, "changupnote-com", "operationalEvidence.project"),
      region: literal(source.region, "asia-northeast3", "operationalEvidence.region"),
      job: literal(source.job, "cunote-deep-analysis", "operationalEvidence.job"),
      workerMode: literal(source.workerMode, "observe_only", "operationalEvidence.workerMode"),
      claimScope: literal(source.claimScope, "unconfigured", "operationalEvidence.claimScope"),
      jobUid: text(source.jobUid, "operationalEvidence.jobUid"),
      jobGeneration: text(source.jobGeneration, "operationalEvidence.jobGeneration"),
      jobEtag: text(source.jobEtag, "operationalEvidence.jobEtag"),
      jobUpdateTime: rfc3339Timestamp(source.jobUpdateTime, "operationalEvidence.jobUpdateTime"),
      imageDigest: text(source.imageDigest, "operationalEvidence.imageDigest"),
      gitCommitSha: text(source.gitCommitSha, "operationalEvidence.gitCommitSha"),
      observedAt: isoDate(source.observedAt, "operationalEvidence.observedAt"),
      validUntil: isoDate(source.validUntil, "operationalEvidence.validUntil"),
    };
    if (!/^\d+$/u.test(normalized.jobGeneration)) throw new Error("job generation must be numeric");
    if (!/^sha256:[a-f0-9]{64}$/u.test(normalized.imageDigest)) throw new Error("image digest must be exact");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(normalized.gitCommitSha)) {
      throw new Error("deployed git SHA must be full");
    }
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("operational evidence must be canonical");
    return normalized;
  } catch (error) {
    throw rejection("production_guard_invalid", `운영 worker 증거 형식이 올바르지 않습니다: ${errorMessage(error)}`, true);
  }
}

function normalizeLiveStart(value: unknown): DeepRepairLiveStart {
  try {
    const source = asRecord(value, "liveStart");
    const target = asRecord(source.target, "liveStart.target");
    const normalized: DeepRepairLiveStart = {
      schema: literal(source.schema, "deep-repair-live-start-v1", "liveStart.schema"),
      planSha256: sha(source.planSha256, "liveStart.planSha256"),
      parentReceiptSha256: nullableSha(source.parentReceiptSha256, "liveStart.parentReceiptSha256"),
      authoritySha256: sha(source.authoritySha256, "liveStart.authoritySha256"),
      attemptId: text(source.attemptId, "liveStart.attemptId"),
      target: {
        sequence: nonNegativeInteger(target.sequence, "liveStart.target.sequence"),
        waveId: text(target.waveId, "liveStart.target.waveId"),
        grantId: text(target.grantId, "liveStart.target.grantId"),
      },
      startedAt: isoDate(source.startedAt, "liveStart.startedAt"),
    };
    if (canonicalJson(value) !== canonicalJson(normalized)) throw new Error("live start must be canonical");
    return normalized;
  } catch (error) {
    throw rejection("authority_binding_mismatch", `live start 형식이 올바르지 않습니다: ${errorMessage(error)}`, true);
  }
}

function normalizeLiveReceipt(value: unknown): DeepRepairLiveReceipt {
  try {
    return validateDeepRepairLiveReceipt(value);
  } catch (error) {
    throw rejection("parent_receipt_invalid", `live receipt 형식이 올바르지 않습니다: ${errorMessage(error)}`, true);
  }
}

interface ValidatedParentState {
  readonly latest: DeepRepairLiveReceipt | null;
  readonly observations: { readonly notices: Array<Record<string, unknown>> };
}

async function loadAndValidateParentChain(input: {
  repository: DeepRepairLiveArtifactRepository;
  readRunArtifact: (path: string) => Promise<DeepRepairLiveStoredArtifact | null>;
  plan: DeepRepairExperimentPlan;
  planArtifactSha256: string;
  parentReceiptSha256: string | null;
}): Promise<ValidatedParentState> {
  if (input.parentReceiptSha256 === null) {
    return { latest: null, observations: { notices: [] } };
  }
  const seen = new Set<string>();
  const chainNewestFirst: DeepRepairLiveReceipt[] = [];
  let cursor: string | null = input.parentReceiptSha256;
  let child: DeepRepairLiveReceipt | null = null;
  while (cursor !== null) {
    if (seen.has(cursor)) throw rejection("parent_receipt_invalid", "parent receipt chain에 순환이 있습니다.", true);
    seen.add(cursor);
    const raw = await input.repository.readLiveReceipt(cursor);
    if (raw === null) {
      throw rejection("parent_receipt_not_found", `parent receipt를 찾지 못했습니다: ${cursor}`, true);
    }
    const receipt = normalizeLiveReceipt(parseStoredJson(raw, "parent receipt"));
    if (receipt.receiptSha256 !== cursor || receipt.planSha256 !== input.plan.planSha256) {
      throw rejection("parent_receipt_invalid", "parent receipt가 plan/receipt SHA와 결속되지 않았습니다.", true);
    }
    if (child && child.parentReceiptSha256 !== receipt.receiptSha256) {
      throw rejection("parent_receipt_invalid", "parent receipt chain 순서가 올바르지 않습니다.", true);
    }
    child = receipt;
    chainNewestFirst.push(receipt);
    cursor = receipt.parentReceiptSha256;
  }
  let expectedObservedCount = 0;
  let previousNotices: Array<Record<string, unknown>> = [];
  let previousObservationsSha256: string | null = null;
  let previousEvaluatorReceiptSha256: string | null = null;
  const latest = chainNewestFirst[0] ?? null;
  const chain = chainNewestFirst.reverse();
  for (let index = 0; index < chain.length; index += 1) {
    const receipt = chain[index]!;
    const expectedTarget = input.plan.sequence[expectedObservedCount];
    if (
      !expectedTarget
      || receipt.target.sequence !== expectedObservedCount
      || receipt.target.waveId !== expectedTarget.waveId
      || receipt.target.grantId !== expectedTarget.grantId
      || receipt.manifestSha256 !== input.plan.manifestSha256
    ) {
      throw rejection("parent_receipt_invalid", "parent receipt target/ordinal이 plan prefix와 일치하지 않습니다.", true);
    }
    const authorityRaw = await input.repository.readAuthority(receipt.authoritySha256);
    if (authorityRaw === null || rawSha256(authorityRaw.bytes) !== receipt.authoritySha256) {
      throw rejection("parent_receipt_invalid", "parent authority raw bytes를 exact SHA로 읽을 수 없습니다.", true);
    }
    let parentAuthority: DeepRepairExecutionAuthority;
    let parentApproval: DeepRepairUserApproval;
    try {
      parentAuthority = normalizeAuthority(parseStoredJson(authorityRaw, "parent authority"));
      if (parentAuthority.planArtifactSha256 !== input.planArtifactSha256) {
        throw new Error("parent plan artifact SHA mismatch");
      }
      assertAuthorityBinding({
        authority: parentAuthority,
        authoritySha256: receipt.authoritySha256,
        plan: input.plan,
        nextSequence: receipt.target.sequence,
      });
      parentApproval = await loadAndValidateApproval(input.repository, parentAuthority);
      await assertCommittedIssuance(
        input.repository,
        parentAuthority,
        receipt.authoritySha256,
      );
    } catch (error) {
      throw rejection("parent_receipt_invalid", `parent authority binding이 올바르지 않습니다: ${errorMessage(error)}`, true);
    }
    const parentAttempt = await input.repository.readAttempt({
      planSha256: input.plan.planSha256,
      sequence: receipt.target.sequence,
    });
    if (!parentAttempt?.terminal) {
      throw rejection("parent_receipt_invalid", "parent plan slot의 start/terminal artifact가 없습니다.", true);
    }
    const parentStart = normalizeLiveStart(parseStoredJson(parentAttempt.start, "parent live start"));
    assertLiveStartBinding(parentStart, {
      authority: parentAuthority,
      authoritySha256: receipt.authoritySha256,
      plan: input.plan,
      target: expectedTarget,
      nextSequence: receipt.target.sequence,
    });
    try {
      assertApprovalTime(parentApproval, new Date(parentStart.startedAt));
    } catch (error) {
      throw rejection(
        "parent_receipt_invalid",
        `parent start 시점에 사용자 승인이 유효하지 않았습니다: ${errorMessage(error)}`,
        true,
      );
    }
    const parentTerminal = normalizeLiveReceipt(parseStoredJson(parentAttempt.terminal, "parent terminal"));
    if (canonicalJson(parentTerminal) !== canonicalJson(receipt)) {
      throw rejection("parent_receipt_invalid", "parent plan slot terminal이 content-addressed receipt와 다릅니다.", true);
    }
    if (receipt.noticeOutcome === "failed") {
      if (
        index !== chain.length - 1
        || receipt.gateVerdict !== "INVALID"
        || receipt.nextAction !== "stopped"
        || receipt.observationsSha256 !== previousObservationsSha256
        || receipt.evaluatorReceiptSha256 !== previousEvaluatorReceiptSha256
      ) {
        throw rejection("parent_receipt_invalid", "failed receipt는 해당 plan을 종결해야 합니다.", true);
      }
    } else {
      expectedObservedCount += 1;
    }
    if (receipt.observedCount !== expectedObservedCount) {
      throw rejection("parent_receipt_invalid", "parent receipt observedCount가 outcome prefix와 일치하지 않습니다.", true);
    }
    if ((receipt.observationsSha256 === null) !== (receipt.evaluatorReceiptSha256 === null)) {
      throw rejection("parent_receipt_invalid", "parent receipt의 observations/evaluator 결속이 불완전합니다.", true);
    }
    if (receipt.noticeOutcome !== "failed") {
      if (receipt.evaluatorReceiptSha256 === null || receipt.observationsSha256 === null) {
        throw rejection("parent_receipt_invalid", "성공/held parent receipt에 evaluator evidence가 없습니다.", true);
      }
      const validated = await loadAndReplayStoredEvaluation({
        repository: input.repository,
        readRunArtifact: input.readRunArtifact,
        plan: input.plan,
        evaluatorReceiptSha256: receipt.evaluatorReceiptSha256,
        observationsSha256: receipt.observationsSha256,
        expectedReceipt: receipt,
        previousNotices,
      });
      previousNotices = validated.notices;
      previousObservationsSha256 = receipt.observationsSha256;
      previousEvaluatorReceiptSha256 = receipt.evaluatorReceiptSha256;
    }
    if (index < chain.length - 1 && receipt.gateVerdict !== "CONTINUE") {
      throw rejection("parent_receipt_invalid", "terminal gate 뒤에 child receipt가 있습니다.", true);
    }
  }
  return {
    latest,
    observations: { notices: structuredClone(previousNotices) },
  };
}

async function loadAndReplayStoredEvaluation(input: {
  repository: DeepRepairLiveArtifactRepository;
  readRunArtifact: (path: string) => Promise<DeepRepairLiveStoredArtifact | null>;
  plan: DeepRepairExperimentPlan;
  evaluatorReceiptSha256: string;
  observationsSha256: string;
  expectedReceipt: DeepRepairLiveReceipt;
  previousNotices: ReadonlyArray<Record<string, unknown>>;
}): Promise<{ readonly notices: Array<Record<string, unknown>> }> {
  const observationsArtifact = await input.repository.readObservations(input.observationsSha256);
  if (observationsArtifact === null) {
    throw rejection("parent_receipt_invalid", "parent observations를 찾지 못했습니다.", true);
  }
  const replayInput = parseStoredJson(observationsArtifact, "parent observations");
  if (canonicalSha256(replayInput) !== input.observationsSha256) {
    throw rejection("parent_receipt_invalid", "parent observations SHA-256이 일치하지 않습니다.", true);
  }
  const replayRecord = asRecord(replayInput, "parent observations");
  if (!Array.isArray(replayRecord.notices)) {
    throw rejection("parent_receipt_invalid", "parent observations notices가 배열이 아닙니다.", true);
  }
  const notices = structuredClone(replayRecord.notices) as Array<Record<string, unknown>>;
  if (
    notices.length !== input.expectedReceipt.observedCount
    || notices.length !== input.previousNotices.length + 1
    || canonicalJson(notices.slice(0, -1)) !== canonicalJson(input.previousNotices)
  ) {
    throw rejection("parent_receipt_invalid", "parent observations가 직전 exact prefix를 확장하지 않습니다.", true);
  }
  for (let index = 0; index < notices.length; index += 1) {
    const expectedTarget = input.plan.sequence[index];
    if (!expectedTarget) {
      throw rejection("parent_receipt_invalid", "parent observations가 plan 범위를 넘었습니다.", true);
    }
    const notice = asRecord(notices[index], `parent observations.notices[${index}]`);
    const artifactPath = text(notice.runArtifactPath, `parent observations.notices[${index}].runArtifactPath`);
    const artifactSha256 = sha(
      notice.runArtifactSha256,
      `parent observations.notices[${index}].runArtifactSha256`,
    );
    const runArtifact = await input.readRunArtifact(artifactPath);
    if (
      runArtifact === null
      || runArtifact.path !== artifactPath
      || rawSha256(runArtifact.bytes) !== artifactSha256
    ) {
      throw rejection("parent_receipt_invalid", "parent run artifact bytes를 exact path/SHA로 재검증할 수 없습니다.", true);
    }
    let derived: Record<string, unknown>;
    try {
      const run = parseRunArtifact(runArtifact.bytes, runArtifact.path);
      derived = buildFormalObservation({
        plan: input.plan,
        target: expectedTarget,
        run,
        artifactPath,
        artifactSha256,
      });
    } catch (error) {
      throw rejection(
        "parent_receipt_invalid",
        `parent run artifact projection을 재구성할 수 없습니다: ${errorMessage(error)}`,
        true,
      );
    }
    if (canonicalJson(derived) !== canonicalJson(notice)) {
      throw rejection("parent_receipt_invalid", "parent observation이 실제 run artifact projection과 다릅니다.", true);
    }
  }
  const replayed = replayDeepRepairExperiment(input.plan, replayInput);
  const lastNotice = asRecord(notices.at(-1), "parent observations.lastNotice");
  if (
    replayed.observationSha256 !== input.observationsSha256
    || replayed.observedCount !== input.expectedReceipt.observedCount
    || replayed.verdict !== input.expectedReceipt.gateVerdict
    || replayed.receiptSha256 !== input.evaluatorReceiptSha256
    || input.expectedReceipt.runArtifactPath !== lastNotice.runArtifactPath
    || input.expectedReceipt.runArtifactSha256 !== lastNotice.runArtifactSha256
    || input.expectedReceipt.noticeOutcome !== lastNotice.noticeOutcome
  ) {
    throw rejection("parent_receipt_invalid", "parent evaluator replay 결과가 live receipt와 다릅니다.", true);
  }
  const artifact = await input.repository.readEvaluatorReceipt(input.evaluatorReceiptSha256);
  if (artifact === null) {
    throw rejection("parent_receipt_invalid", "parent evaluator receipt를 찾지 못했습니다.", true);
  }
  const storedEvaluator = parseStoredJson(artifact, "parent evaluator receipt");
  if (canonicalJson(storedEvaluator) !== canonicalJson(replayed)) {
    throw rejection("parent_receipt_invalid", "parent evaluator receipt가 deterministic replay와 다릅니다.", true);
  }
  return { notices };
}

async function validateLiveTerminalEvidence(input: {
  repository: DeepRepairLiveArtifactRepository;
  readRunArtifact: (path: string) => Promise<DeepRepairLiveStoredArtifact | null>;
  plan: DeepRepairExperimentPlan;
  receipt: DeepRepairLiveReceipt;
  previousReceipt: DeepRepairLiveReceipt | null;
  previousNotices: ReadonlyArray<Record<string, unknown>>;
}): Promise<void> {
  if (input.receipt.noticeOutcome !== "failed") {
    if (!input.receipt.observationsSha256 || !input.receipt.evaluatorReceiptSha256) {
      throw rejection("parent_receipt_invalid", "terminal receipt의 evaluator evidence가 없습니다.", true);
    }
    await loadAndReplayStoredEvaluation({
      repository: input.repository,
      readRunArtifact: input.readRunArtifact,
      plan: input.plan,
      evaluatorReceiptSha256: input.receipt.evaluatorReceiptSha256,
      observationsSha256: input.receipt.observationsSha256,
      expectedReceipt: input.receipt,
      previousNotices: input.previousNotices,
    });
    return;
  }
  if (
    input.receipt.gateVerdict !== "INVALID"
    || input.receipt.nextAction !== "stopped"
    || input.receipt.observedCount !== input.previousNotices.length
    || input.receipt.observationsSha256 !== (input.previousReceipt?.observationsSha256 ?? null)
    || input.receipt.evaluatorReceiptSha256 !== (input.previousReceipt?.evaluatorReceiptSha256 ?? null)
    || !input.receipt.runArtifactPath
    || !input.receipt.runArtifactSha256
  ) {
    throw rejection("parent_receipt_invalid", "failed terminal receipt의 종결 binding이 올바르지 않습니다.", true);
  }
  const artifact = await input.readRunArtifact(input.receipt.runArtifactPath);
  if (
    artifact === null
    || artifact.path !== input.receipt.runArtifactPath
    || rawSha256(artifact.bytes) !== input.receipt.runArtifactSha256
  ) {
    throw rejection("parent_receipt_invalid", "failed terminal run artifact를 exact path/SHA로 읽을 수 없습니다.", true);
  }
  let run: LabRun;
  try {
    run = parseRunArtifact(artifact.bytes, artifact.path);
  } catch (error) {
    throw rejection("parent_receipt_invalid", `failed terminal run artifact가 올바르지 않습니다: ${errorMessage(error)}`, true);
  }
  const target = input.plan.sequence[input.receipt.target.sequence];
  if (
    !target
    || classifyLabRunOutcome(run) !== "failed"
    || run.grantId !== target.grantId
    || run.inputSha256 !== target.inputSha256
    || run.attachmentManifestSha256 !== target.attachmentManifestSha256
    || run.model !== input.plan.manifest.policy.model
    || run.transport !== input.plan.manifest.policy.transport
    || run.promptVersion !== input.plan.manifest.policy.promptVersion
    || input.receipt.failureCode !== (run.error ? run.error.slice(0, 500) : null)
  ) {
    throw rejection("parent_receipt_invalid", "failed terminal receipt가 실제 run outcome/policy와 다릅니다.", true);
  }
}

function assertAuthorityBinding(input: {
  authority: DeepRepairExecutionAuthority;
  authoritySha256: string;
  plan: DeepRepairExperimentPlan;
  nextSequence: number;
}): void {
  const { authority, plan, nextSequence } = input;
  const target = plan.sequence[nextSequence];
  const wave = target && plan.manifest.waves.find((candidate) => candidate.waveId === target.waveId);
  if (
    !target
    || !wave
    || authority.planSha256 !== plan.planSha256
    || authority.manifestSha256 !== plan.manifestSha256
    || authority.sequence !== nextSequence
    || authority.waveId !== target.waveId
    || authority.cohortSha256 !== wave.cohort.sha256
    || authority.grantId !== target.grantId
    || authority.inputSha256 !== target.inputSha256
    || authority.attachmentManifestSha256 !== target.attachmentManifestSha256
    || authority.model !== plan.manifest.policy.model
    || authority.promptVersion !== plan.manifest.policy.promptVersion
    || authority.validatorVersion !== plan.manifest.provenance.validatorVersion
    || authority.qualityPolicyVersion !== plan.manifest.policy.qualityPolicyVersion
  ) {
    throw rejection("authority_binding_mismatch", "authority가 plan의 exact next target/policy와 일치하지 않습니다.", true);
  }
}

function assertApprovalBinding(
  approval: DeepRepairUserApproval,
  authority: DeepRepairExecutionAuthority,
): void {
  if (
    approval.planSha256 !== authority.planSha256
    || approval.planArtifactSha256 !== authority.planArtifactSha256
    || approval.parentReceiptSha256 !== authority.parentReceiptSha256
    || approval.sequence !== authority.sequence
    || approval.waveId !== authority.waveId
    || approval.grantId !== authority.grantId
    || approval.model !== authority.model
    || approval.promptVersion !== authority.promptVersion
    || approval.stopAfter !== "one-target"
  ) {
    throw rejection(
      "approval_binding_mismatch",
      "사용자 승인 artifact가 authority의 exact plan/parent/target/policy와 일치하지 않습니다.",
      true,
    );
  }
}

function assertLiveStartBinding(
  start: DeepRepairLiveStart,
  input: {
    authority: DeepRepairExecutionAuthority;
    authoritySha256: string;
    plan: DeepRepairExperimentPlan;
    target: DeepRepairExperimentPlan["sequence"][number];
    nextSequence: number;
  },
): void {
  if (
    start.planSha256 !== input.plan.planSha256
    || start.parentReceiptSha256 !== input.authority.parentReceiptSha256
    || start.authoritySha256 !== input.authoritySha256
    || start.attemptId !== input.authority.attemptId
    || start.target.sequence !== input.nextSequence
    || start.target.waveId !== input.target.waveId
    || start.target.grantId !== input.target.grantId
  ) {
    throw rejection("authority_binding_mismatch", "existing plan slot이 요청 authority와 다릅니다.", true);
  }
}

function assertLiveReceiptBinding(
  receipt: DeepRepairLiveReceipt,
  input: {
    authority: DeepRepairExecutionAuthority;
    authoritySha256: string;
    plan: DeepRepairExperimentPlan;
    target: DeepRepairExperimentPlan["sequence"][number];
    nextSequence: number;
  },
): void {
  if (
    receipt.planSha256 !== input.plan.planSha256
    || receipt.manifestSha256 !== input.plan.manifestSha256
    || receipt.parentReceiptSha256 !== input.authority.parentReceiptSha256
    || receipt.authoritySha256 !== input.authoritySha256
    || receipt.attemptId !== input.authority.attemptId
    || receipt.target.sequence !== input.nextSequence
    || receipt.target.waveId !== input.target.waveId
    || receipt.target.grantId !== input.target.grantId
  ) {
    throw rejection("authority_binding_mismatch", "terminal receipt가 요청 authority/plan slot과 다릅니다.", true);
  }
}

async function assertContentAddressedReceipt(
  repository: DeepRepairLiveArtifactRepository,
  receipt: DeepRepairLiveReceipt,
): Promise<void> {
  const artifact = await repository.readLiveReceipt(receipt.receiptSha256);
  if (!artifact) {
    throw rejection("parent_receipt_invalid", "content-addressed terminal receipt가 없습니다.", true);
  }
  const stored = normalizeLiveReceipt(parseStoredJson(artifact, "content-addressed terminal receipt"));
  if (canonicalJson(stored) !== canonicalJson(receipt)) {
    throw rejection("parent_receipt_invalid", "terminal과 content-addressed receipt가 다릅니다.", true);
  }
}

function assertCohortArtifactBinding(
  value: unknown,
  plan: DeepRepairExperimentPlan,
  waveId: string,
): void {
  try {
    const source = asRecord(value, "cohort");
    const wave = plan.manifest.waves.find((candidate) => candidate.waveId === waveId);
    if (!wave) throw new Error("wave missing");
    const orderedTargets = source.orderedTargets;
    const normalized = {
      schema: literal(source.schema, "deep-repair-cohort-v1", "cohort.schema"),
      seriesId: text(source.seriesId, "cohort.seriesId"),
      waveId: text(source.waveId, "cohort.waveId"),
      selectedAt: isoDate(source.selectedAt, "cohort.selectedAt"),
      seed: Number.isSafeInteger(source.seed) ? source.seed as number : Number.NaN,
      orderedTargets: Array.isArray(orderedTargets)
        ? orderedTargets.map((target, index) => {
            const record = asRecord(target, `cohort.orderedTargets[${index}]`);
            return {
              grantId: text(record.grantId, `cohort.orderedTargets[${index}].grantId`),
              stratum: text(record.stratum, `cohort.orderedTargets[${index}].stratum`),
            };
          })
        : [],
    };
    if (
      !Number.isSafeInteger(normalized.seed)
      || normalized.seriesId !== plan.manifest.seriesId
      || normalized.waveId !== wave.waveId
      || normalized.selectedAt !== wave.cohort.selectedAt
      || normalized.seed !== wave.cohort.seed
      || canonicalJson(normalized.orderedTargets) !== canonicalJson(
        wave.targets.map((target) => ({ grantId: target.grantId, stratum: target.stratum })),
      )
      || canonicalJson(value) !== canonicalJson(normalized)
    ) {
      throw new Error("cohort metadata/order mismatch");
    }
  } catch (error) {
    throw rejection(
      "authority_binding_mismatch",
      `cohort artifact가 plan wave와 결속되지 않았습니다: ${errorMessage(error)}`,
      true,
    );
  }
}

function assertApprovalTime(approval: DeepRepairUserApproval, now: Date): void {
  const approvedAt = new Date(approval.approvedAt).getTime();
  const expiresAt = new Date(approval.expiresAt).getTime();
  if (approvedAt > now.getTime() || expiresAt <= now.getTime()) {
    throw rejection("approval_expired", "사용자 승인이 아직 유효하지 않거나 만료됐습니다.", true);
  }
}

function assertOperationalEvidenceFresh(evidence: DeepRepairOperationalEvidence, now: Date): void {
  const observedAt = new Date(evidence.observedAt).getTime();
  const validUntil = new Date(evidence.validUntil).getTime();
  if (observedAt > now.getTime() || validUntil <= now.getTime() || validUntil <= observedAt) {
    throw rejection("production_guard_stale", "운영 worker observe_only 증거가 아직 유효하지 않거나 만료됐습니다.", true);
  }
}

async function assertExecutionProvenance(
  readCurrent: () => Promise<ExecutionProvenance>,
  expected: DeepRepairExperimentPlan["manifest"]["provenance"],
): Promise<ExecutionProvenance> {
  const current = await readCurrent();
  if (
    current.gitSha !== expected.gitSha
    || current.packageRuntimeSha256 !== expected.packageRuntimeSha256
    || current.validatorVersion !== expected.validatorVersion
  ) {
    throw rejection("execution_provenance_drift", "현재 git/package runtime/validator가 plan provenance와 다릅니다.", true);
  }
  return current;
}

function buildWaveLifecycles(
  plan: DeepRepairExperimentPlan,
  notices: ReadonlyArray<Record<string, unknown>>,
): Array<{ waveId: string; status: "finished" | "unknown" }> {
  const observedWaveIds = new Set(notices.map((notice) => String(notice.waveId)));
  return plan.manifest.waves
    .filter((wave) => observedWaveIds.has(wave.waveId))
    .map((wave) => ({
      waveId: wave.waveId,
      // notices는 exact plan prefix의 terminal publishable/held만 포함한다. 여기서 lifecycle은
      // 아직 모집하지 않은 wave 잔여 target이 아니라 관측된 실행 prefix의 완주 여부다.
      status: "finished" as const,
    }));
}

function buildFormalObservation(input: {
  plan: DeepRepairExperimentPlan;
  target: DeepRepairExperimentPlan["sequence"][number];
  run: LabRun;
  artifactPath: string;
  artifactSha256: string;
}): Record<string, unknown> {
  if (
    input.run.grantId !== input.target.grantId
    || input.run.inputSha256 !== input.target.inputSha256
    || input.run.attachmentManifestSha256 !== input.target.attachmentManifestSha256
    || input.run.model !== input.plan.manifest.policy.model
    || input.run.transport !== input.plan.manifest.policy.transport
    || input.run.promptVersion !== input.plan.manifest.policy.promptVersion
  ) {
    throw rejection("run_artifact_invalid", "run artifact가 exact target/policy binding과 다릅니다.", false);
  }
  const runOutcome = classifyLabRunOutcome(input.run);
  if (runOutcome !== "publishable" && runOutcome !== "held") {
    throw rejection("run_artifact_invalid", "formal observation은 publishable 또는 held run만 허용합니다.", false);
  }
  const provenance = requireRunRepairProvenance(
    input.run,
    input.plan.manifest.policy.gatePolicyVersion,
  );
  const graph = evaluateAnalysisQuality({ run: input.run, review: null, roundtrip: null });
  const inputSealed = graph.nodes.find((node) => node.id === "input_sealed")?.status;
  const deepContract = graph.nodes.find((node) => node.id === "deep_contract")?.status;
  if (!inputSealed || !deepContract || input.run.primaryRepairCount === undefined) {
    throw rejection("run_artifact_invalid", "run artifact에서 formal quality/repair projection을 만들 수 없습니다.", false);
  }
  return {
    waveId: input.target.waveId,
    grantId: input.target.grantId,
    runId: input.run.runId,
    runArtifactPath: input.artifactPath,
    runArtifactSha256: input.artifactSha256,
    inputSha256: input.run.inputSha256,
    attachmentManifestSha256: input.run.attachmentManifestSha256,
    promptVersion: input.run.promptVersion,
    model: input.run.model,
    transport: input.run.transport,
    noticeOutcome: runOutcome,
    primaryRepairCount: input.run.primaryRepairCount,
    deterministicPrimaryRepairCount: provenance.deterministicPrimaryRepairCount,
    modelPrimaryRepairCount: provenance.modelPrimaryRepairCount,
    reviewRepairCount: input.run.reviewRepair ? 1 : 0,
    newIssueAfterRepairCount: provenance.newIssueAfterRepairCount,
    ...(provenance.blockingNewIssueAfterRepairCount === undefined
      ? {}
      : { blockingNewIssueAfterRepairCount: provenance.blockingNewIssueAfterRepairCount }),
    ...(provenance.sourceIncompleteIssueAfterRepairCount === undefined
      ? {}
      : { sourceIncompleteIssueAfterRepairCount: provenance.sourceIncompleteIssueAfterRepairCount }),
    qualityProjection: {
      policyVersion: graph.policyVersion,
      grantId: graph.grantId,
      runId: graph.runId,
      inputSealed,
      deepContract,
    },
  };
}

function parseRunArtifact(bytes: Uint8Array, path: string): LabRun & {
  attachmentManifestSha256?: string;
} {
  try {
    if (!path.trim()) throw new Error("artifact path missing");
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const source = asRecord(parsed, "runArtifact");
    for (const key of ["runId", "grantId", "model", "promptVersion", "inputSha256"] as const) {
      text(source[key], `runArtifact.${key}`);
    }
    if (!Array.isArray(source.inputBlocks) || !Array.isArray(source.axisAssessments)) {
      throw new Error("run artifact arrays missing");
    }
    return parsed as LabRun & { attachmentManifestSha256?: string };
  } catch (error) {
    throw rejection("run_artifact_invalid", `저장된 run artifact를 읽을 수 없습니다: ${errorMessage(error)}`, false);
  }
}

function requireRunRepairProvenance(
  run: LabRun,
  gatePolicyVersion: DeepRepairExperimentPlan["manifest"]["policy"]["gatePolicyVersion"],
): NonNullable<LabRun["primaryRepairProvenance"]> {
  const provenance = run.primaryRepairProvenance;
  if (
    !provenance
    || !Number.isSafeInteger(provenance.deterministicPrimaryRepairCount)
    || provenance.deterministicPrimaryRepairCount < 0
    || !Number.isSafeInteger(provenance.modelPrimaryRepairCount)
    || provenance.modelPrimaryRepairCount < 0
    || !Number.isSafeInteger(provenance.newIssueAfterRepairCount)
    || provenance.newIssueAfterRepairCount < 0
    || (gatePolicyVersion === "repair-sprt-v2" && (
      !Number.isSafeInteger(provenance.blockingNewIssueAfterRepairCount)
      || provenance.blockingNewIssueAfterRepairCount! < 0
      || !Number.isSafeInteger(provenance.sourceIncompleteIssueAfterRepairCount)
      || provenance.sourceIncompleteIssueAfterRepairCount! < 0
      || provenance.blockingNewIssueAfterRepairCount!
        + provenance.sourceIncompleteIssueAfterRepairCount! !== provenance.newIssueAfterRepairCount
    ))
    || provenance.deterministicPrimaryRepairCount + provenance.modelPrimaryRepairCount !== run.primaryRepairCount
  ) {
    throw rejection("run_artifact_invalid", "run artifact의 repair provenance가 없거나 총 repair 횟수와 다릅니다.", false);
  }
  return provenance;
}

function makeLiveReceipt(
  fields: Omit<DeepRepairLiveReceipt, "schema" | "receiptSha256">,
): DeepRepairLiveReceipt {
  const body = { schema: "deep-repair-live-receipt-v1" as const, ...fields };
  return Object.freeze({ ...body, receiptSha256: canonicalSha256(body) });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseStoredJson(artifact: DeepRepairLiveStoredArtifact, label: string): unknown {
  if (!artifact.path.trim() || artifact.bytes.byteLength === 0) {
    throw new Error(`${label} artifact path/bytes missing`);
  }
  try {
    return JSON.parse(Buffer.from(artifact.bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} artifact JSON parse failed: ${errorMessage(error)}`);
  }
}

function parseAttemptArtifact(
  artifact: DeepRepairLiveStoredArtifact,
  label: string,
  _noModelStarted: boolean,
): unknown {
  return parseStoredJson(artifact, label);
}

async function rejectIfAttemptRecovery(input: {
  readonly repository: DeepRepairLiveArtifactRepository;
  readonly artifact: DeepRepairLiveStoredArtifact;
  readonly authority: DeepRepairExecutionAuthority;
  readonly authoritySha256: Sha256;
  readonly plan: DeepRepairExperimentPlan;
  readonly target: DeepRepairExperimentPlan["sequence"][number];
  readonly claimArtifactSha256: Sha256;
}): Promise<void> {
  const parsed = parseStoredJson(input.artifact, "attempt resolution");
  if (schemaOf(parsed) !== "deep-repair-attempt-recovery-v1") return;
  try {
    await validateDeepRepairAttemptRecoveryArtifact({
      reader: input.repository,
      artifact: input.artifact,
      authoritySha256: input.authoritySha256,
      planSha256: input.plan.planSha256,
      manifestSha256: input.plan.manifestSha256,
      seriesId: input.plan.manifest.seriesId,
      attemptId: input.authority.attemptId,
      target: {
        sequence: input.target.sequence,
        waveId: input.target.waveId,
        grantId: input.target.grantId,
      },
      claimArtifactSha256: input.claimArtifactSha256,
    });
  } catch (error) {
    throw rejection(
      "attempt_artifact_invalid",
      `attempt recovery artifact를 검증할 수 없습니다: ${errorMessage(error)}`,
      true,
    );
  }
  throw rejection(
    "attempt_recovered",
    "이 exact attempt는 승인된 recovery receipt로 종결됐습니다.",
    true,
  );
}

function schemaOf(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).schema
    : undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return text(value, label);
}

function sha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256_PATTERN.test(result)) throw new Error(`${label} must be a lowercase SHA-256`);
  return result;
}

function nullableSha(value: unknown, label: string): string | null {
  if (value === null) return null;
  return sha(value, label);
}

function requireSha256(
  value: unknown,
  label: string,
  code: DeepRepairLiveExecutionErrorCode,
): string {
  try {
    return sha(value, label);
  } catch (error) {
    throw rejection(code, errorMessage(error), true);
  }
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

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function zero(value: unknown, label: string): 0 {
  if (value !== 0) throw new Error(`${label} must be zero`);
  return 0;
}

function isoDate(value: unknown, label: string): string {
  const result = text(value, label);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  return result;
}

function rfc3339Timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3}|\.\d{6}|\.\d{9})?Z$/u.test(result)
    || !Number.isFinite(new Date(result).getTime())
  ) {
    throw new Error(`${label} must be a Z-normalized RFC 3339 timestamp`);
  }
  return result;
}

function assertNotAborted(signal: AbortSignal, noModelStarted = true): void {
  if (signal.aborted) {
    throw rejection(
      noModelStarted ? "aborted_before_start" : "aborted_after_start",
      noModelStarted ? "실행 signal이 모델 시작 전에 중단됐습니다." : "모델 착수 뒤 실행 authority가 중단됐습니다.",
      noModelStarted,
    );
  }
}

function rejection(
  code: DeepRepairLiveExecutionErrorCode,
  message: string,
  noModelStarted: boolean,
): DeepRepairLiveExecutionError {
  return new DeepRepairLiveExecutionError(code, message, noModelStarted);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
