import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import { ANALYSIS_QUALITY_POLICY_VERSION } from "@/features/dev/analysis-lab/quality-contract";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import { createDeepRepairExperimentPlan } from "./deep-repair-experiment";
import {
  createDeepRepairLiveExperiment,
  currentDeepRepairLiveExecutionBinding,
  DeepRepairLiveExecutionError,
  type DeepRepairLiveArtifactRepository,
  type DeepRepairLiveDependencies,
  type DeepRepairLiveStoredArtifact,
} from "./deep-repair-live-experiment";

const SHA = (seed: number): string => seed.toString(16).padStart(64, "0");
const GIT_SHA = "1".repeat(40);
const PACKAGE_SHA = SHA(9001);
const NOW = new Date("2026-08-14T03:00:00.000Z");
const STRATA = [
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/thick",
  "kstartup/medium",
  "kstartup/thin",
];

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

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function stored(value: unknown, path: string): DeepRepairLiveStoredArtifact {
  return { path, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) };
}

function storedSha256(artifact: DeepRepairLiveStoredArtifact): string {
  return createHash("sha256").update(artifact.bytes).digest("hex");
}

const COHORT_ARTIFACTS = [0, 1].map((wave) => stored({
  schema: "deep-repair-cohort-v1",
  seriesId: "deep-v18",
  waveId: `wave-${wave + 1}`,
  selectedAt: "2026-08-14T00:00:00.000Z",
  seed: 20260814 + wave,
  orderedTargets: Array.from({ length: 15 }, (_, offset) => {
    const sequence = wave * 15 + offset;
    return {
      grantId: `grant-${sequence.toString().padStart(2, "0")}`,
      stratum: STRATA[sequence % STRATA.length]!,
    };
  }),
}, `spike-out/analysis-lab/experiments/cohorts/deep-v18-wave-${wave + 1}.json`));

function formalPlan() {
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
      gitSha: GIT_SHA,
      packageRuntimeSha256: PACKAGE_SHA,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
    policy: {
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      model: "claude-opus-5",
      transport: "claude-cli",
      qualityPolicyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
      gatePolicyVersion: "repair-sprt-v1",
    },
    waves: [0, 1].map((wave) => ({
      waveId: `wave-${wave + 1}`,
      cohort: {
        artifactPath: COHORT_ARTIFACTS[wave]!.path,
        sha256: storedSha256(COHORT_ARTIFACTS[wave]!),
        selectedAt: "2026-08-14T00:00:00.000Z",
        seed: 20260814 + wave,
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
}

class MemoryRepository implements DeepRepairLiveArtifactRepository {
  readonly authorities = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly approvals = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly issuances = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly operationalEvidence = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly plans = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly cohorts = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly receipts = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly observations = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly evaluatorReceipts = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly runArtifacts = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly starts = new Map<string, DeepRepairLiveStoredArtifact>();
  readonly terminals = new Map<string, DeepRepairLiveStoredArtifact>();

  async readAuthority(sha256: string) { return this.authorities.get(sha256) ?? null; }
  async readApproval(sha256: string) { return this.approvals.get(sha256) ?? null; }
  async readIssuance(approvalSha256: string) { return this.issuances.get(approvalSha256) ?? null; }
  async readOperationalEvidence(sha256: string) { return this.operationalEvidence.get(sha256) ?? null; }
  async readPlan(sha256: string) { return this.plans.get(sha256) ?? null; }
  async readCohort(path: string) { return this.cohorts.get(path) ?? null; }
  async readLiveReceipt(sha256: string) { return this.receipts.get(sha256) ?? null; }
  async readObservations(sha256: string) { return this.observations.get(sha256) ?? null; }
  async readEvaluatorReceipt(sha256: string) { return this.evaluatorReceipts.get(sha256) ?? null; }
  async readAttempt(key: { planSha256: string; sequence: number }) {
    const slot = `${key.planSha256}:${key.sequence}`;
    const start = this.starts.get(slot);
    if (!start) return null;
    return { start, terminal: this.terminals.get(slot) ?? null };
  }
  async claimStart(key: { planSha256: string; sequence: number }, start: unknown) {
    const slot = `${key.planSha256}:${key.sequence}`;
    if (this.starts.has(slot)) return false;
    this.starts.set(slot, stored(start, `/attempts/${key.planSha256}/${key.sequence}/start.json`));
    return true;
  }
  async writeObservations(sha256: string, value: unknown) {
    assert.equal(canonicalSha256(value), sha256);
    this.observations.set(sha256, stored(value, `/observations/${sha256}.json`));
  }
  async writeEvaluatorReceipt(sha256: string, value: unknown) {
    this.evaluatorReceipts.set(sha256, stored(value, `/evaluator-receipts/${sha256}.json`));
  }
  async commitTerminal(
    key: { planSha256: string; sequence: number },
    receiptSha256: string,
    value: unknown,
  ) {
    const slot = `${key.planSha256}:${key.sequence}`;
    assert.ok(this.starts.has(slot));
    assert.equal(this.terminals.has(slot), false);
    const artifact = stored(value, `/attempts/${key.planSha256}/${key.sequence}/terminal.json`);
    this.terminals.set(slot, artifact);
    this.receipts.set(receiptSha256, artifact);
  }
}

function operationalEvidence() {
  return {
    schema: "deep-repair-operational-evidence-v1",
    project: "changupnote-com",
    region: "asia-northeast3",
    job: "cunote-deep-analysis",
    workerMode: "observe_only",
    claimScope: "unconfigured",
    jobUid: "cloud-run-job-uid-opaque",
    jobGeneration: "1842",
    jobEtag: "BwY8xj88K1Q",
    jobUpdateTime: "2026-08-14T02:54:31.123456Z",
    imageDigest: `sha256:${SHA(42)}`,
    gitCommitSha: GIT_SHA,
    observedAt: "2026-08-14T02:55:00.000Z",
    validUntil: "2026-08-14T03:15:00.000Z",
  };
}

function authority(input: {
  plan: ReturnType<typeof formalPlan>;
  planArtifactSha256: string;
  operationalEvidenceSha256: string;
  approvalSha256: string;
  sequence?: number;
  parentReceiptSha256?: string | null;
}) {
  const sequence = input.sequence ?? 0;
  const target = input.plan.sequence[sequence]!;
  const wave = input.plan.manifest.waves.find((candidate) => candidate.waveId === target.waveId)!;
  return {
    schema: "deep-repair-execution-authority-v1",
    attemptId: `deep-v18-${sequence.toString().padStart(2, "0")}`,
    planSha256: input.plan.planSha256,
    planArtifactSha256: input.planArtifactSha256,
    manifestSha256: input.plan.manifestSha256,
    parentReceiptSha256: input.parentReceiptSha256 ?? null,
    sequence,
    waveId: target.waveId,
    cohortSha256: wave.cohort.sha256,
    grantId: target.grantId,
    inputSha256: target.inputSha256,
    attachmentManifestSha256: target.attachmentManifestSha256!,
    lane: "deep-primary",
    transport: "claude-cli",
    model: input.plan.manifest.policy.model,
    promptVersion: input.plan.manifest.policy.promptVersion,
    validatorVersion: input.plan.manifest.provenance.validatorVersion,
    qualityPolicyVersion: input.plan.manifest.policy.qualityPolicyVersion,
    runtime: { ownerId: "123e4567-e89b-42d3-a456-426614174000", expectedGeneration: 67 },
    operationalEvidenceSha256: input.operationalEvidenceSha256,
    approvalSha256: input.approvalSha256,
  };
}

function userApproval(input: {
  plan: ReturnType<typeof formalPlan>;
  planArtifactSha256: string;
  sequence?: number;
  parentReceiptSha256?: string | null;
  approvedAt?: string;
  expiresAt?: string;
}) {
  const sequence = input.sequence ?? 0;
  const target = input.plan.sequence[sequence]!;
  return {
    schema: "deep-repair-user-approval-v1",
    proposalSha256: SHA(9_000 + sequence),
    planSha256: input.plan.planSha256,
    planArtifactSha256: input.planArtifactSha256,
    parentReceiptSha256: input.parentReceiptSha256 ?? null,
    sequence,
    waveId: target.waveId,
    grantId: target.grantId,
    model: input.plan.manifest.policy.model,
    promptVersion: input.plan.manifest.policy.promptVersion,
    approvedBy: "user@example.com",
    approvedAt: input.approvedAt ?? "2026-08-14T02:58:00.000Z",
    expiresAt: input.expiresAt ?? "2026-08-14T03:10:00.000Z",
    stopAfter: "one-target",
  };
}

function installIssuedAuthority(
  repo: MemoryRepository,
  value: Record<string, unknown> & {
    readonly approvalSha256: string;
    readonly operationalEvidenceSha256: string;
  },
  path: string,
): { readonly artifact: DeepRepairLiveStoredArtifact; readonly sha256: string } {
  const artifact = stored(value, path);
  const sha256 = storedSha256(artifact);
  repo.authorities.set(sha256, artifact);
  repo.issuances.set(value.approvalSha256, stored({
    schema: "deep-repair-authority-issuance-v1",
    approvalSha256: value.approvalSha256,
    operationalEvidenceSha256: value.operationalEvidenceSha256,
    authoritySha256: sha256,
  }, `/issued-authorities/${value.approvalSha256}.json`));
  return { artifact, sha256 };
}

function publishableRun(input: {
  plan: ReturnType<typeof formalPlan>;
  sequence?: number;
  repair?: "none" | "deterministic" | "model";
}): LabRun & Record<string, unknown> {
  const sequence = input.sequence ?? 0;
  const target = input.plan.sequence[sequence]!;
  const repair = input.repair ?? "none";
  const primaryRepairCount = repair === "none" ? 0 : 1;
  return {
    runId: `run-2026-08-14T03010${sequence}.000Z-a1b2c3`,
    grantId: target.grantId,
    source: "bizinfo",
    sourceId: `source-${sequence}`,
    title: `공고 ${sequence}`,
    model: input.plan.manifest.policy.model,
    transport: "claude-cli",
    promptVersion: input.plan.manifest.policy.promptVersion,
    startedAt: "2026-08-14T03:01:00.000Z",
    durationMs: 1_000,
    inputBlocks: [{ label: "공고 구조화 필드", chars: 100, truncated: false }],
    inputTotalChars: 100,
    inputSha256: target.inputSha256,
    attachmentManifestSha256: target.attachmentManifestSha256!,
    usage: null,
    costUsd: 0.1,
    analysisMarkdown: "분석",
    programIntent: null,
    criteria: [],
    axisAssessments: CRITERION_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "inspected_no_condition" as const,
      comment: "원문 확인",
      confidence: 1,
    })),
    taxonomyProposals: [],
    dimensionDiffs: [],
    primaryRepairCount,
    primaryRepairProvenance: {
      deterministicPrimaryRepairCount: repair === "deterministic" ? 1 : 0,
      modelPrimaryRepairCount: repair === "model" ? 1 : 0,
      newIssueAfterRepairCount: 0,
    },
    primaryValidationOutcome: "publishable",
    error: null,
  };
}

function fixture(input: {
  repair?: "none" | "deterministic" | "model";
  repairSequences?: ReadonlySet<number>;
  fail?: boolean;
} = {}) {
  const plan = formalPlan();
  const repo = new MemoryRepository();
  const planArtifact = stored(plan, "/plans/deep-v18.json");
  repo.plans.set(plan.planSha256, planArtifact);
  for (const cohort of COHORT_ARTIFACTS) repo.cohorts.set(cohort.path, cohort);
  const evidence = operationalEvidence();
  const evidenceArtifact = stored(evidence, "/evidence/observe-only.json");
  const evidenceSha = storedSha256(evidenceArtifact);
  repo.operationalEvidence.set(evidenceSha, evidenceArtifact);
  const approval = userApproval({
    plan,
    planArtifactSha256: storedSha256(planArtifact),
  });
  const approvalArtifact = stored(approval, "/approvals/canary-00.json");
  const approvalSha = storedSha256(approvalArtifact);
  repo.approvals.set(approvalSha, approvalArtifact);
  const approved = authority({
    plan,
    planArtifactSha256: storedSha256(planArtifact),
    operationalEvidenceSha256: evidenceSha,
    approvalSha256: approvalSha,
  });
  const { artifact: approvedArtifact, sha256: authoritySha } = installIssuedAuthority(
    repo,
    approved,
    "/authorities/canary-00.json",
  );
  let prepared = 0;
  let executed = 0;
  let runtime = 0;
  let operationalChecks = 0;
  let observedExecutionBinding = currentDeepRepairLiveExecutionBinding();
  const deps: DeepRepairLiveDependencies = {
    repository: repo,
    now: () => NOW,
    currentExecutionProvenance: async () => ({
      gitSha: GIT_SHA,
      packageRuntimeSha256: PACKAGE_SHA,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    }),
    verifyOperationalEvidence: async () => { operationalChecks += 1; },
    readRunArtifact: async (path) => repo.runArtifacts.get(path) ?? null,
    runtimeAuthority: {
      async runExclusive(binding, run) {
        runtime += 1;
        return run(binding.signal);
      },
    },
    targetExecutor: {
      async prepare(request) {
        prepared += 1;
        const sequence = plan.sequence.findIndex((target) => target.grantId === request.grantId);
        assert.notEqual(sequence, -1);
        const exactTarget = plan.sequence[sequence]!;
        return {
          binding: {
            grantId: request.grantId,
            inputSha256: exactTarget.inputSha256,
            attachmentManifestSha256: exactTarget.attachmentManifestSha256!,
          },
          async execute() {
            executed += 1;
            observedExecutionBinding = currentDeepRepairLiveExecutionBinding();
            const run = publishableRun({
              plan,
              sequence,
              ...(input.repairSequences?.has(sequence)
                ? { repair: "deterministic" as const }
                : input.repair === undefined
                  ? {}
                  : { repair: input.repair }),
            });
            if (input.fail) {
              delete run.primaryValidationOutcome;
              run.error = "provider failure";
            }
            const bytes = Buffer.from(`${JSON.stringify(run, null, 2)}\n`);
            const artifactPath = `/tmp/exact-run-${sequence}.json`;
            repo.runArtifacts.set(artifactPath, { path: artifactPath, bytes });
            return { artifactPath };
          },
        };
      },
    },
  };
  return {
    plan,
    repo,
    approval,
    approvalSha,
    authority: approved,
    authoritySha,
    experiment: createDeepRepairLiveExperiment(deps),
    deps,
    counts: () => ({ prepared, executed, runtime }),
    operationalChecks: () => operationalChecks,
    observedExecutionBinding: () => observedExecutionBinding,
  };
}

{
  const setup = fixture({ repairSequences: new Set([0]) });
  let authorityId = setup.authoritySha;
  let parentReceiptSha256: string | null = null;

  for (let sequence = 0; sequence < 21; sequence += 1) {
    if (sequence > 0) {
      const approval = userApproval({
        plan: setup.plan,
        planArtifactSha256: setup.authority.planArtifactSha256,
        parentReceiptSha256,
        sequence,
        approvedAt: NOW.toISOString(),
      });
      const approvalArtifact = stored(approval, `/approvals/sprt-${sequence}.json`);
      const approvalSha = storedSha256(approvalArtifact);
      setup.repo.approvals.set(approvalSha, approvalArtifact);
      const nextAuthority = authority({
        plan: setup.plan,
        planArtifactSha256: setup.authority.planArtifactSha256,
        operationalEvidenceSha256: setup.authority.operationalEvidenceSha256,
        approvalSha256: approvalSha,
        parentReceiptSha256,
        sequence,
      });
      authorityId = installIssuedAuthority(
        setup.repo,
        nextAuthority,
        `/authorities/sprt-${sequence}.json`,
      ).sha256;
    }

    const result = await setup.experiment.runApprovedCanary({
      authorityId,
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, "recorded");
    if (result.kind !== "recorded") throw new Error("expected recorded result");
    parentReceiptSha256 = result.receipt.receiptSha256;
    assert.equal(result.receipt.observedCount, sequence + 1);
    assert.equal(
      result.receipt.gateVerdict,
      sequence === 20 ? "GO" : "CONTINUE",
      "1/21 repair의 첫 GO를 부분 wave lifecycle 때문에 INVALID로 바꾸면 안 된다",
    );
    if (sequence === 20) {
      assert.equal(result.receipt.nextAction, "stopped");
      assert.ok(result.receipt.observationsSha256);
      assert.ok(result.receipt.evaluatorReceiptSha256);
      const observationsArtifact = setup.repo.observations.get(
        result.receipt.observationsSha256,
      );
      const evaluatorArtifact = setup.repo.evaluatorReceipts.get(
        result.receipt.evaluatorReceiptSha256,
      );
      assert.ok(observationsArtifact);
      assert.ok(evaluatorArtifact);
      const observations = JSON.parse(Buffer.from(observationsArtifact.bytes).toString("utf8")) as {
        waveLifecycles: Array<{ waveId: string; status: string }>;
      };
      const evaluator = JSON.parse(Buffer.from(evaluatorArtifact.bytes).toString("utf8")) as {
        statisticalVerdict: string | null;
        verdict: string;
        lifecycle: string;
        invalidReasons: string[];
      };
      assert.deepEqual(observations.waveLifecycles, [
        { waveId: "wave-1", status: "finished" },
        { waveId: "wave-2", status: "finished" },
      ]);
      assert.equal(evaluator.statisticalVerdict, "GO");
      assert.equal(evaluator.verdict, "GO");
      assert.equal(evaluator.lifecycle, "finished");
      assert.deepEqual(evaluator.invalidReasons, []);
    }
  }
}

{
  const setup = fixture();
  setup.repo.issuances.delete(setup.approvalSha);
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "issuance_not_found"
      && error.noModelStarted,
    "issuance winner marker가 없는 orphan authority는 실행할 수 없어야 한다",
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const orphan = {
    ...setup.authority,
    runtime: {
      ...setup.authority.runtime,
      ownerId: "223e4567-e89b-42d3-a456-426614174000",
    },
  };
  const orphanArtifact = stored(orphan, "/authorities/race-loser.json");
  const orphanSha = storedSha256(orphanArtifact);
  setup.repo.authorities.set(orphanSha, orphanArtifact);
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: orphanSha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "issuance_invalid"
      && error.noModelStarted,
    "same approval의 CAS loser authority는 marker winner 대신 실행할 수 없어야 한다",
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture({ repair: "deterministic" });
  const result = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "recorded");
  if (result.kind !== "recorded") throw new Error("expected recorded result");
  assert.equal(result.started, "now");
  assert.equal(result.receipt.planSha256, setup.plan.planSha256);
  assert.equal(result.receipt.parentReceiptSha256, null);
  assert.equal(result.receipt.authoritySha256, setup.authoritySha);
  assert.equal(result.receipt.target.sequence, 0);
  assert.equal(result.receipt.noticeOutcome, "publishable");
  assert.equal(result.receipt.observedCount, 1);
  assert.equal(result.receipt.gateVerdict, "CONTINUE");
  assert.equal(result.receipt.promotionEligibility, "not_evaluated");
  assert.match(result.receipt.runArtifactSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
  assert.equal(setup.operationalChecks(), 1);
  assert.deepEqual(setup.observedExecutionBinding(), {
    authoritySha256: setup.authoritySha,
    grantId: setup.plan.sequence[0]!.grantId,
    inputSha256: setup.plan.sequence[0]!.inputSha256,
    attachmentManifestSha256: setup.plan.sequence[0]!.attachmentManifestSha256,
    model: setup.plan.manifest.policy.model,
    transport: "claude-cli",
    promptVersion: setup.plan.manifest.policy.promptVersion,
  });
  assert.equal(currentDeepRepairLiveExecutionBinding(), null);

  const second = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(second.kind, "inspected");
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  if (first.kind !== "recorded") throw new Error("expected first recorded result");
  const nextApproval = userApproval({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const nextApprovalArtifact = stored(nextApproval, "/approvals/canary-01.json");
  const nextApprovalSha = storedSha256(nextApprovalArtifact);
  setup.repo.approvals.set(nextApprovalSha, nextApprovalArtifact);
  const nextAuthority = authority({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    operationalEvidenceSha256: setup.authority.operationalEvidenceSha256,
    approvalSha256: nextApprovalSha,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const { sha256: nextAuthoritySha } = installIssuedAuthority(
    setup.repo,
    nextAuthority,
    "/authorities/canary-01.json",
  );
  const second = await setup.experiment.runApprovedCanary({
    authorityId: nextAuthoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(second.kind, "recorded");
  if (second.kind !== "recorded") throw new Error("expected second recorded result");
  assert.equal(second.receipt.parentReceiptSha256, first.receipt.receiptSha256);
  assert.equal(second.receipt.target.sequence, 1);
  assert.equal(second.receipt.observedCount, 2);
  assert.equal(second.receipt.gateVerdict, "CONTINUE");
  assert.deepEqual(setup.counts(), { prepared: 2, executed: 2, runtime: 2 });
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  if (first.kind !== "recorded") throw new Error("expected first recorded result");
  const parentIssuanceArtifact = setup.repo.issuances.get(setup.approvalSha)!;
  const parentIssuance = JSON.parse(
    Buffer.from(parentIssuanceArtifact.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  setup.repo.issuances.set(setup.approvalSha, stored({
    ...parentIssuance,
    authoritySha256: SHA(9_990),
  }, parentIssuanceArtifact.path));

  const nextApproval = userApproval({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const nextApprovalArtifact = stored(nextApproval, "/approvals/parent-orphan-next.json");
  const nextApprovalSha = storedSha256(nextApprovalArtifact);
  setup.repo.approvals.set(nextApprovalSha, nextApprovalArtifact);
  const nextAuthority = authority({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    operationalEvidenceSha256: setup.authority.operationalEvidenceSha256,
    approvalSha256: nextApprovalSha,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const { sha256: nextAuthoritySha } = installIssuedAuthority(
    setup.repo,
    nextAuthority,
    "/authorities/parent-orphan-next.json",
  );

  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: nextAuthoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "parent_receipt_invalid"
      && error.noModelStarted,
    "모든 parent authority도 approval-key issuance marker winner여야 한다",
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  const exact = setup.repo.authorities.get(setup.authoritySha)!;
  setup.repo.authorities.set(setup.authoritySha, {
    ...exact,
    bytes: Buffer.concat([Buffer.from(exact.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof DeepRepairLiveExecutionError && error.code === "authority_invalid",
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  if (first.kind !== "recorded") throw new Error("expected terminal receipt");
  const { receiptSha256: _oldSha, ...body } = first.receipt;
  const mismatched = {
    ...body,
    failureCode: "tampered terminal copy",
  };
  const terminalCopy = {
    ...mismatched,
    receiptSha256: canonicalSha256(mismatched),
  };
  setup.repo.terminals.set(
    `${setup.plan.planSha256}:0`,
    stored(terminalCopy, "/attempts/tampered-terminal.json"),
  );
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "parent_receipt_invalid"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  if (first.kind !== "recorded") throw new Error("expected parent receipt");
  const parentSlot = `${setup.plan.planSha256}:0`;
  const parentStartArtifact = setup.repo.starts.get(parentSlot)!;
  const retroactiveParentStart = JSON.parse(
    Buffer.from(parentStartArtifact.bytes).toString("utf8"),
  ) as Record<string, unknown>;
  retroactiveParentStart.startedAt = "2026-08-14T02:57:59.999Z";
  setup.repo.starts.set(parentSlot, stored(retroactiveParentStart, parentStartArtifact.path));
  const nextApproval = userApproval({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const nextApprovalArtifact = stored(nextApproval, "/approvals/retroactive-parent-next.json");
  const nextApprovalSha = storedSha256(nextApprovalArtifact);
  setup.repo.approvals.set(nextApprovalSha, nextApprovalArtifact);
  const nextAuthority = authority({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    operationalEvidenceSha256: setup.authority.operationalEvidenceSha256,
    approvalSha256: nextApprovalSha,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const { sha256: nextAuthoritySha } = installIssuedAuthority(
    setup.repo,
    nextAuthority,
    "/authorities/retroactive-parent-next.json",
  );
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: nextAuthoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "parent_receipt_invalid"
      && error.message.includes("parent start 시점")
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  await setup.repo.claimStart({
    planSha256: setup.plan.planSha256,
    sequence: 0,
  }, {
    schema: "deep-repair-live-start-v1",
    planSha256: setup.plan.planSha256,
    parentReceiptSha256: null,
    authoritySha256: setup.authoritySha,
    attemptId: setup.authority.attemptId,
    target: { sequence: 0, waveId: "wave-1", grantId: "grant-00" },
    startedAt: "2026-08-14T02:57:59.999Z",
  });
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_expired"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const exact = setup.repo.plans.get(setup.plan.planSha256)!;
  setup.repo.plans.set(setup.plan.planSha256, {
    ...exact,
    bytes: Buffer.concat([Buffer.from(exact.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof DeepRepairLiveExecutionError && error.code === "plan_not_canonical",
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const cohortPath = setup.plan.manifest.waves[0]!.cohort.artifactPath;
  const exact = setup.repo.cohorts.get(cohortPath)!;
  setup.repo.cohorts.set(cohortPath, {
    ...exact,
    bytes: Buffer.concat([Buffer.from(exact.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError && error.code === "authority_binding_mismatch",
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const leaseAbort = new AbortController();
  leaseAbort.abort(new Error("lease lost"));
  const experiment = createDeepRepairLiveExperiment({
    ...setup.deps,
    runtimeAuthority: {
      async runExclusive(_binding, run) { return run(leaseAbort.signal); },
    },
  });
  await assert.rejects(
    experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "aborted_before_start"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 0, runtime: 0 });
  assert.equal(setup.repo.starts.size, 0);
}

{
  const setup = fixture();
  const claimed = await setup.repo.claimStart({
    planSha256: setup.plan.planSha256,
    sequence: 0,
  }, {
    schema: "deep-repair-live-start-v1",
    planSha256: setup.plan.planSha256,
    parentReceiptSha256: null,
    authoritySha256: setup.authoritySha,
    attemptId: setup.authority.attemptId,
    target: { sequence: 0, waveId: "wave-1", grantId: "grant-00" },
    startedAt: "2026-08-14T03:00:00.000Z",
  });
  assert.equal(claimed, true);
  const result = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "ambiguous");
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const drifted = { ...setup.authority, grantId: "grant-not-in-plan" };
  const { sha256: driftedSha } = installIssuedAuthority(
    setup.repo,
    drifted,
    "/authorities/drifted.json",
  );
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: driftedSha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_binding_mismatch"
      && error.noModelStarted,
    "승인과 다른 authority target은 plan 조회보다 먼저 거부해야 한다",
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const staleEvidence = { ...operationalEvidence(), validUntil: "2026-08-14T02:59:00.000Z" };
  const staleEvidenceArtifact = stored(staleEvidence, "/evidence/stale.json");
  const staleEvidenceSha = storedSha256(staleEvidenceArtifact);
  setup.repo.operationalEvidence.set(staleEvidenceSha, staleEvidenceArtifact);
  const staleAuthority = authority({
    plan: setup.plan,
    planArtifactSha256: (setup.authority as { planArtifactSha256: string }).planArtifactSha256,
    operationalEvidenceSha256: staleEvidenceSha,
    approvalSha256: setup.approvalSha,
  });
  const { sha256: staleAuthoritySha } = installIssuedAuthority(
    setup.repo,
    staleAuthority,
    "/authorities/stale.json",
  );
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: staleAuthoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "production_guard_stale",
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const driftedDeps: DeepRepairLiveDependencies = {
    repository: setup.repo,
    now: () => NOW,
    currentExecutionProvenance: async () => ({
      gitSha: GIT_SHA,
      packageRuntimeSha256: SHA(9999),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    }),
    verifyOperationalEvidence: async () => {},
    readRunArtifact: async (path) => setup.repo.runArtifacts.get(path) ?? null,
    runtimeAuthority: {
      async runExclusive(binding, run) { return run(binding.signal); },
    },
    targetExecutor: {
      async prepare() { throw new Error("must not prepare"); },
    },
  };
  await assert.rejects(
    createDeepRepairLiveExperiment(driftedDeps).runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "execution_provenance_drift",
  );
}

{
  const setup = fixture();
  const rejectedByCurrentWorker = createDeepRepairLiveExperiment({
    ...setup.deps,
    verifyOperationalEvidence: async () => { throw new Error("worker drift"); },
  });
  await assert.rejects(
    rejectedByCurrentWorker.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "production_guard_invalid"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 0, runtime: 1 });
  assert.equal(setup.repo.starts.size, 0);
}

{
  const setup = fixture();
  const target = setup.plan.sequence[0]!;
  const mismatchDeps: DeepRepairLiveDependencies = {
    repository: setup.repo,
    now: () => NOW,
    currentExecutionProvenance: async () => ({
      gitSha: GIT_SHA,
      packageRuntimeSha256: PACKAGE_SHA,
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    }),
    verifyOperationalEvidence: async () => {},
    readRunArtifact: async (path) => setup.repo.runArtifacts.get(path) ?? null,
    runtimeAuthority: {
      async runExclusive() { throw new Error("must not acquire runtime"); },
    },
    targetExecutor: {
      async prepare() {
        return {
          binding: {
            grantId: target.grantId,
            inputSha256: SHA(7777),
            attachmentManifestSha256: target.attachmentManifestSha256!,
          },
          async execute() { throw new Error("must not execute"); },
        };
      },
    },
  };
  await assert.rejects(
    createDeepRepairLiveExperiment(mismatchDeps).runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "target_input_drift",
  );
  assert.equal(setup.repo.starts.size, 0);
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  if (first.kind !== "recorded") throw new Error("expected recorded result");
  const forkedAuthority = { ...setup.authority, attemptId: "deep-v18-fork" };
  const forkedArtifact = stored(forkedAuthority, "/authorities/forked.json");
  const forkedSha = storedSha256(forkedArtifact);
  setup.repo.authorities.set(forkedSha, forkedArtifact);
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: forkedSha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "issuance_invalid"
      && error.noModelStarted,
    "commit marker winner가 아닌 forked authority는 terminal inspect에도 진입할 수 없어야 한다",
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  if (first.kind !== "recorded" || !first.receipt.observationsSha256) {
    throw new Error("expected observations receipt");
  }
  const exact = setup.repo.observations.get(first.receipt.observationsSha256)!;
  const parsed = JSON.parse(Buffer.from(exact.bytes).toString("utf8")) as {
    notices: Array<Record<string, unknown>>;
  };
  parsed.notices[0]!.grantId = "tampered-grant";
  setup.repo.observations.set(first.receipt.observationsSha256, stored(parsed, exact.path));
  const nextApproval = userApproval({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const nextApprovalArtifact = stored(nextApproval, "/approvals/tampered-parent.json");
  const nextApprovalSha = storedSha256(nextApprovalArtifact);
  setup.repo.approvals.set(nextApprovalSha, nextApprovalArtifact);
  const nextAuthority = authority({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    operationalEvidenceSha256: setup.authority.operationalEvidenceSha256,
    approvalSha256: nextApprovalSha,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const { sha256: nextSha } = installIssuedAuthority(
    setup.repo,
    nextAuthority,
    "/authorities/tampered-parent.json",
  );
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: nextSha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "parent_receipt_invalid"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  let nowCalls = 0;
  const expiredDuringLease = createDeepRepairLiveExperiment({
    ...setup.deps,
    now: () => {
      nowCalls += 1;
      return nowCalls <= 2 ? NOW : new Date("2026-08-14T03:11:00.000Z");
    },
  });
  await assert.rejects(
    expiredDuringLease.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_expired"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 0, runtime: 1 });
  assert.equal(setup.repo.starts.size, 0);
}

{
  const setup = fixture();
  let clock = NOW;
  const expiredDuringSlowPreflight = createDeepRepairLiveExperiment({
    ...setup.deps,
    now: () => clock,
    verifyOperationalEvidence: async () => {
      clock = new Date("2026-08-14T03:11:00.000Z");
    },
  });
  await assert.rejects(
    expiredDuringSlowPreflight.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_expired"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 0, runtime: 1 });
  assert.equal(setup.repo.starts.size, 0);
}

{
  const setup = fixture();
  const controller = new AbortController();
  let provenanceReads = 0;
  const abortedDuringSlowPreflight = createDeepRepairLiveExperiment({
    ...setup.deps,
    currentExecutionProvenance: async () => {
      provenanceReads += 1;
      if (provenanceReads === 2) controller.abort(new Error("lease cancelled"));
      return {
        gitSha: GIT_SHA,
        packageRuntimeSha256: PACKAGE_SHA,
        validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      };
    },
  });
  await assert.rejects(
    abortedDuringSlowPreflight.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "aborted_before_start"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 0, runtime: 1 });
  assert.equal(setup.repo.starts.size, 0);
}

{
  const setup = fixture();
  const releaseFailedAfterTerminal = createDeepRepairLiveExperiment({
    ...setup.deps,
    runtimeAuthority: {
      async runExclusive(binding, run) {
        await run(binding.signal);
        throw new Error("lease release failed");
      },
    },
  });
  await assert.rejects(
    releaseFailedAfterTerminal.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "runtime_authority_failed"
      && !error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 0 });
  assert.equal(setup.repo.starts.size, 1);
  assert.equal(setup.repo.terminals.size, 1);
  const inspected = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(inspected.kind, "inspected");
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 0 });
}

{
  const setup = fixture();
  const claimStart = setup.repo.claimStart.bind(setup.repo);
  setup.repo.claimStart = async (key, start) => {
    await claimStart(key, start);
    throw new Error("start read-back failed");
  };
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "start_commit_ambiguous"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 0, runtime: 1 });
  assert.equal(setup.repo.starts.size, 1);
  const inspected = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(inspected.kind, "ambiguous");
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 0, runtime: 1 });
}

{
  const setup = fixture();
  const missingDurableArtifact = createDeepRepairLiveExperiment({
    ...setup.deps,
    readRunArtifact: async () => null,
  });
  await assert.rejects(
    missingDurableArtifact.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "run_artifact_invalid"
      && !error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
  assert.equal(setup.repo.terminals.size, 0);
}

{
  const setup = fixture();
  const leaseAbort = new AbortController();
  const baseExecutor = setup.deps.targetExecutor;
  const abortAfterModel = createDeepRepairLiveExperiment({
    ...setup.deps,
    runtimeAuthority: {
      async runExclusive(_binding, run) { return run(leaseAbort.signal); },
    },
    targetExecutor: {
      async prepare(input) {
        const prepared = await baseExecutor.prepare(input);
        return {
          ...prepared,
          async execute(executeInput) {
            const result = await prepared.execute(executeInput);
            leaseAbort.abort(new Error("lease lost after model"));
            return result;
          },
        };
      },
    },
  });
  await assert.rejects(
    abortAfterModel.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "aborted_after_start"
      && !error.noModelStarted,
  );
  assert.equal(setup.repo.terminals.size, 0);
}

{
  const setup = fixture({ fail: true });
  const failed = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(failed.kind, "recorded");
  if (failed.kind !== "recorded") throw new Error("expected failed receipt");
  assert.equal(failed.receipt.noticeOutcome, "failed");
  assert.equal(failed.receipt.gateVerdict, "INVALID");
  assert.equal(failed.receipt.nextAction, "stopped");
  const inspected = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(inspected.kind, "inspected");
  const retryApproval = userApproval({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    parentReceiptSha256: failed.receipt.receiptSha256,
    sequence: 0,
  });
  const retryApprovalArtifact = stored(retryApproval, "/approvals/retry-failed-slot.json");
  const retryApprovalSha = storedSha256(retryApprovalArtifact);
  setup.repo.approvals.set(retryApprovalSha, retryApprovalArtifact);
  const retryAuthority = authority({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    operationalEvidenceSha256: setup.authority.operationalEvidenceSha256,
    approvalSha256: retryApprovalSha,
    parentReceiptSha256: failed.receipt.receiptSha256,
    sequence: 0,
  });
  const { sha256: retrySha } = installIssuedAuthority(
    setup.repo,
    retryAuthority,
    "/authorities/retry-failed-slot.json",
  );
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: retrySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "gate_not_continuable"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  const approvalBoundAuthority = {
    ...setup.authority,
    approvalSha256: SHA(9_500),
  };
  const artifact = stored(approvalBoundAuthority, "/authorities/missing-approval.json");
  const authoritySha = storedSha256(artifact);
  setup.repo.authorities.set(authoritySha, artifact);

  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_not_found"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const exact = setup.repo.approvals.get(setup.approvalSha)!;
  setup.repo.approvals.set(setup.approvalSha, {
    ...exact,
    bytes: Buffer.concat([Buffer.from(exact.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_invalid"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const nonCanonicalApproval = { ...setup.approval, unboundNote: "self-attested" };
  const approvalArtifact = stored(nonCanonicalApproval, "/approvals/non-canonical.json");
  const approvalSha = storedSha256(approvalArtifact);
  setup.repo.approvals.set(approvalSha, approvalArtifact);
  const value = { ...setup.authority, approvalSha256: approvalSha };
  const artifact = stored(value, "/authorities/non-canonical-approval.json");
  const authoritySha = storedSha256(artifact);
  setup.repo.authorities.set(authoritySha, artifact);
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_invalid"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const tooLongApproval = {
    ...setup.approval,
    expiresAt: "2026-08-14T03:13:00.001Z",
  };
  const approvalArtifact = stored(tooLongApproval, "/approvals/ttl-too-long.json");
  const approvalSha = storedSha256(approvalArtifact);
  setup.repo.approvals.set(approvalSha, approvalArtifact);
  const value = { ...setup.authority, approvalSha256: approvalSha };
  const artifact = stored(value, "/authorities/ttl-too-long.json");
  const authoritySha = storedSha256(artifact);
  setup.repo.authorities.set(authoritySha, artifact);
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_invalid"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

{
  const setup = fixture();
  const staleApproval = {
    ...setup.approval,
    approvedAt: "2026-08-14T02:40:00.000Z",
    expiresAt: "2026-08-14T02:55:00.000Z",
  };
  const approvalArtifact = stored(staleApproval, "/approvals/stale.json");
  const approvalSha = storedSha256(approvalArtifact);
  setup.repo.approvals.set(approvalSha, approvalArtifact);
  const value = { ...setup.authority, approvalSha256: approvalSha };
  const { sha256: authoritySha } = installIssuedAuthority(
    setup.repo,
    value,
    "/authorities/stale-approval.json",
  );
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_expired"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 });
}

for (const [label, drift] of [
  ["plan", { planSha256: SHA(9_601) }],
  ["plan-artifact", { planArtifactSha256: SHA(9_602) }],
  ["parent", { parentReceiptSha256: SHA(9_603) }],
  ["sequence", { sequence: 1 }],
  ["wave", { waveId: "wave-not-approved" }],
  ["grant", { grantId: "grant-not-approved" }],
  ["model", { model: "claude-not-approved" }],
  ["prompt", { promptVersion: "prompt-not-approved" }],
] as const) {
  const setup = fixture();
  const mismatchedApproval = { ...setup.approval, ...drift };
  const approvalArtifact = stored(mismatchedApproval, `/approvals/mismatched-${label}.json`);
  const approvalSha = storedSha256(approvalArtifact);
  setup.repo.approvals.set(approvalSha, approvalArtifact);
  const value = { ...setup.authority, approvalSha256: approvalSha };
  const artifact = stored(value, `/authorities/mismatched-approval-${label}.json`);
  const authoritySha = storedSha256(artifact);
  setup.repo.authorities.set(authoritySha, artifact);
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_binding_mismatch"
      && error.noModelStarted,
    label,
  );
  assert.deepEqual(setup.counts(), { prepared: 0, executed: 0, runtime: 0 }, label);
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  if (first.kind !== "recorded") throw new Error("expected parent receipt");
  setup.repo.approvals.delete(setup.approvalSha);
  const nextApproval = userApproval({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const nextApprovalArtifact = stored(nextApproval, "/approvals/missing-parent-approval-next.json");
  const nextApprovalSha = storedSha256(nextApprovalArtifact);
  setup.repo.approvals.set(nextApprovalSha, nextApprovalArtifact);
  const nextAuthority = authority({
    plan: setup.plan,
    planArtifactSha256: setup.authority.planArtifactSha256,
    operationalEvidenceSha256: setup.authority.operationalEvidenceSha256,
    approvalSha256: nextApprovalSha,
    parentReceiptSha256: first.receipt.receiptSha256,
    sequence: 1,
  });
  const { sha256: nextAuthoritySha } = installIssuedAuthority(
    setup.repo,
    nextAuthority,
    "/authorities/missing-parent-approval-next.json",
  );
  await assert.rejects(
    setup.experiment.runApprovedCanary({
      authorityId: nextAuthoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "parent_receipt_invalid"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  const expiredInspector = createDeepRepairLiveExperiment({
    ...setup.deps,
    now: () => new Date("2026-08-14T03:11:00.000Z"),
  });
  const inspected = await expiredInspector.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(inspected.kind, "inspected");
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  const first = await setup.experiment.runApprovedCanary({
    authorityId: setup.authoritySha,
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, "recorded");
  const approvalArtifact = setup.repo.approvals.get(setup.approvalSha)!;
  setup.repo.approvals.set(setup.approvalSha, {
    ...approvalArtifact,
    bytes: Buffer.concat([Buffer.from(approvalArtifact.bytes), Buffer.from(" ")]),
  });
  await assert.rejects(
    createDeepRepairLiveExperiment({
      ...setup.deps,
      now: () => new Date("2026-08-14T03:11:00.000Z"),
    }).runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_invalid"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 1, runtime: 1 });
}

{
  const setup = fixture();
  const disappearsBeforeClaim = createDeepRepairLiveExperiment({
    ...setup.deps,
    verifyOperationalEvidence: async () => {
      setup.repo.approvals.delete(setup.approvalSha);
    },
  });
  await assert.rejects(
    disappearsBeforeClaim.runApprovedCanary({
      authorityId: setup.authoritySha,
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof DeepRepairLiveExecutionError
      && error.code === "approval_not_found"
      && error.noModelStarted,
  );
  assert.deepEqual(setup.counts(), { prepared: 1, executed: 0, runtime: 1 });
  assert.equal(setup.repo.starts.size, 0);
}

console.log("deep-repair-live-experiment tests passed");
