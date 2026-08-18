import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/features/dev/analysis-lab/contract";
import { ANALYSIS_QUALITY_POLICY_VERSION } from "@/features/dev/analysis-lab/quality-contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import { createDeepRepairExperimentPlan } from "./deep-repair-experiment";
import {
  createDeepRepairAuthorityIssuer,
  DeepRepairAuthorizationError,
  type DeepRepairAuthorizationDependencies,
  type DeepRepairAuthorizationRepository,
  type DeepRepairAuthorizationStoredArtifact,
} from "./deep-repair-authorization";
import {
  createDeepRepairLiveExperiment,
  DeepRepairLiveExecutionError,
  type DeepRepairLiveArtifactRepository,
} from "./deep-repair-live-experiment";

const SHA = (seed: number): string => seed.toString(16).padStart(64, "0");
const GIT_SHA = "1".repeat(40);
const PACKAGE_SHA = SHA(8_001);
const NOW = new Date("2026-08-14T03:00:00.000Z");
const OWNER_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_OWNER_ID = "223e4567-e89b-42d3-a456-426614174000";
const STRATA = [
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/thick",
  "kstartup/medium",
  "kstartup/thin",
];

function stored(value: unknown, path: string): DeepRepairAuthorizationStoredArtifact {
  return { path, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8") };
}

function canonicalStored(value: unknown, path: string): DeepRepairAuthorizationStoredArtifact {
  return { path, bytes: Buffer.from(`${canonicalJson(value)}\n`, "utf8") };
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cohortArtifact(wave: number): DeepRepairAuthorizationStoredArtifact {
  return stored({
    schema: "deep-repair-cohort-v1",
    seriesId: "deep-v24",
    waveId: `wave-${wave + 1}`,
    selectedAt: "2026-08-14T00:00:00.000Z",
    seed: 20260817,
    orderedTargets: Array.from({ length: 15 }, (_, offset) => {
      const sequence = wave * 15 + offset;
      return {
        grantId: `grant-${sequence.toString().padStart(2, "0")}`,
        stratum: STRATA[sequence % STRATA.length]!,
      };
    }),
  }, `spike-out/analysis-lab/experiments/cohorts/wave-${wave + 1}.json`);
}

function fixture() {
  const cohorts = [cohortArtifact(0), cohortArtifact(1)];
  const plan = createDeepRepairExperimentPlan({
    schema: "deep-repair-series-manifest-v1",
    seriesId: "deep-v24",
    objective: "deep-primary-repair-rate",
    mode: "formal",
    formation: "prospective",
    strataVersion: "deep-repair-strata-v1",
    provenance: {
      status: "complete",
      unavailable: [],
      gitSha: GIT_SHA,
      packageRuntimeSha256: PACKAGE_SHA,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
    policy: {
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      model: "claude-opus-5",
      transport: "claude-cli",
      qualityPolicyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
      gatePolicyVersion: "repair-sprt-v2",
    },
    waves: cohorts.map((cohort, wave) => ({
      waveId: `wave-${wave + 1}`,
      cohort: {
        artifactPath: cohort.path,
        sha256: rawSha256(cohort.bytes),
        selectedAt: "2026-08-14T00:00:00.000Z",
        seed: 20260817,
      },
      targets: Array.from({ length: 15 }, (_, offset) => {
        const sequence = wave * 15 + offset;
        return {
          grantId: `grant-${sequence.toString().padStart(2, "0")}`,
          stratum: STRATA[sequence % STRATA.length]!,
          inputSha256: SHA(1_000 + sequence),
          attachmentManifestSha256: SHA(2_000 + sequence),
        };
      }),
    })),
  });
  const planArtifact = stored(
    plan,
    `spike-out/analysis-lab/experiments/plans/${plan.planSha256}.json`,
  );
  const planArtifactSha256 = rawSha256(planArtifact.bytes);
  const proposal = {
    schema: "deep-repair-proposal-v1",
    preparedAt: "2026-08-14T02:45:00.000Z",
    policy: {
      seriesId: "deep-v24",
      seed: 20260817,
      supplementalSeed: 20260818,
      targetCount: 30,
      waveSize: 15,
      objective: plan.manifest.objective,
      model: plan.manifest.policy.model,
      transport: plan.manifest.policy.transport,
      promptVersion: plan.manifest.policy.promptVersion,
      qualityPolicyVersion: plan.manifest.policy.qualityPolicyVersion,
      gatePolicyVersion: plan.manifest.policy.gatePolicyVersion,
    },
    provenance: plan.manifest.provenance,
    plan: {
      path: planArtifact.path,
      planSha256: plan.planSha256,
      rawSha256: planArtifactSha256,
      manifestSha256: plan.manifestSha256,
    },
    cohorts: plan.manifest.waves.map((wave) => ({
      waveId: wave.waveId,
      path: wave.cohort.artifactPath,
      rawSha256: wave.cohort.sha256,
    })),
    sequence: plan.sequence.map((target) => ({
      sequence: target.sequence,
      waveId: target.waveId,
      grantId: target.grantId,
      source: "bizinfo",
      title: `공고 ${target.sequence}`,
      stratum: target.stratum,
      inputSha256: target.inputSha256,
      attachmentManifestSha256: target.attachmentManifestSha256,
      inputTotalChars: 100,
      inputBlocks: [{ label: "공고 구조화 필드", chars: 100, truncated: false }],
    })),
    safety: {
      artifactKind: "proposal-only",
      liveExecutionAuthorized: false,
      authorityScope: "one-authority-one-target",
      nextTarget: "approved-exact-cohort-authority-required",
      continueVerdictAction: "approved-exact-cohort-authority-required",
      linkedLane: "kordoc-after-publishable-receipt",
      excludedLanes: ["review", "promotion"],
      stopVerdicts: ["GO", "NO_GO", "INCONCLUSIVE", "INVALID"],
    },
    unresolvedGateConditions: [
      "current-production-observe-only-evidence",
      "runtime-generation-and-lease",
      "exact-cohort-approval-and-target-authority",
    ],
  };
  const proposalArtifact = stored(
    proposal,
    "spike-out/analysis-lab/experiments/proposals/pending.json",
  );
  const proposalSha256 = rawSha256(proposalArtifact.bytes);
  const committedProposalArtifact = {
    ...proposalArtifact,
    path: `spike-out/analysis-lab/experiments/proposals/${proposalSha256}.json`,
  };
  const seriesMarker = {
    schema: "deep-repair-series-proposal-v1",
    seriesId: "deep-v24",
    proposalPath: `spike-out/analysis-lab/experiments/proposals/${proposalSha256}.json`,
    proposalSha256,
    planSha256: plan.planSha256,
    planArtifactSha256,
    manifestSha256: plan.manifestSha256,
  };
  const seriesMarkerArtifact = canonicalStored(
    seriesMarker,
    "spike-out/analysis-lab/experiments/series/deep-v24.json",
  );
  const approval = {
    schema: "deep-repair-user-approval-v1",
    proposalSha256,
    planSha256: plan.planSha256,
    planArtifactSha256,
    parentReceiptSha256: null,
    sequence: 0,
    waveId: "wave-1",
    grantId: "grant-00",
    model: plan.manifest.policy.model,
    promptVersion: plan.manifest.policy.promptVersion,
    approvedBy: "user@example.com",
    approvedAt: "2026-08-14T02:58:00.000Z",
    expiresAt: "2026-08-14T03:10:00.000Z",
    stopAfter: "one-target",
  };
  const approvalArtifact = stored(approval, "/approvals/pending.json");
  const approvalSha256 = rawSha256(approvalArtifact.bytes);
  const evidence = {
    schema: "deep-repair-operational-evidence-v1" as const,
    project: "changupnote-com" as const,
    region: "asia-northeast3" as const,
    job: "cunote-deep-analysis" as const,
    workerMode: "observe_only" as const,
    claimScope: "unconfigured" as const,
    jobUid: "cloud-run-job-uid-opaque",
    jobGeneration: "1842",
    jobEtag: "BwY8xj88K1Q",
    jobUpdateTime: "2026-08-14T02:54:31.123456Z",
    imageDigest: `sha256:${SHA(42)}`,
    gitCommitSha: GIT_SHA,
    observedAt: "2026-08-14T02:59:00.000Z",
    validUntil: "2026-08-14T03:14:00.000Z",
  };
  const calls: string[] = [];

  class MemoryRepository implements DeepRepairAuthorizationRepository {
    readonly approvals = new Map([[approvalSha256, approvalArtifact]]);
    readonly seriesMarkers = new Map([["deep-v24", seriesMarkerArtifact]]);
    readonly proposals = new Map([[proposalSha256, committedProposalArtifact]]);
    readonly plans = new Map([[plan.planSha256, planArtifact]]);
    readonly cohortArtifacts = new Map(cohorts.map((artifact) => [artifact.path, artifact]));
    readonly receipts = new Map<string, DeepRepairAuthorizationStoredArtifact>();
    readonly attempts = new Map<string, DeepRepairAuthorizationStoredArtifact>();
    readonly evidences = new Map<string, DeepRepairAuthorizationStoredArtifact>();
    readonly authorities = new Map<string, DeepRepairAuthorizationStoredArtifact>();
    readonly issuances = new Map<string, DeepRepairAuthorizationStoredArtifact>();

    async readApproval(sha256: string) { return this.approvals.get(sha256) ?? null; }
    async readSeriesMarker(seriesId: string) { return this.seriesMarkers.get(seriesId) ?? null; }
    async readProposal(sha256: string) { return this.proposals.get(sha256) ?? null; }
    async readPlan(sha256: string) { return this.plans.get(sha256) ?? null; }
    async readCohort(path: string) { return this.cohortArtifacts.get(path) ?? null; }
    async readLiveReceipt(sha256: string) { return this.receipts.get(sha256) ?? null; }
    async readAttemptStart(planSha256: string, sequence: number) {
      return this.attempts.get(`${planSha256}:${sequence}`) ?? null;
    }
    async readAttemptTerminal(planSha256: string, sequence: number) {
      return this.attempts.get(`${planSha256}:${sequence}:terminal`) ?? null;
    }
    async readResumeAttemptStart(planSha256: string, sequence: number, receiptSha256: string) {
      return this.attempts.get(`${planSha256}:${sequence}:resume:${receiptSha256}`) ?? null;
    }
    async readOperationalEvidence(sha256: string) { return this.evidences.get(sha256) ?? null; }
    async readAuthority(sha256: string) { return this.authorities.get(sha256) ?? null; }
    async readIssuance(approvalId: string) { return this.issuances.get(approvalId) ?? null; }
    async writeOperationalEvidence(sha256: string, bytes: Uint8Array) {
      calls.push("evidence-write");
      this.evidences.set(sha256, { path: `/evidence/${sha256}.json`, bytes });
    }
    async writeAuthority(sha256: string, bytes: Uint8Array) {
      calls.push("authority-write");
      this.authorities.set(sha256, { path: `/authorities/${sha256}.json`, bytes });
    }
    async claimIssuance(approvalId: string, bytes: Uint8Array) {
      calls.push("issuance-claim");
      if (this.issuances.has(approvalId)) return false;
      this.issuances.set(approvalId, { path: `/issuances/${approvalId}.json`, bytes });
      return true;
    }
  }

  const repository = new MemoryRepository();
  const dependencies: DeepRepairAuthorizationDependencies = {
    repository,
    now: () => NOW,
    createOwnerId: () => OWNER_ID,
    async prepareTarget() {
      calls.push("input");
      return {
        grantId: "grant-00",
        inputSha256: SHA(1_000),
        attachmentManifestSha256: SHA(2_000),
      };
    },
    async readExecutionProvenance() {
      calls.push("provenance");
      return {
        gitSha: GIT_SHA,
        packageRuntimeSha256: PACKAGE_SHA,
        validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      };
    },
    async verifyAdmissionOnlyContinuation() {
      calls.push("continuation-provenance");
    },
    async captureOperationalEvidence() {
      calls.push("gcloud");
      return evidence;
    },
    async readRuntimeControl() {
      calls.push("runtime");
      return {
        mode: "paused",
        generation: 67,
        localOwnerId: null,
        localLeaseExpiresAt: null,
        databaseObservedAt: "2026-08-14T02:59:30.000Z",
        activeDeepLeases: 0,
        activeApplicationLeases: 0,
      };
    },
  };
  const issuer = createDeepRepairAuthorityIssuer(dependencies);
  return {
    plan,
    approval,
    approvalArtifact,
    approvalSha256,
    seriesMarker,
    seriesMarkerArtifact,
    proposalArtifact: committedProposalArtifact,
    planArtifact,
    evidence,
    repository,
    dependencies,
    issuer,
    calls,
  };
}

function installApproval(
  setup: ReturnType<typeof fixture>,
  value: unknown,
  label: string,
): string {
  const artifact = stored(value, `/approvals/${label}.json`);
  const sha256 = rawSha256(artifact.bytes);
  setup.repository.approvals.set(sha256, artifact);
  return sha256;
}

function installParentReceipt(
  setup: ReturnType<typeof fixture>,
  overrides: Record<string, unknown> = {},
): string {
  const body = {
    schema: "deep-repair-live-receipt-v1",
    planSha256: setup.plan.planSha256,
    manifestSha256: setup.plan.manifestSha256,
    parentReceiptSha256: null,
    authoritySha256: SHA(7_001),
    attemptId: "deep-v24-00-parent",
    target: { sequence: 0, waveId: "wave-1", grantId: "grant-00" },
    startedAt: "2026-08-14T02:50:00.000Z",
    finishedAt: "2026-08-14T02:52:00.000Z",
    lifecycle: "finished",
    noticeOutcome: "publishable",
    promotionEligibility: "not_evaluated",
    runArtifactPath: "/runs/parent.json",
    runArtifactSha256: SHA(7_002),
    observationsSha256: SHA(7_003),
    evaluatorReceiptSha256: SHA(7_004),
    observedCount: 1,
    gateVerdict: "CONTINUE",
    nextAction: "awaiting_user_authority",
    failureCode: null,
    ...overrides,
  };
  const receipt = { ...body, receiptSha256: canonicalSha256(body) };
  const artifact = stored(receipt, `/receipts/${receipt.receiptSha256}.json`);
  setup.repository.receipts.set(receipt.receiptSha256, artifact);
  return receipt.receiptSha256;
}

{
  const setup = fixture();
  const result = await setup.issuer.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, "issued");
  assert.match(result.authorityId, /^[a-f0-9]{64}$/u);
  assert.deepEqual(setup.calls, [
    "input",
    "provenance",
    "gcloud",
    "runtime",
    "evidence-write",
    "authority-write",
    "issuance-claim",
  ]);
  const authority = JSON.parse(
    Buffer.from(setup.repository.authorities.get(result.authorityId)!.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(authority.approvalSha256, setup.approvalSha256);
  assert.equal(authority.planSha256, setup.plan.planSha256);
  assert.equal((authority.runtime as Record<string, unknown>).expectedGeneration, 67);
  assert.equal((authority.runtime as Record<string, unknown>).ownerId, OWNER_ID);
  assert.equal(
    (authority.runtime as Record<string, unknown>).databaseObservedAt,
    "2026-08-14T02:59:30.000Z",
  );
  assert.equal((authority.runtime as Record<string, unknown>).activeDeepLeases, 0);
  assert.equal((authority.runtime as Record<string, unknown>).activeApplicationLeases, 0);

  let prepared = 0;
  let executed = 0;
  let runtime = 0;
  let writes = 0;
  const liveRepository: DeepRepairLiveArtifactRepository = {
    readAuthority: (sha256) => setup.repository.readAuthority(sha256),
    readApproval: (sha256) => setup.repository.readApproval(sha256),
    readIssuance: (sha256) => setup.repository.readIssuance(sha256),
    readOperationalEvidence: (sha256) => setup.repository.readOperationalEvidence(sha256),
    readPlan: (sha256) => setup.repository.readPlan(sha256),
    readCohort: (path) => setup.repository.readCohort(path),
    readLiveReceipt: (sha256) => setup.repository.readLiveReceipt(sha256),
    readObservations: async () => null,
    readEvaluatorReceipt: async () => null,
    readRecoveryApproval: async () => null,
    readRecoveryReceipt: async () => null,
    readAttempt: async () => null,
    async claimStart() { writes += 1; return false; },
    async writeObservations() { writes += 1; },
    async writeEvaluatorReceipt() { writes += 1; },
    async commitTerminal() { writes += 1; },
  };
  const liveExperiment = createDeepRepairLiveExperiment({
    repository: liveRepository,
    now: () => NOW,
    currentExecutionProvenance: async () => ({
      gitSha: GIT_SHA,
      packageRuntimeSha256: PACKAGE_SHA,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    }),
    verifyOperationalEvidence: async () => {
      throw new Error("runtime callback 전에 호출되면 안 됩니다");
    },
    readRunArtifact: async () => null,
    runtimeAuthority: {
      async runExclusive() {
        runtime += 1;
        throw new Error("contract stop before model");
      },
    },
    targetExecutor: {
      async prepare(request) {
        prepared += 1;
        const target = setup.plan.sequence[0]!;
        assert.deepEqual(request, {
          grantId: target.grantId,
          inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256,
          model: setup.plan.manifest.policy.model,
          transport: "claude-cli",
          promptVersion: setup.plan.manifest.policy.promptVersion,
          signal: request.signal,
        });
        return {
          binding: {
            grantId: target.grantId,
            inputSha256: target.inputSha256,
            attachmentManifestSha256: target.attachmentManifestSha256!,
          },
          async execute() {
            executed += 1;
            throw new Error("model must not execute in issuer contract test");
          },
        };
      },
    },
  });
  await assert.rejects(
    liveExperiment.runApprovedCanary({
      authorityId: result.authorityId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "runtime_authority_failed"
      && error.noModelStarted,
    "issuer 산출물은 exact issuance marker를 거쳐 live kernel의 runtime 경계까지 도달해야 한다",
  );
  assert.deepEqual({ prepared, runtime, executed, writes }, {
    prepared: 1,
    runtime: 1,
    executed: 0,
    writes: 0,
  });
}

for (const [label, activeDeepLeases, activeApplicationLeases] of [
  ["deep", 1, 0],
  ["application", 0, 1],
] as const) {
  const setup = fixture();
  const issuer = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    async readRuntimeControl() {
      setup.calls.push("runtime");
      return {
        mode: "paused",
        generation: 67,
        localOwnerId: null,
        localLeaseExpiresAt: null,
        databaseObservedAt: "2026-08-14T02:59:30.000Z",
        activeDeepLeases,
        activeApplicationLeases,
      };
    },
  });
  await assert.rejects(
    issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof DeepRepairAuthorizationError
      && error.code === "runtime_not_quiescent",
    `${label} active lease가 있으면 immutable authority를 쓰면 안 된다`,
  );
  assert.deepEqual(setup.calls, ["input", "provenance", "gcloud", "runtime"]);
  assert.equal(setup.repository.authorities.size, 0);
  assert.equal(setup.repository.issuances.size, 0);
}

{
  const setup = fixture();
  setup.repository.approvals.delete(setup.approvalSha256);
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "approval_not_found",
  );
  assert.deepEqual(setup.calls, []);
  assert.equal(setup.repository.authorities.size, 0);
}

{
  const setup = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "aborted",
  );
  assert.deepEqual(setup.calls, []);
  assert.equal(setup.repository.authorities.size, 0);
}

{
  const setup = fixture();
  setup.repository.approvals.set(setup.approvalSha256, {
    ...setup.approvalArtifact,
    bytes: Buffer.concat([Buffer.from(setup.approvalArtifact.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "approval_invalid",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const expiredId = installApproval(setup, {
    ...setup.approval,
    approvedAt: "2026-08-14T02:40:00.000Z",
    expiresAt: "2026-08-14T02:55:00.000Z",
  }, "expired");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: expiredId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "approval_expired",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const overlongId = installApproval(setup, {
    ...setup.approval,
    approvedAt: "2026-08-14T02:50:00.000Z",
    expiresAt: "2026-08-14T03:10:00.001Z",
  }, "overlong-ttl");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: overlongId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "approval_invalid",
    "승인 TTL은 15분을 1ms라도 넘으면 안 된다",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const driftedId = installApproval(setup, {
    ...setup.approval,
    grantId: "grant-not-approved",
  }, "target-drift");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: driftedId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "approval_invalid",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const runtimeActive = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    async readRuntimeControl() {
      setup.calls.push("runtime");
      return {
        mode: "local_subscription",
        generation: 68,
        localOwnerId: OWNER_ID,
        localLeaseExpiresAt: "2026-08-14T03:02:00.000Z",
        databaseObservedAt: "2026-08-14T02:59:30.000Z",
        activeDeepLeases: 0,
        activeApplicationLeases: 0,
      };
    },
  });
  await assert.rejects(
    runtimeActive.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "runtime_not_paused",
  );
  assert.deepEqual(setup.calls, ["input", "provenance", "gcloud", "runtime"]);
  assert.equal(setup.repository.evidences.size, 0);
  assert.equal(setup.repository.authorities.size, 0);
}

{
  const setup = fixture();
  let clock = NOW;
  const originalWriteAuthority = setup.repository.writeAuthority.bind(setup.repository);
  setup.repository.writeAuthority = async (sha256, bytes) => {
    await originalWriteAuthority(sha256, bytes);
    clock = new Date(setup.approval.expiresAt);
  };
  const expiringDuringWrite = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    now: () => clock,
  });
  await assert.rejects(
    expiringDuringWrite.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "approval_expired",
    "immutable artifact write 중 만료된 승인은 issuance claim 직전에 다시 거부해야 한다",
  );
  assert.deepEqual(setup.calls, [
    "input",
    "provenance",
    "gcloud",
    "runtime",
    "evidence-write",
    "authority-write",
  ]);
  assert.equal(setup.repository.issuances.size, 0);
}

{
  const setup = fixture();
  const first = await setup.issuer.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });
  const callsAfterFirst = [...setup.calls];
  const second = await setup.issuer.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });
  assert.deepEqual(second, { kind: "inspected", authorityId: first.authorityId });
  assert.deepEqual(setup.calls, callsAfterFirst, "idempotent inspection must not recapture volatile state");
  assert.equal(setup.repository.authorities.size, 1);
  assert.equal(setup.repository.issuances.size, 1);
}

{
  const setup = fixture();
  let claimArrivals = 0;
  let releaseClaims!: () => void;
  const bothAtClaim = new Promise<void>((resolve) => { releaseClaims = resolve; });
  setup.repository.claimIssuance = async (approvalId, bytes) => {
    setup.calls.push("issuance-claim");
    claimArrivals += 1;
    if (claimArrivals === 2) releaseClaims();
    await bothAtClaim;
    if (setup.repository.issuances.has(approvalId)) return false;
    setup.repository.issuances.set(approvalId, {
      path: `/issuances/${approvalId}.json`,
      bytes,
    });
    return true;
  };
  const competingIssuer = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    createOwnerId: () => SECOND_OWNER_ID,
  });
  const results = await Promise.all([
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    competingIssuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
  ]);

  assert.deepEqual(
    results.map((result) => result.kind).sort(),
    ["inspected", "issued"],
    "동시 발급 중 하나만 approval-key marker를 claim해야 한다",
  );
  assert.equal(
    new Set(results.map((result) => result.authorityId)).size,
    1,
    "race loser도 반드시 marker winner authority를 반환해야 한다",
  );
  assert.equal(setup.repository.issuances.size, 1);
  assert.equal(
    setup.repository.authorities.size,
    2,
    "CAS 전에 기록된 loser authority는 orphan이지만 실행 커널 marker 검증으로 비활성이다",
  );
}

{
  const setup = fixture();
  let reachedStartCheck!: () => void;
  let resumeStartCheck!: () => void;
  const atStartCheck = new Promise<void>((resolve) => { reachedStartCheck = resolve; });
  const resume = new Promise<void>((resolve) => { resumeStartCheck = resolve; });
  const slowRepository = Object.create(setup.repository) as typeof setup.repository;
  slowRepository.readAttemptStart = async (planSha256, sequence) => {
    reachedStartCheck();
    await resume;
    return setup.repository.readAttemptStart(planSha256, sequence);
  };
  const slowIssuer = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    repository: slowRepository,
    createOwnerId: () => SECOND_OWNER_ID,
  });
  const slowResultPromise = slowIssuer.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });
  await atStartCheck;
  const winner = await setup.issuer.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });
  setup.repository.attempts.set(
    `${setup.plan.planSha256}:0`,
    stored({ started: true }, "/attempts/winner/start.json"),
  );
  resumeStartCheck();
  const reconciled = await slowResultPromise;

  assert.deepEqual(
    reconciled,
    { kind: "inspected", authorityId: winner.authorityId },
    "preflight 중 늦게 commit된 issuance는 start conflict보다 우선해 winner로 수렴해야 한다",
  );
}

{
  const setup = fixture();
  setup.repository.claimIssuance = async (approvalId, bytes) => {
    setup.calls.push("issuance-claim");
    setup.repository.issuances.set(approvalId, {
      path: `/issuances/${approvalId}.json`,
      bytes,
    });
    throw new Error("claim response lost after durable commit");
  };
  const result = await setup.issuer.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, "inspected");
  assert.match(result.authorityId, /^[a-f0-9]{64}$/u);
  assert.equal(setup.repository.issuances.size, 1);
  assert.equal(
    setup.repository.authorities.has(result.authorityId),
    true,
    "claim 응답이 유실돼도 durable marker winner를 반환해야 한다",
  );
}

{
  const setup = fixture();
  const first = await setup.issuer.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });
  const authority = JSON.parse(
    Buffer.from(setup.repository.authorities.get(first.authorityId)!.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  authority.inputSha256 = SHA(9_999);
  const forgedAuthority = stored(authority, "/authorities/forged.json");
  const forgedAuthoritySha256 = rawSha256(forgedAuthority.bytes);
  setup.repository.authorities.set(forgedAuthoritySha256, forgedAuthority);
  const originalMarker = JSON.parse(
    Buffer.from(setup.repository.issuances.get(setup.approvalSha256)!.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  setup.repository.issuances.set(setup.approvalSha256, stored({
    ...originalMarker,
    authoritySha256: forgedAuthoritySha256,
  }, "/issuances/forged.json"));
  const callsBeforeInspection = [...setup.calls];

  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "issuance_invalid",
    "기존 issuance도 plan exact input binding을 다시 검증해야 한다",
  );
  assert.deepEqual(setup.calls, callsBeforeInspection, "inspection은 volatile state를 재조회하지 않는다");
}

{
  const setup = fixture();
  setup.repository.seriesMarkers.delete("deep-v24");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "proposal_not_found",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  setup.repository.seriesMarkers.set("deep-v24", stored(
    setup.seriesMarker,
    "spike-out/analysis-lab/experiments/series/deep-v24.json",
  ));
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "proposal_invalid",
    "final series marker는 exact canonical bytes여야 한다",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  setup.repository.proposals.set(setup.approval.proposalSha256, {
    ...setup.proposalArtifact,
    bytes: Buffer.concat([Buffer.from(setup.proposalArtifact.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "proposal_invalid",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const proposal = JSON.parse(
    Buffer.from(setup.proposalArtifact.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  proposal.policy = {
    ...(proposal.policy as Record<string, unknown>),
    seriesId: "other-series",
  };
  const proposalBytes = stored(proposal, "/proposals/other-series.json").bytes;
  const proposalSha256 = rawSha256(proposalBytes);
  const proposalArtifact: DeepRepairAuthorizationStoredArtifact = {
    path: `spike-out/analysis-lab/experiments/proposals/${proposalSha256}.json`,
    bytes: proposalBytes,
  };
  setup.repository.proposals.clear();
  setup.repository.proposals.set(proposalSha256, proposalArtifact);
  setup.repository.seriesMarkers.set("deep-v24", canonicalStored({
    ...setup.seriesMarker,
    proposalPath: proposalArtifact.path,
    proposalSha256,
  }, "spike-out/analysis-lab/experiments/series/deep-v24.json"));
  const approvalId = installApproval(setup, {
    ...setup.approval,
    proposalSha256,
  }, "wrong-proposal-series");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "proposal_invalid",
    "deep-v24 final marker는 다른 series proposal을 발급할 수 없어야 한다",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const proposal = JSON.parse(
    Buffer.from(setup.proposalArtifact.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  proposal.safety = {
    ...(proposal.safety as Record<string, unknown>),
    continueVerdictAction: "automatic-next-target",
  };
  const proposalBytes = stored(proposal, "/proposals/unsafe-continuation.json").bytes;
  const proposalSha256 = rawSha256(proposalBytes);
  const proposalArtifact: DeepRepairAuthorizationStoredArtifact = {
    path: `spike-out/analysis-lab/experiments/proposals/${proposalSha256}.json`,
    bytes: proposalBytes,
  };
  setup.repository.proposals.clear();
  setup.repository.proposals.set(proposalSha256, proposalArtifact);
  setup.repository.seriesMarkers.set("deep-v24", canonicalStored({
    ...setup.seriesMarker,
    proposalPath: proposalArtifact.path,
    proposalSha256,
  }, "spike-out/analysis-lab/experiments/series/deep-v24.json"));
  const approvalId = installApproval(setup, {
    ...setup.approval,
    proposalSha256,
  }, "unsafe-proposal-continuation");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "proposal_invalid",
    "자동 continuation을 선언한 proposal에는 authority를 발급하면 안 된다",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  setup.repository.plans.set(setup.plan.planSha256, {
    ...setup.planArtifact,
    bytes: Buffer.concat([Buffer.from(setup.planArtifact.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "plan_invalid",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const cohortPath = setup.plan.manifest.waves[0]!.cohort.artifactPath;
  const cohort = setup.repository.cohortArtifacts.get(cohortPath)!;
  setup.repository.cohortArtifacts.set(cohortPath, {
    ...cohort,
    bytes: Buffer.concat([Buffer.from(cohort.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "cohort_invalid",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const targetDrift = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    async prepareTarget() {
      setup.calls.push("input");
      return {
        grantId: "grant-00",
        inputSha256: SHA(9_101),
        attachmentManifestSha256: SHA(2_000),
      };
    },
  });
  await assert.rejects(
    targetDrift.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "target_drift",
  );
  assert.deepEqual(setup.calls, ["input"]);
}

{
  const setup = fixture();
  const provenanceDrift = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    async readExecutionProvenance() {
      setup.calls.push("provenance");
      return {
        gitSha: GIT_SHA,
        packageRuntimeSha256: SHA(9_102),
        validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      };
    },
  });
  await assert.rejects(
    provenanceDrift.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "provenance_drift",
  );
  assert.deepEqual(setup.calls, ["input", "provenance"]);
}

{
  const setup = fixture();
  const deployedGitSha = "2".repeat(40);
  const independentOperationalProvenance = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    async captureOperationalEvidence() {
      setup.calls.push("gcloud");
      return { ...setup.evidence, gitCommitSha: deployedGitSha };
    },
  });
  const issued = await independentOperationalProvenance.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });
  assert.equal(issued.kind, "issued");
  const authorityArtifact = setup.repository.authorities.get(issued.authorityId);
  assert.ok(authorityArtifact);
  const issuedAuthority = JSON.parse(Buffer.from(authorityArtifact.bytes).toString("utf8")) as {
    operationalEvidenceSha256: string;
  };
  const evidenceArtifact = setup.repository.evidences.get(
    issuedAuthority.operationalEvidenceSha256,
  );
  assert.ok(evidenceArtifact);
  const storedEvidence = JSON.parse(Buffer.from(evidenceArtifact.bytes).toString("utf8")) as {
    gitCommitSha: string;
  };
  assert.equal(storedEvidence.gitCommitSha, deployedGitSha);
  assert.notEqual(storedEvidence.gitCommitSha, setup.plan.manifest.provenance.gitSha);

  const inspected = await independentOperationalProvenance.issueApprovedDeepRepairAuthority({
    approvalId: setup.approvalSha256,
    signal: new AbortController().signal,
  });
  assert.deepEqual(inspected, { kind: "inspected", authorityId: issued.authorityId });
  assert.deepEqual(setup.calls, [
    "input",
    "provenance",
    "gcloud",
    "runtime",
    "evidence-write",
    "authority-write",
    "issuance-claim",
  ]);
}

{
  const setup = fixture();
  const parentReceiptSha256 = installParentReceipt(setup);
  const approvalId = installApproval(setup, {
    ...setup.approval,
    parentReceiptSha256,
    sequence: 1,
    grantId: "grant-01",
  }, "sequence-01");
  const nextIssuer = createDeepRepairAuthorityIssuer({
    ...setup.dependencies,
    async prepareTarget() {
      setup.calls.push("input");
      return {
        grantId: "grant-01",
        inputSha256: SHA(1_001),
        attachmentManifestSha256: SHA(2_001),
      };
    },
  });
  const result = await nextIssuer.issueApprovedDeepRepairAuthority({
    approvalId,
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "issued");
  const authority = JSON.parse(
    Buffer.from(setup.repository.authorities.get(result.authorityId)!.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(authority.parentReceiptSha256, parentReceiptSha256);
  assert.equal(authority.sequence, 1);
  assert.equal(authority.grantId, "grant-01");
}

{
  const setup = fixture();
  const parentReceiptSha256 = installParentReceipt(setup, {
    gateVerdict: "GO",
    nextAction: "stopped",
  });
  const approvalId = installApproval(setup, {
    ...setup.approval,
    parentReceiptSha256,
    sequence: 1,
    grantId: "grant-01",
  }, "terminal-parent");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "parent_not_continuable",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const parentReceiptSha256 = installParentReceipt(setup);
  const approvalId = installApproval(setup, {
    ...setup.approval,
    parentReceiptSha256,
    sequence: 1,
    grantId: "grant-01",
    approvedAt: "2026-08-14T02:51:00.000Z",
    expiresAt: "2026-08-14T03:05:00.000Z",
  }, "preapproved-before-parent-finished");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "approval_invalid",
    "다음 target 승인은 immediate parent 결과가 완결된 뒤에만 유효해야 한다",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const parentReceiptSha256 = installParentReceipt(setup, { unboundNote: "not canonical" });
  const approvalId = installApproval(setup, {
    ...setup.approval,
    parentReceiptSha256,
    sequence: 1,
    grantId: "grant-01",
  }, "non-canonical-parent");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "parent_invalid",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const parentReceiptSha256 = installParentReceipt(setup, {
    parentReceiptSha256: SHA(9_701),
    target: { sequence: 1, waveId: "wave-1", grantId: "grant-01" },
    observedCount: 2,
  });
  const approvalId = installApproval(setup, {
    ...setup.approval,
    parentReceiptSha256,
    sequence: 2,
    grantId: "grant-02",
  }, "missing-ancestry");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "parent_invalid",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const oldestSha = installParentReceipt(setup);
  const oldestArtifact = setup.repository.receipts.get(oldestSha)!;
  const tamperedOldest = JSON.parse(
    Buffer.from(oldestArtifact.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  tamperedOldest.target = { sequence: 0, waveId: "wave-1", grantId: "tampered" };
  setup.repository.receipts.set(oldestSha, stored(tamperedOldest, oldestArtifact.path));
  const parentReceiptSha256 = installParentReceipt(setup, {
    parentReceiptSha256: oldestSha,
    target: { sequence: 1, waveId: "wave-1", grantId: "grant-01" },
    observedCount: 2,
  });
  const approvalId = installApproval(setup, {
    ...setup.approval,
    parentReceiptSha256,
    sequence: 2,
    grantId: "grant-02",
  }, "tampered-ancestry");
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "parent_invalid",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  setup.repository.attempts.set(
    `${setup.plan.planSha256}:0`,
    stored({ existing: true }, "/attempts/existing-start.json"),
  );
  await assert.rejects(
    setup.issuer.issueApprovedDeepRepairAuthority({
      approvalId: setup.approvalSha256,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairAuthorizationError
      && error.code === "issuance_conflict",
  );
  assert.deepEqual(setup.calls, []);
}

{
  const setup = fixture();
  const failureCode =
    "Claude CLI Max 구독 인증을 증명하지 못했습니다. 모델을 시작하지 않습니다. `claude auth status --json`에서 claude.ai/firstParty/max 로그인을 확인하세요.";
  const failedBody = {
    schema: "deep-repair-live-receipt-v1",
    planSha256: setup.plan.planSha256,
    manifestSha256: setup.plan.manifestSha256,
    parentReceiptSha256: null,
    authoritySha256: SHA(8_100),
    attemptId: "deep-v24-00-failed",
    target: { sequence: 0, waveId: "wave-1", grantId: "grant-00" },
    startedAt: "2026-08-14T02:54:00.000Z",
    finishedAt: "2026-08-14T02:55:00.000Z",
    lifecycle: "finished",
    noticeOutcome: "failed",
    promotionEligibility: "not_evaluated",
    runArtifactPath: "spike-out/analysis-lab/bizinfo__grant-00/run-failed.json",
    runArtifactSha256: SHA(8_101),
    observationsSha256: null,
    evaluatorReceiptSha256: null,
    observedCount: 0,
    gateVerdict: "INVALID",
    nextAction: "stopped",
    failureCode,
  };
  const failedReceipt = {
    ...failedBody,
    receiptSha256: canonicalSha256(failedBody),
  };
  const failedArtifact = stored(failedReceipt, "/attempts/failed/resolution.json");
  setup.repository.attempts.set(
    `${setup.plan.planSha256}:0`,
    stored({ started: true }, "/attempts/failed/claim.json"),
  );
  setup.repository.attempts.set(
    `${setup.plan.planSha256}:0:terminal`,
    failedArtifact,
  );
  setup.repository.receipts.set(failedReceipt.receiptSha256, failedArtifact);
  const continuation = {
    reason: "admission-only-max-auth-resume",
    resumeOfReceiptSha256: failedReceipt.receiptSha256,
    admissionProvenance: {
      gitSha: GIT_SHA,
      packageRuntimeSha256: PACKAGE_SHA,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
  };
  const approvalId = installApproval(setup, {
    ...setup.approval,
    schema: "deep-repair-user-continuation-approval-v1",
    continuation,
  }, "max-auth-resume");
  const result = await setup.issuer.issueApprovedDeepRepairAuthority({
    approvalId,
    signal: new AbortController().signal,
  });
  const authority = JSON.parse(Buffer.from(
    setup.repository.authorities.get(result.authorityId)!.bytes,
  ).toString("utf8")) as Record<string, unknown>;
  assert.equal(authority.schema, "deep-repair-execution-authority-v2");
  assert.deepEqual(authority.continuation, continuation);
  assert.equal(setup.calls.includes("continuation-provenance"), true);
  assert.equal(
    setup.repository.attempts.has(
      `${setup.plan.planSha256}:0:resume:${failedReceipt.receiptSha256}`,
    ),
    false,
    "authority 발급은 resume start를 미리 쓰지 않는다",
  );
}

console.log("deep-repair-authorization tests: ok");
