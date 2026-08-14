import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDeepRepairExperimentPlan } from "./deep-repair-experiment";
import {
  createDeepRepairRecovery,
  DeepRepairRecoveryError,
  type DeepRepairRecoveryDependencies,
  type DeepRepairRecoveryRepository,
  type DeepRepairRecoveryRuntimeSnapshot,
  type DeepRepairRecoveryStoredArtifact,
} from "./deep-repair-recovery";

const SHA = (seed: number): string => seed.toString(16).padStart(64, "0");
const OWNER_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-08-14T06:00:00.000Z");
const STRATA = [
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/thick",
  "kstartup/medium",
  "kstartup/thin",
] as const;

await testExpiredLeaseNoStartRecovery();
await testTerminalPreservingRuntimeRecovery();
await testPersistedStartPausedRecovery();
await testInspectionDoesNotMutate();
await testIdempotentRecoverySurvivesExpiredApproval();
await testAttemptCasResponseLossIsReconciled();
await testFailClosedBindings();
await testAttemptRaceAfterRuntimeRecovery();

console.log("deep-repair-recovery tests passed");

async function testTerminalPreservingRuntimeRecovery(): Promise<void> {
  const fixture = createFixture({ attempt: "terminal", runtime: "expired" });
  const terminalBytesBefore = Buffer.from(fixture.resolution!.bytes);
  const recovery = createDeepRepairRecovery(fixture.dependencies);

  const result = await recovery.recoverApproved({
    approvalId: fixture.recoveryApprovalSha256,
    signal: new AbortController().signal,
  });
  const receipt = result.receipt as unknown as Record<string, unknown>;

  assert.equal(receipt.recoveryKind, "runtime_cleanup");
  assert.equal(receipt.seriesDisposition, "unchanged");
  assert.equal(receipt.modelExecution, "finished");
  assert.equal(fixture.runtimeRecoverCalls, 1);
  assert.deepEqual(fixture.claimCalls, { claim: 0, resolution: 0 });
  assert.deepEqual(fixture.resolution?.bytes, terminalBytesBefore);
  const inspected = await recovery.inspect({ authorityId: fixture.authoritySha256 });
  assert.equal(inspected.disposition, "already_recovered");
  assert.equal(inspected.attempt.resolutionArtifactSha256, rawSha256(terminalBytesBefore));
  assert.deepEqual(inspected.receipt, result.receipt);
}

async function testExpiredLeaseNoStartRecovery(): Promise<void> {
  const fixture = createFixture({ attempt: "none", runtime: "expired" });
  const recovery = createDeepRepairRecovery(fixture.dependencies);

  const result = await recovery.recoverApproved({
    approvalId: fixture.recoveryApprovalSha256,
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, "recovered");
  assert.equal(fixture.runtimeRecoverCalls, 1);
  assert.deepEqual(fixture.claimCalls, { claim: 0, resolution: 0 });
  assert.equal(result.receipt.schema, "deep-repair-runtime-cleanup-v1");
  if (result.receipt.schema !== "deep-repair-runtime-cleanup-v1") {
    throw new Error("no-start recovery must only clean up runtime");
  }
  assert.equal(result.receipt.recoveryKind, "runtime_cleanup");
  assert.equal(result.receipt.observedAttempt.state, "no_start");
  assert.equal(result.receipt.modelExecution, "not_started");
  assert.equal(result.receipt.seriesDisposition, "unchanged");
  assert.equal(result.receipt.statisticalContribution, "none");
  assert.equal(result.receipt.automaticRetryAuthorized, false);
  assert.equal(result.receipt.sameTargetRetryAuthorized, false);
  assert.equal(result.receipt.promotionEligibility, "not_evaluated");
  assert.equal("successorSeriesId" in result.receipt, false);
  assert.equal(fixture.claim, null);
  assert.equal("gateVerdict" in result.receipt, false);
  assert.equal("observedCount" in result.receipt, false);
  assert.equal("noticeOutcome" in result.receipt, false);
  assert.equal(
    canonicalSha256(bodyWithoutReceiptSha(result.receipt)),
    result.receipt.receiptSha256,
  );
  assert.deepEqual(fixture.runtime, {
    mode: "paused",
    generation: 43,
    localOwnerId: null,
    localLeaseExpiresAt: null,
    changedBy: "lab:experiment:recover",
    changeReason: `deep-repair-recovery:${fixture.recoveryApprovalSha256}`,
    updatedAt: NOW.toISOString(),
  });
  const inspected = await recovery.inspect({ authorityId: fixture.authoritySha256 });
  assert.equal(inspected.disposition, "already_recovered");
  assert.equal(inspected.attempt.state, "no_start");
  assert.deepEqual(inspected.receipt, result.receipt);
}

async function testPersistedStartPausedRecovery(): Promise<void> {
  const fixture = createFixture({ attempt: "start", runtime: "paused-after-release" });
  const recovery = createDeepRepairRecovery(fixture.dependencies);
  const result = await recovery.recoverApproved({
    approvalId: fixture.recoveryApprovalSha256,
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, "recovered");
  assert.equal(fixture.runtimeRecoverCalls, 0);
  assert.equal(fixture.claimCalls.claim, 0);
  assert.equal(fixture.claimCalls.resolution, 1);
  assert.equal(result.receipt.observedAttempt.state, "start_persisted_without_terminal");
  assert.equal(result.receipt.observedAttempt.claimArtifactSha256, fixture.startSha256);
  assert.equal(result.receipt.modelExecution, "unknown");
  assert.deepEqual(result.receipt.runtime.before, result.receipt.runtime.after);
}

async function testInspectionDoesNotMutate(): Promise<void> {
  const fixture = createFixture({ attempt: "start", runtime: "expired" });
  const recovery = createDeepRepairRecovery(fixture.dependencies);
  const inspected = await recovery.inspect({ authorityId: fixture.authoritySha256 });

  assert.equal(inspected.disposition, "approval_required");
  assert.equal(inspected.attempt.state, "start_persisted_without_terminal");
  assert.equal(inspected.attempt.modelExecution, "unknown");
  assert.equal(inspected.runtimeDisposition, "expired_lease_recovery_required");
  assert.equal(fixture.runtimeRecoverCalls, 0);
  assert.deepEqual(fixture.claimCalls, { claim: 0, resolution: 0 });
}

async function testIdempotentRecoverySurvivesExpiredApproval(): Promise<void> {
  const fixture = createFixture({ attempt: "none", runtime: "expired" });
  const recovery = createDeepRepairRecovery(fixture.dependencies);
  const first = await recovery.recoverApproved({
    approvalId: fixture.recoveryApprovalSha256,
    signal: new AbortController().signal,
  });
  fixture.setNow(new Date("2026-08-14T07:00:00.000Z"));
  const second = await recovery.recoverApproved({
    approvalId: fixture.recoveryApprovalSha256,
    signal: new AbortController().signal,
  });

  assert.equal(second.kind, "inspected");
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(fixture.runtimeRecoverCalls, 1);
  assert.deepEqual(fixture.claimCalls, { claim: 0, resolution: 0 });
}

async function testAttemptCasResponseLossIsReconciled(): Promise<void> {
  const fixture = createFixture({ attempt: "start", runtime: "paused-after-release" });
  fixture.throwAfterAttemptClaim = true;
  const recovery = createDeepRepairRecovery(fixture.dependencies);
  const result = await recovery.recoverApproved({
    approvalId: fixture.recoveryApprovalSha256,
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "inspected", "durable CAS를 read-back해야 한다");
  assert.equal(result.receipt.recoveryApprovalSha256, fixture.recoveryApprovalSha256);
  assert.deepEqual(fixture.claimCalls, { claim: 0, resolution: 1 });
}

async function testFailClosedBindings(): Promise<void> {
  const cases: Array<{
    label: string;
    mutate(fixture: ReturnType<typeof createFixture>): void;
    code: string;
  }> = [
    {
      label: "confirmation false",
      mutate: (fixture) => fixture.replaceRecoveryApproval({
        confirmations: {
          localProcessTerminated: false,
          noAutomaticRetry: true,
          preserveExistingArtifacts: true,
        },
      }),
      code: "approval_invalid",
    },
    {
      label: "attempt claim binding drift",
      mutate: (fixture) => fixture.replaceRecoveryApproval({
        expectedAttempt: { state: "present", claimArtifactSha256: SHA(99_999) },
      }),
      code: "attempt_conflict",
    },
    {
      label: "unexpired lease",
      mutate: (fixture) => {
        fixture.runtime = {
          ...fixture.runtime,
          localLeaseExpiresAt: "2026-08-14T06:00:01.000Z",
        };
        fixture.replaceRecoveryApproval({ expectedRuntime: minimalRuntime(fixture.runtime) });
      },
      code: "runtime_not_recoverable",
    },
  ];

  for (const testCase of cases) {
    const fixture = createFixture({ attempt: "start", runtime: "expired" });
    testCase.mutate(fixture);
    const recovery = createDeepRepairRecovery(fixture.dependencies);
    await assert.rejects(
      recovery.recoverApproved({
        approvalId: fixture.recoveryApprovalSha256,
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof DeepRepairRecoveryError && error.code === testCase.code,
      testCase.label,
    );
    assert.equal(fixture.runtimeRecoverCalls, 0, `${testCase.label}: runtime mutation`);
    assert.deepEqual(
      fixture.claimCalls,
      { claim: 0, resolution: 0 },
      `${testCase.label}: attempt mutation`,
    );
  }
}

async function testAttemptRaceAfterRuntimeRecovery(): Promise<void> {
  const fixture = createFixture({ attempt: "none", runtime: "expired" });
  fixture.afterRuntimeRecover = () => {
    fixture.claim = fixture.startArtifact;
  };
  const recovery = createDeepRepairRecovery(fixture.dependencies);
  await assert.rejects(
    recovery.recoverApproved({
      approvalId: fixture.recoveryApprovalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof DeepRepairRecoveryError
      && error.code === "attempt_conflict",
  );
  assert.equal(fixture.runtimeRecoverCalls, 1);
  assert.deepEqual(fixture.claimCalls, { claim: 0, resolution: 0 });
  assert.equal(fixture.recoveryReceipts.size, 0);
}

function createFixture(options: {
  attempt: "none" | "start" | "terminal";
  runtime: "expired" | "paused-after-release";
}) {
  const plan = createPlan();
  const planArtifact = prettyStored(plan, `/plans/${plan.planSha256}.json`);
  const planArtifactSha256 = rawSha256(planArtifact.bytes);
  const target = plan.sequence[0]!;
  const originalApprovalSha256 = SHA(7_001);
  const authority = {
    schema: "deep-repair-execution-authority-v1",
    attemptId: "deep-v18-00-authority",
    planSha256: plan.planSha256,
    planArtifactSha256,
    manifestSha256: plan.manifestSha256,
    parentReceiptSha256: null,
    sequence: target.sequence,
    waveId: target.waveId,
    cohortSha256: plan.manifest.waves[0]!.cohort.sha256,
    grantId: target.grantId,
    inputSha256: target.inputSha256,
    attachmentManifestSha256: target.attachmentManifestSha256,
    lane: "deep-primary",
    transport: "claude-cli",
    model: plan.manifest.policy.model,
    promptVersion: plan.manifest.policy.promptVersion,
    validatorVersion: plan.manifest.provenance.validatorVersion,
    qualityPolicyVersion: plan.manifest.policy.qualityPolicyVersion,
    runtime: {
      ownerId: OWNER_ID,
      expectedGeneration: 41,
      databaseObservedAt: "2026-08-14T05:57:30.000Z",
      activeDeepLeases: 0,
      activeApplicationLeases: 0,
    },
    operationalEvidenceSha256: SHA(7_002),
    approvalSha256: originalApprovalSha256,
  } as const;
  const authorityArtifact = prettyStored(authority, "/authorities/pending.json");
  const authoritySha256 = rawSha256(authorityArtifact.bytes);
  const issuance = prettyStored({
    schema: "deep-repair-authority-issuance-v1",
    approvalSha256: originalApprovalSha256,
    operationalEvidenceSha256: authority.operationalEvidenceSha256,
    authoritySha256,
  }, `/issued-authorities/${originalApprovalSha256}.json`);
  const start = {
    schema: "deep-repair-live-start-v1",
    planSha256: plan.planSha256,
    parentReceiptSha256: null,
    authoritySha256,
    attemptId: authority.attemptId,
    target: {
      sequence: target.sequence,
      waveId: target.waveId,
      grantId: target.grantId,
    },
    startedAt: "2026-08-14T05:55:00.000Z",
  } as const;
  const startArtifact = prettyStored(start, "/attempts/claim.json");
  const startSha256 = rawSha256(startArtifact.bytes);
  const terminalBody = {
    schema: "deep-repair-live-receipt-v1",
    planSha256: plan.planSha256,
    manifestSha256: plan.manifestSha256,
    parentReceiptSha256: null,
    authoritySha256,
    attemptId: authority.attemptId,
    target: start.target,
    startedAt: start.startedAt,
    finishedAt: "2026-08-14T05:58:00.000Z",
    lifecycle: "finished",
    noticeOutcome: "failed",
    promotionEligibility: "not_evaluated",
    runArtifactPath: null,
    runArtifactSha256: null,
    observationsSha256: null,
    evaluatorReceiptSha256: null,
    observedCount: 0,
    gateVerdict: "INVALID",
    nextAction: "stopped",
    failureCode: "fixture",
  } as const;
  const terminalReceipt = {
    ...terminalBody,
    receiptSha256: canonicalSha256(terminalBody),
  };
  const terminalArtifact = prettyStored(terminalReceipt, "/attempts/resolution.json");
  let currentNow = NOW;
  let runtime: DeepRepairRecoveryRuntimeSnapshot = options.runtime === "expired"
    ? {
        mode: "local_subscription",
        generation: 42,
        localOwnerId: OWNER_ID,
        localLeaseExpiresAt: "2026-08-14T05:59:00.000Z",
        changedBy: "lab:experiment",
        changeReason: authority.attemptId,
        updatedAt: "2026-08-14T05:57:00.000Z",
      }
    : {
        mode: "paused",
        generation: 43,
        localOwnerId: null,
        localLeaseExpiresAt: null,
        changedBy: "lab:experiment",
        changeReason: authority.attemptId,
        updatedAt: "2026-08-14T05:59:30.000Z",
      };
  let claim: DeepRepairRecoveryStoredArtifact | null = options.attempt === "none"
    ? null
    : startArtifact;
  let resolution: DeepRepairRecoveryStoredArtifact | null = options.attempt === "terminal"
    ? terminalArtifact
    : null;
  let runtimeCleanup: DeepRepairRecoveryStoredArtifact | null = null;
  const recoveryApprovals = new Map<string, DeepRepairRecoveryStoredArtifact>();
  const recoveryReceipts = new Map<string, DeepRepairRecoveryStoredArtifact>();
  const liveReceipts = new Map<string, DeepRepairRecoveryStoredArtifact>([
    [terminalReceipt.receiptSha256, terminalArtifact],
  ]);
  let runtimeRecoverCalls = 0;
  const claimCalls = { claim: 0, resolution: 0 };
  let afterRuntimeRecover: (() => void) | undefined;
  let throwAfterAttemptClaim = false;

  const fixture = {
    authoritySha256,
    startArtifact,
    startSha256,
    recoveryApprovalSha256: "",
    recoveryApproval: {} as Record<string, unknown>,
    recoveryReceipts,
    claimCalls,
    get runtimeRecoverCalls() { return runtimeRecoverCalls; },
    get runtime() { return runtime; },
    set runtime(value: DeepRepairRecoveryRuntimeSnapshot) { runtime = value; },
    get claim() { return claim; },
    set claim(value: DeepRepairRecoveryStoredArtifact | null) { claim = value; },
    get resolution() { return resolution; },
    get afterRuntimeRecover() { return afterRuntimeRecover; },
    set afterRuntimeRecover(value: (() => void) | undefined) { afterRuntimeRecover = value; },
    get throwAfterAttemptClaim() { return throwAfterAttemptClaim; },
    set throwAfterAttemptClaim(value: boolean) { throwAfterAttemptClaim = value; },
    setNow(value: Date) { currentNow = value; },
    replaceRecoveryApproval(patch: Record<string, unknown>) {
      const next = { ...fixture.recoveryApproval, ...patch };
      const artifact = canonicalStored(next, "/recovery-approvals/pending.json");
      const nextSha = rawSha256(artifact.bytes);
      recoveryApprovals.clear();
      recoveryApprovals.set(nextSha, artifact);
      fixture.recoveryApproval = next;
      fixture.recoveryApprovalSha256 = nextSha;
    },
    dependencies: null as unknown as DeepRepairRecoveryDependencies,
  };

  const repository: DeepRepairRecoveryRepository = {
    readRecoveryApproval: async (sha256) => recoveryApprovals.get(sha256) ?? null,
    readAuthority: async (sha256) => sha256 === authoritySha256 ? authorityArtifact : null,
    readIssuance: async (approvalSha256) => approvalSha256 === originalApprovalSha256
      ? issuance
      : null,
    readPlan: async (sha256) => sha256 === plan.planSha256 ? planArtifact : null,
    readLiveReceipt: async (sha256) => liveReceipts.get(sha256) ?? null,
    readAttempt: async () => ({ claim, resolution }),
    readRuntimeCleanup: async () => runtimeCleanup,
    readRecoveryReceipt: async (sha256) => recoveryReceipts.get(sha256) ?? null,
    async writeRecoveryReceipt(sha256, bytes) {
      const existing = recoveryReceipts.get(sha256);
      if (existing && Buffer.compare(existing.bytes, bytes) !== 0) {
        throw new Error("immutable recovery receipt conflict");
      }
      recoveryReceipts.set(sha256, { path: `/recovery-receipts/${sha256}.json`, bytes });
    },
    async claimAttemptResolution(_key, bytes) {
      claimCalls.resolution += 1;
      if (resolution !== null) return false;
      resolution = { path: "/attempts/resolution.json", bytes };
      if (throwAfterAttemptClaim) throw new Error("resolution response lost");
      return true;
    },
    async claimRuntimeCleanup(_key, bytes) {
      if (runtimeCleanup !== null) return false;
      runtimeCleanup = { path: "/attempts/runtime-cleanup.json", bytes };
      return true;
    },
  };
  fixture.dependencies = {
    repository,
    now: () => currentNow,
    runtime: {
      inspect: async () => runtime,
      async recoverExpiredLease(input) {
        runtimeRecoverCalls += 1;
        assert.equal(input.ownerId, OWNER_ID);
        assert.equal(input.expectedGeneration, 42);
        assert.equal(input.expectedLeaseExpiresAt, "2026-08-14T05:59:00.000Z");
        runtime = {
          mode: "paused",
          generation: 43,
          localOwnerId: null,
          localLeaseExpiresAt: null,
          changedBy: "lab:experiment:recover",
          changeReason: input.changeReason,
          updatedAt: currentNow.toISOString(),
        };
        afterRuntimeRecover?.();
        return runtime;
      },
    },
  };

  fixture.recoveryApproval = {
    schema: "deep-repair-recovery-approval-v1",
    authoritySha256,
    planSha256: plan.planSha256,
    manifestSha256: plan.manifestSha256,
    seriesId: "deep-v18",
    attemptId: authority.attemptId,
    target: start.target,
    expectedAttempt: options.attempt === "none"
      ? { state: "absent", claimArtifactSha256: null }
      : options.attempt === "terminal"
        ? {
            state: "terminal",
            claimArtifactSha256: startSha256,
            resolutionArtifactSha256: rawSha256(terminalArtifact.bytes),
          }
        : {
            state: "present",
            claimArtifactSha256: startSha256,
          },
    expectedRuntime: minimalRuntime(runtime),
    approvedBy: "user@example.com",
    approvedAt: "2026-08-14T05:58:00.000Z",
    expiresAt: "2026-08-14T06:10:00.000Z",
    confirmations: {
      localProcessTerminated: true,
      noAutomaticRetry: true,
      preserveExistingArtifacts: true,
    },
    stopAfter: "recovery-only",
  };
  fixture.replaceRecoveryApproval({});
  return fixture;
}

function createPlan() {
  return createDeepRepairExperimentPlan({
    schema: "deep-repair-series-manifest-v1",
    seriesId: "deep-v18",
    objective: "deep-primary-repair-rate",
    mode: "formal",
    formation: "prospective",
    strataVersion: "deep-repair-strata-v1",
    provenance: {
      status: "complete",
      unavailable: [],
      gitSha: "1".repeat(40),
      packageRuntimeSha256: SHA(1),
      validatorVersion: "deep-analysis-validator-v1",
    },
    policy: {
      promptVersion: "lab-deep-v12",
      model: "claude-opus-5",
      transport: "claude-cli",
      qualityPolicyVersion: "analysis-quality-v2",
      gatePolicyVersion: "repair-sprt-v1",
    },
    waves: [0, 1].map((wave) => ({
      waveId: `wave-${wave + 1}`,
      cohort: {
        artifactPath: `/cohorts/wave-${wave + 1}.json`,
        sha256: SHA(100 + wave),
        selectedAt: "2026-08-14T00:00:00.000Z",
        seed: 20260814,
      },
      targets: Array.from({ length: 15 }, (_, offset) => {
        const sequence = wave * 15 + offset;
        return {
          grantId: `grant-${String(sequence).padStart(2, "0")}`,
          stratum: STRATA[sequence % STRATA.length],
          inputSha256: SHA(1_000 + sequence),
          attachmentManifestSha256: SHA(2_000 + sequence),
        };
      }),
    })),
  });
}

function minimalRuntime(runtime: DeepRepairRecoveryRuntimeSnapshot) {
  return {
    mode: runtime.mode,
    generation: runtime.generation,
    localOwnerId: runtime.localOwnerId,
    localLeaseExpiresAt: runtime.localLeaseExpiresAt,
  };
}

function prettyStored(value: unknown, path: string): DeepRepairRecoveryStoredArtifact {
  return { path, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8") };
}

function canonicalStored(value: unknown, path: string): DeepRepairRecoveryStoredArtifact {
  return { path, bytes: Buffer.from(`${canonicalJson(value)}\n`, "utf8") };
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
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function bodyWithoutReceiptSha(value: { readonly receiptSha256: string }): unknown {
  const { receiptSha256: _receiptSha256, ...body } = value;
  return body;
}
