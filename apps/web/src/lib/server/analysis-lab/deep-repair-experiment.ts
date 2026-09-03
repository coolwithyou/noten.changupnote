import { createHash } from "node:crypto";
import {
  DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE as MAX_SAMPLE_SIZE,
  DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE as MIN_SAMPLE_SIZE,
  DEEP_REPAIR_FORMAL_SUPPORTED_STRATA as SUPPORTED_STRATA,
  deepRepairTargetCountForSeries,
  deepRepairRequiredStrataForVersion,
  type DeepRepairStrataVersion,
} from "./deep-repair-formal-policy";

type ExperimentMode = "formal" | "legacy_shadow";
type Formation = "prospective" | "retrospective_concat";
type ProvenanceStatus = "complete" | "legacy_partial";
type LifecycleStatus = "finished" | "unknown";
type GateVerdict = "CONTINUE" | "GO" | "NO_GO" | "INCONCLUSIVE";
type ReceiptVerdict = GateVerdict | "INVALID";
type GatePolicyVersion = "repair-sprt-v1" | "repair-sprt-v2";

interface ExperimentRunBinding {
  readonly runId: string;
  readonly runArtifactPath: string;
  readonly runArtifactSha256: string;
}

interface ExperimentTarget {
  readonly grantId: string;
  readonly stratum: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string | null;
  /** retrospective legacy manifest에만 존재한다. prospective plan은 미래 run을 창작하지 않는다. */
  readonly runBinding: ExperimentRunBinding | null;
}

interface ExperimentWave {
  readonly waveId: string;
  readonly cohort: {
    readonly artifactPath: string;
    readonly sha256: string;
    readonly selectedAt: string;
    readonly seed: number;
  };
  readonly targets: readonly ExperimentTarget[];
}

interface ExperimentManifest {
  readonly schema: "deep-repair-series-manifest-v1";
  readonly seriesId: string;
  readonly objective: "deep-primary-repair-rate";
  readonly mode: ExperimentMode;
  readonly formation: Formation;
  readonly strataVersion: DeepRepairStrataVersion | null;
  readonly provenance: {
    readonly status: ProvenanceStatus;
    readonly unavailable: readonly string[];
    readonly gitSha: string | null;
    readonly packageRuntimeSha256: string | null;
    readonly validatorVersion: string | null;
  };
  readonly policy: {
    readonly promptVersion: string;
    readonly model: string;
    readonly transport: "claude-cli";
    readonly qualityPolicyVersion: string;
    readonly gatePolicyVersion: GatePolicyVersion;
  };
  readonly waves: readonly ExperimentWave[];
}

interface PlannedTarget extends ExperimentTarget {
  readonly sequence: number;
  readonly waveId: string;
}

export interface DeepRepairExperimentPlan {
  readonly schema: "deep-repair-experiment-plan-v1";
  readonly manifest: ExperimentManifest;
  readonly sequence: readonly PlannedTarget[];
  readonly manifestSha256: string;
  readonly planSha256: string;
}

interface GateCheckpoint {
  readonly sampleSize: number;
  readonly repairedNoticeCount: number;
  readonly logLikelihoodRatio: number;
  readonly statisticalVerdict: GateVerdict;
}

export interface DeepRepairExperimentReceipt {
  readonly schema: "deep-repair-experiment-receipt-v1";
  readonly receiptSha256: string;
  readonly planSha256: string;
  readonly manifestSha256: string;
  readonly seriesId: string;
  readonly objective: "deep-primary-repair-rate";
  readonly mode: ExperimentMode;
  readonly provenanceStatus: ProvenanceStatus;
  readonly lifecycle: LifecycleStatus;
  readonly observationSha256: string;
  readonly observedCount: number;
  readonly repairedNoticeCount: number;
  readonly repairAttemptCount: number;
  readonly repairBreakdown: {
    readonly deterministicPrimary: number;
    readonly modelPrimary: number;
    readonly review: number;
    readonly newIssuesAfterRepair: number;
    readonly blockingNewIssuesAfterRepair?: number;
    readonly sourceIncompleteIssuesAfterRepair?: number;
  } | null;
  readonly executionProvenance: {
    readonly gitSha: string;
    readonly packageRuntimeSha256: string;
    readonly validatorVersion: string;
  } | null;
  readonly outcomes: {
    readonly publishable: number;
    readonly held: number;
  };
  readonly checkpoints: readonly GateCheckpoint[];
  readonly statisticalVerdict: GateVerdict | null;
  readonly verdict: ReceiptVerdict;
  readonly invalidReasons: readonly string[];
}

interface NormalizedObservation {
  readonly waveId: string;
  readonly grantId: string;
  readonly runId: string;
  readonly runArtifactPath: string | null;
  readonly runArtifactSha256: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string | null;
  readonly promptVersion: string;
  readonly model: string;
  readonly transport: string;
  readonly noticeOutcome: "publishable" | "held";
  readonly primaryRepairCount: number;
  readonly deterministicPrimaryRepairCount: number | null;
  readonly modelPrimaryRepairCount: number | null;
  readonly reviewRepairCount: number | null;
  readonly newIssueAfterRepairCount: number | null;
  readonly blockingNewIssueAfterRepairCount: number | null;
  readonly sourceIncompleteIssueAfterRepairCount: number | null;
  readonly qualityProjection: {
    readonly policyVersion: string;
    readonly grantId: string;
    readonly runId: string;
    readonly inputSealed: string;
    readonly deepContract: string;
  };
}

interface ExecutionProvenance {
  readonly gitSha: string;
  readonly packageRuntimeSha256: string;
  readonly validatorVersion: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FULL_GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GOOD_REPAIR_RATE = 0.1;
const BAD_REPAIR_RATE = 0.2;
const ALPHA = 0.05;
const BETA = 0.2;
const GO_BOUNDARY = Math.log(BETA / (1 - ALPHA));
const NO_GO_BOUNDARY = Math.log((1 - BETA) / ALPHA);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function readLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  label: string,
): T {
  const value = readString(record, key, label);
  if (!allowed.includes(value as T)) {
    throw new Error(`${label}.${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function readSha256(record: Record<string, unknown>, key: string, label: string): string {
  const value = readString(record, key, label);
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label}.${key} must be an exact lowercase SHA-256`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, label: string): string | null {
  if (record[key] === undefined || record[key] === null) return null;
  return readString(record, key, label);
}

function readOptionalSha256(record: Record<string, unknown>, key: string, label: string): string | null {
  if (record[key] === undefined || record[key] === null) return null;
  return readSha256(record, key, label);
}

function readOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label}.${key} must be a non-negative safe integer`);
  }
  return value as number;
}

function readArray(record: Record<string, unknown>, key: string, label: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${label}.${key} must be an array`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function normalizeManifest(input: unknown): ExperimentManifest {
  const source = asRecord(input, "manifest");
  const schema = readLiteral(source, "schema", ["deep-repair-series-manifest-v1"] as const, "manifest");
  const seriesId = readString(source, "seriesId", "manifest");
  const objective = readLiteral(source, "objective", ["deep-primary-repair-rate"] as const, "manifest");
  const mode = readLiteral(source, "mode", ["formal", "legacy_shadow"] as const, "manifest");
  const formation = readLiteral(
    source,
    "formation",
    ["prospective", "retrospective_concat"] as const,
    "manifest",
  );
  const strataVersion =
    source.strataVersion === undefined || source.strataVersion === null
      ? null
      : readLiteral(
          source,
          "strataVersion",
          [
            "deep-repair-strata-v1",
            "deep-repair-strata-v2",
            "deep-repair-strata-v3",
            "deep-repair-strata-v4",
          ] as const,
          "manifest",
        );

  const provenanceSource = asRecord(source.provenance, "manifest.provenance");
  const provenanceStatus = readLiteral(
    provenanceSource,
    "status",
    ["complete", "legacy_partial"] as const,
    "manifest.provenance",
  );
  const unavailable = readArray(provenanceSource, "unavailable", "manifest.provenance").map(
    (value, index) => {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`manifest.provenance.unavailable[${index}] must be a non-empty string`);
      }
      return value;
    },
  );
  const gitSha = readOptionalString(provenanceSource, "gitSha", "manifest.provenance");
  const packageRuntimeSha256 = readOptionalSha256(
    provenanceSource,
    "packageRuntimeSha256",
    "manifest.provenance",
  );
  const validatorVersion = readOptionalString(provenanceSource, "validatorVersion", "manifest.provenance");
  if (gitSha !== null && !FULL_GIT_SHA_PATTERN.test(gitSha)) {
    throw new Error("manifest.provenance.gitSha must be a full 40- or 64-character git SHA");
  }

  if (mode === "formal" && (formation !== "prospective" || provenanceStatus !== "complete" || unavailable.length > 0)) {
    throw new Error("formal experiments require prospective formation and complete provenance");
  }
  if (
    mode === "legacy_shadow" &&
    (formation !== "retrospective_concat" || provenanceStatus !== "legacy_partial" || unavailable.length === 0)
  ) {
    throw new Error("legacy shadow experiments require retrospective formation and explicit missing provenance");
  }
  if (
    mode === "formal" &&
    (strataVersion === null ||
      gitSha === null ||
      packageRuntimeSha256 === null ||
      validatorVersion === null)
  ) {
    throw new Error(
      "formal experiments require exact provenance: strataVersion, gitSha, packageRuntimeSha256, validatorVersion",
    );
  }

  const policySource = asRecord(source.policy, "manifest.policy");
  const policy = {
    promptVersion: readString(policySource, "promptVersion", "manifest.policy"),
    model: readString(policySource, "model", "manifest.policy"),
    transport: readLiteral(policySource, "transport", ["claude-cli"] as const, "manifest.policy"),
    qualityPolicyVersion: readString(policySource, "qualityPolicyVersion", "manifest.policy"),
    gatePolicyVersion: readLiteral(
      policySource,
      "gatePolicyVersion",
      ["repair-sprt-v1", "repair-sprt-v2"] as const,
      "manifest.policy",
    ),
  };

  const seenWaveIds = new Set<string>();
  const seenGrantIds = new Set<string>();
  const seenRunIds = new Set<string>();
  let targetCount = 0;
  const waves = readArray(source, "waves", "manifest").map((waveValue, waveIndex): ExperimentWave => {
    const label = `manifest.waves[${waveIndex}]`;
    const waveSource = asRecord(waveValue, label);
    const waveId = readString(waveSource, "waveId", label);
    if (seenWaveIds.has(waveId)) {
      throw new Error(`${label}.waveId must be unique`);
    }
    seenWaveIds.add(waveId);

    const cohortSource = asRecord(waveSource.cohort, `${label}.cohort`);
    const seed = cohortSource.seed;
    if (!Number.isSafeInteger(seed)) {
      throw new Error(`${label}.cohort.seed must be a safe integer`);
    }
    const cohort = {
      artifactPath: readString(cohortSource, "artifactPath", `${label}.cohort`),
      sha256: readSha256(cohortSource, "sha256", `${label}.cohort`),
      selectedAt: readString(cohortSource, "selectedAt", `${label}.cohort`),
      seed: seed as number,
    };

    const targets = readArray(waveSource, "targets", label).map(
      (targetValue, targetIndex): ExperimentTarget => {
        const targetLabel = `${label}.targets[${targetIndex}]`;
        const targetSource = asRecord(targetValue, targetLabel);
        const grantId = readString(targetSource, "grantId", targetLabel);
        if (seenGrantIds.has(grantId)) {
          throw new Error(`${targetLabel}.grantId must be globally unique`);
        }
        seenGrantIds.add(grantId);
        targetCount += 1;
        const runBindingKeys = ["runId", "runArtifactPath", "runArtifactSha256"] as const;
        const hasRunBindingField = runBindingKeys.some((key) => Object.hasOwn(targetSource, key));
        const canonicalRunBindingSource = targetSource.runBinding;
        if (
          mode === "formal" &&
          (hasRunBindingField || (canonicalRunBindingSource !== undefined && canonicalRunBindingSource !== null))
        ) {
          throw new Error(`${targetLabel} prospective plans must not include future run bindings`);
        }
        let runBinding: ExperimentRunBinding | null = null;
        if (mode === "legacy_shadow") {
          if (hasRunBindingField && canonicalRunBindingSource !== undefined) {
            throw new Error(`${targetLabel} must use exactly one legacy run binding shape`);
          }
          const bindingSource = canonicalRunBindingSource === undefined
            ? targetSource
            : asRecord(canonicalRunBindingSource, `${targetLabel}.runBinding`);
          const bindingLabel = canonicalRunBindingSource === undefined
            ? targetLabel
            : `${targetLabel}.runBinding`;
          const runId = readString(bindingSource, "runId", bindingLabel);
          if (seenRunIds.has(runId)) {
            throw new Error(`${targetLabel}.runId must be globally unique`);
          }
          seenRunIds.add(runId);
          runBinding = {
            runId,
            runArtifactPath: readString(bindingSource, "runArtifactPath", bindingLabel),
            runArtifactSha256: readSha256(bindingSource, "runArtifactSha256", bindingLabel),
          };
        }
        const attachmentManifestSha256 = readOptionalSha256(
          targetSource,
          "attachmentManifestSha256",
          targetLabel,
        );
        if (mode === "formal" && attachmentManifestSha256 === null) {
          throw new Error(`${targetLabel} formal experiments require exact attachmentManifestSha256 provenance`);
        }
        return {
          grantId,
          stratum: readString(targetSource, "stratum", targetLabel),
          inputSha256: readSha256(targetSource, "inputSha256", targetLabel),
          attachmentManifestSha256,
          runBinding,
        };
      },
    );
    if (targets.length === 0) {
      throw new Error(`${label}.targets must not be empty`);
    }
    return { waveId, cohort, targets };
  });

  if (waves.length === 0 || targetCount > MAX_SAMPLE_SIZE) {
    throw new Error(`manifest must contain between 1 and ${MAX_SAMPLE_SIZE} targets`);
  }
  if (mode === "formal") {
    const expectedTargetCount = deepRepairTargetCountForSeries(seriesId);
    if (targetCount !== expectedTargetCount) {
      throw new Error(`formal experiment plan must pre-seal exactly ${expectedTargetCount} targets`);
    }
    const formalTargets = waves.flatMap((wave) => wave.targets);
    const requiredStrata = deepRepairRequiredStrataForVersion(strataVersion!);
    const unsupportedStrata = [
      ...new Set(
        formalTargets
          .map((target) => target.stratum)
          .filter((stratum) => !SUPPORTED_STRATA.some((supported) => supported === stratum)),
      ),
    ];
    if (unsupportedStrata.length > 0) {
      throw new Error(`formal experiment plan contains unsupported strata: ${unsupportedStrata.join(", ")}`);
    }
    const minimumPrefixStrata = new Set(
      formalTargets.slice(0, MIN_SAMPLE_SIZE).map((target) => target.stratum),
    );
    const missingPrefixStrata = requiredStrata.filter(
      (stratum) => !minimumPrefixStrata.has(stratum),
    );
    if (missingPrefixStrata.length > 0) {
      throw new Error(
        `formal experiment plan first ${MIN_SAMPLE_SIZE} targets are missing required strata: ${missingPrefixStrata.join(", ")}`,
      );
    }
  }

  return {
    schema,
    seriesId,
    objective,
    mode,
    formation,
    strataVersion,
    provenance: {
      status: provenanceStatus,
      unavailable,
      gitSha,
      packageRuntimeSha256,
      validatorVersion,
    },
    policy,
    waves,
  };
}

function planBody(plan: DeepRepairExperimentPlan): Omit<DeepRepairExperimentPlan, "planSha256"> {
  return {
    schema: plan.schema,
    manifest: plan.manifest,
    sequence: plan.sequence,
    manifestSha256: plan.manifestSha256,
  };
}

function evaluateGate(
  sampleSize: number,
  repairedNoticeCount: number,
  plannedSampleSize: number,
): GateCheckpoint {
  const logLikelihoodRatio =
    repairedNoticeCount * Math.log(BAD_REPAIR_RATE / GOOD_REPAIR_RATE) +
    (sampleSize - repairedNoticeCount) * Math.log((1 - BAD_REPAIR_RATE) / (1 - GOOD_REPAIR_RATE));
  let statisticalVerdict: GateVerdict = "CONTINUE";
  if (sampleSize >= MIN_SAMPLE_SIZE) {
    if (logLikelihoodRatio <= GO_BOUNDARY) {
      statisticalVerdict = "GO";
    } else if (logLikelihoodRatio >= NO_GO_BOUNDARY) {
      statisticalVerdict = "NO_GO";
    } else if (sampleSize >= plannedSampleSize) {
      statisticalVerdict = "INCONCLUSIVE";
    }
  }
  return { sampleSize, repairedNoticeCount, logLikelihoodRatio, statisticalVerdict };
}

function normalizeExecutionProvenance(value: unknown): ExecutionProvenance {
  const source = asRecord(value, "observations.executionProvenance");
  const gitSha = readString(source, "gitSha", "observations.executionProvenance");
  if (!FULL_GIT_SHA_PATTERN.test(gitSha)) {
    throw new Error("observations.executionProvenance.gitSha must be a full git SHA");
  }
  return {
    gitSha,
    packageRuntimeSha256: readSha256(
      source,
      "packageRuntimeSha256",
      "observations.executionProvenance",
    ),
    validatorVersion: readString(
      source,
      "validatorVersion",
      "observations.executionProvenance",
    ),
  };
}

function normalizeObservation(value: unknown, index: number): NormalizedObservation {
  const label = `observations.notices[${index}]`;
  const source = asRecord(value, label);
  const projectionSource = asRecord(source.qualityProjection, `${label}.qualityProjection`);
  const primaryRepairCount = source.primaryRepairCount;
  if (!Number.isSafeInteger(primaryRepairCount) || (primaryRepairCount as number) < 0) {
    throw new Error(`${label}.primaryRepairCount must be a non-negative safe integer`);
  }
  return {
    waveId: readString(source, "waveId", label),
    grantId: readString(source, "grantId", label),
    runId: readString(source, "runId", label),
    runArtifactPath: readOptionalString(source, "runArtifactPath", label),
    runArtifactSha256: readSha256(source, "runArtifactSha256", label),
    inputSha256: readSha256(source, "inputSha256", label),
    attachmentManifestSha256: readOptionalSha256(source, "attachmentManifestSha256", label),
    promptVersion: readString(source, "promptVersion", label),
    model: readString(source, "model", label),
    transport: readString(source, "transport", label),
    noticeOutcome: readLiteral(source, "noticeOutcome", ["publishable", "held"] as const, label),
    primaryRepairCount: primaryRepairCount as number,
    deterministicPrimaryRepairCount: readOptionalNonNegativeInteger(
      source,
      "deterministicPrimaryRepairCount",
      label,
    ),
    modelPrimaryRepairCount: readOptionalNonNegativeInteger(
      source,
      "modelPrimaryRepairCount",
      label,
    ),
    reviewRepairCount: readOptionalNonNegativeInteger(source, "reviewRepairCount", label),
    newIssueAfterRepairCount: readOptionalNonNegativeInteger(
      source,
      "newIssueAfterRepairCount",
      label,
    ),
    blockingNewIssueAfterRepairCount: readOptionalNonNegativeInteger(
      source,
      "blockingNewIssueAfterRepairCount",
      label,
    ),
    sourceIncompleteIssueAfterRepairCount: readOptionalNonNegativeInteger(
      source,
      "sourceIncompleteIssueAfterRepairCount",
      label,
    ),
    qualityProjection: {
      policyVersion: readString(projectionSource, "policyVersion", `${label}.qualityProjection`),
      grantId: readString(projectionSource, "grantId", `${label}.qualityProjection`),
      runId: readString(projectionSource, "runId", `${label}.qualityProjection`),
      inputSealed: readLiteral(
        projectionSource,
        "inputSealed",
        ["passed", "partial", "held", "failed"] as const,
        `${label}.qualityProjection`,
      ),
      deepContract: readLiteral(
        projectionSource,
        "deepContract",
        ["passed", "partial", "held", "failed"] as const,
        `${label}.qualityProjection`,
      ),
    },
  };
}

function makeReceipt(
  plan: DeepRepairExperimentPlan,
  observationSha256: string,
  fields: Omit<
    DeepRepairExperimentReceipt,
    | "schema"
    | "receiptSha256"
    | "planSha256"
    | "manifestSha256"
    | "seriesId"
    | "objective"
    | "mode"
    | "provenanceStatus"
    | "observationSha256"
  >,
): DeepRepairExperimentReceipt {
  const body = {
    schema: "deep-repair-experiment-receipt-v1" as const,
    planSha256: plan.planSha256,
    manifestSha256: plan.manifestSha256,
    seriesId: plan.manifest.seriesId,
    objective: plan.manifest.objective,
    mode: plan.manifest.mode,
    provenanceStatus: plan.manifest.provenance.status,
    observationSha256,
    ...fields,
  };
  return deepFreeze({ ...body, receiptSha256: sha256(body) });
}

export function createDeepRepairExperimentPlan(manifestInput: unknown): DeepRepairExperimentPlan {
  const manifest = normalizeManifest(manifestInput);
  const sequence = manifest.waves.flatMap((wave) =>
    wave.targets.map((target, index) => ({
      ...target,
      sequence:
        manifest.waves
          .slice(0, manifest.waves.indexOf(wave))
          .reduce((count, previousWave) => count + previousWave.targets.length, 0) +
        index,
      waveId: wave.waveId,
    })),
  );
  const manifestSha256 = sha256(manifest);
  const body = {
    schema: "deep-repair-experiment-plan-v1" as const,
    manifest,
    sequence,
    manifestSha256,
  };
  return deepFreeze({ ...body, planSha256: sha256(body) });
}

export function replayDeepRepairExperiment(
  plan: DeepRepairExperimentPlan,
  replayInput: unknown,
): DeepRepairExperimentReceipt {
  const observationSha256 = sha256(replayInput);
  const invalidReasons: string[] = [];
  try {
    const canonicalPlan = createDeepRepairExperimentPlan(plan.manifest);
    if (canonicalJson(plan) !== canonicalJson(canonicalPlan)) {
      invalidReasons.push("plan_not_canonical");
    }
  } catch {
    invalidReasons.push("plan_not_canonical");
  }
  if (sha256(planBody(plan)) !== plan.planSha256) {
    invalidReasons.push("plan_sha_mismatch");
  }
  if (sha256(plan.manifest) !== plan.manifestSha256) {
    invalidReasons.push("manifest_sha_mismatch");
  }

  let lifecycle: LifecycleStatus = "unknown";
  let executionProvenance: ExecutionProvenance | null = null;
  let observations: NormalizedObservation[] = [];
  try {
    const source = asRecord(replayInput, "observations");
    if (source.executionProvenance !== undefined && source.executionProvenance !== null) {
      try {
        executionProvenance = normalizeExecutionProvenance(source.executionProvenance);
      } catch {
        invalidReasons.push("execution_provenance_malformed");
      }
    }
    if (plan.manifest.mode === "formal" && executionProvenance === null) {
      invalidReasons.push("execution_provenance_missing");
    }
    const notices = readArray(source, "notices", "observations");
    if (notices.length === 0 || notices.length > plan.sequence.length || notices.length > MAX_SAMPLE_SIZE) {
      invalidReasons.push("observation_count_out_of_range");
    }
    observations = notices.slice(0, MAX_SAMPLE_SIZE).map(normalizeObservation);

    const lifecycles = readArray(source, "waveLifecycles", "observations");
    const lifecycleByWave = new Map<string, LifecycleStatus>();
    for (let index = 0; index < lifecycles.length; index += 1) {
      const label = `observations.waveLifecycles[${index}]`;
      const item = asRecord(lifecycles[index], label);
      const waveId = readString(item, "waveId", label);
      const status = readLiteral(item, "status", ["finished", "unknown"] as const, label);
      if (lifecycleByWave.has(waveId) || !plan.manifest.waves.some((wave) => wave.waveId === waveId)) {
        invalidReasons.push("lifecycle_binding_mismatch");
      } else {
        lifecycleByWave.set(waveId, status);
      }
    }
    const observedWaveIds = new Set(observations.map((observation) => observation.waveId));
    lifecycle = [...observedWaveIds].every((waveId) => lifecycleByWave.get(waveId) === "finished")
      ? "finished"
      : "unknown";
  } catch {
    invalidReasons.push("malformed_observation");
  }

  let repairedNoticeCount = 0;
  let repairAttemptCount = 0;
  let deterministicPrimaryRepairCount = 0;
  let modelPrimaryRepairCount = 0;
  let reviewRepairCount = 0;
  let newIssueAfterRepairCount = 0;
  let blockingNewIssueAfterRepairCount = 0;
  let sourceIncompleteIssueAfterRepairCount = 0;
  let repairBreakdownComplete = true;
  let publishable = 0;
  let held = 0;
  const checkpoints: GateCheckpoint[] = [];
  let terminalAt: number | null = null;
  const observedRunIds = new Set<string>();
  const observedRunArtifactPaths = new Set<string>();
  const observedRunArtifactHashes = new Set<string>();

  if (plan.manifest.mode === "formal" && executionProvenance !== null) {
    if (
      executionProvenance.gitSha !== plan.manifest.provenance.gitSha ||
      executionProvenance.packageRuntimeSha256 !== plan.manifest.provenance.packageRuntimeSha256 ||
      executionProvenance.validatorVersion !== plan.manifest.provenance.validatorVersion
    ) {
      invalidReasons.push("execution_provenance_mismatch");
    }
  }

  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const expected = plan.sequence[index];
    if (
      expected === undefined ||
      observation.waveId !== expected.waveId ||
      observation.grantId !== expected.grantId ||
      observation.inputSha256 !== expected.inputSha256 ||
      observation.attachmentManifestSha256 !== expected.attachmentManifestSha256 ||
      (expected.runBinding !== null &&
        (observation.runId !== expected.runBinding.runId ||
          observation.runArtifactSha256 !== expected.runBinding.runArtifactSha256 ||
          (observation.runArtifactPath !== null &&
            observation.runArtifactPath !== expected.runBinding.runArtifactPath)))
    ) {
      invalidReasons.push("observation_order_or_binding_mismatch");
    }
    if (observedRunIds.has(observation.runId)) {
      invalidReasons.push("duplicate_run_binding");
    }
    observedRunIds.add(observation.runId);
    if (observedRunArtifactHashes.has(observation.runArtifactSha256)) {
      invalidReasons.push("duplicate_run_binding");
    }
    observedRunArtifactHashes.add(observation.runArtifactSha256);
    if (plan.manifest.mode === "formal") {
      if (observation.runArtifactPath === null) {
        invalidReasons.push("formal_run_binding_incomplete");
      } else if (observedRunArtifactPaths.has(observation.runArtifactPath)) {
        invalidReasons.push("duplicate_run_binding");
      } else {
        observedRunArtifactPaths.add(observation.runArtifactPath);
      }
    }
    if (
      observation.promptVersion !== plan.manifest.policy.promptVersion ||
      observation.model !== plan.manifest.policy.model ||
      observation.transport !== plan.manifest.policy.transport
    ) {
      invalidReasons.push("policy_binding_mismatch");
    }
    if (
      observation.qualityProjection.policyVersion !== plan.manifest.policy.qualityPolicyVersion ||
      observation.qualityProjection.grantId !== observation.grantId ||
      observation.qualityProjection.runId !== observation.runId
    ) {
      invalidReasons.push("quality_projection_binding_mismatch");
    }

    const repairCounts = [
      observation.deterministicPrimaryRepairCount,
      observation.modelPrimaryRepairCount,
      observation.reviewRepairCount,
    ];
    if (repairCounts.some((count) => count === null)) {
      repairBreakdownComplete = false;
      if (plan.manifest.mode === "formal") {
        invalidReasons.push("repair_provenance_missing");
      }
    } else {
      const deterministicCount = observation.deterministicPrimaryRepairCount!;
      const modelCount = observation.modelPrimaryRepairCount!;
      const reviewCount = observation.reviewRepairCount!;
      deterministicPrimaryRepairCount += deterministicCount;
      modelPrimaryRepairCount += modelCount;
      reviewRepairCount += reviewCount;
      if (deterministicCount + modelCount !== observation.primaryRepairCount) {
        invalidReasons.push("repair_provenance_mismatch");
      }
      if (plan.manifest.mode === "formal" && reviewCount > 0) {
        invalidReasons.push("confirmatory_review_repair_present");
      }
    }
    if (observation.newIssueAfterRepairCount === null) {
      repairBreakdownComplete = false;
      if (plan.manifest.mode === "formal") {
        invalidReasons.push("repair_transition_provenance_missing");
      }
    } else {
      newIssueAfterRepairCount += observation.newIssueAfterRepairCount;
      if (
        plan.manifest.mode === "formal"
        && plan.manifest.policy.gatePolicyVersion === "repair-sprt-v1"
        && observation.newIssueAfterRepairCount > 0
      ) {
        invalidReasons.push("new_issue_after_repair_present");
      }
    }
    if (plan.manifest.policy.gatePolicyVersion === "repair-sprt-v2") {
      if (
        observation.blockingNewIssueAfterRepairCount === null
        || observation.sourceIncompleteIssueAfterRepairCount === null
      ) {
        repairBreakdownComplete = false;
        if (plan.manifest.mode === "formal") {
          invalidReasons.push("repair_transition_provenance_missing");
        }
      } else {
        blockingNewIssueAfterRepairCount += observation.blockingNewIssueAfterRepairCount;
        sourceIncompleteIssueAfterRepairCount += observation.sourceIncompleteIssueAfterRepairCount;
        if (
          observation.newIssueAfterRepairCount !== null
          && observation.blockingNewIssueAfterRepairCount
            + observation.sourceIncompleteIssueAfterRepairCount
            !== observation.newIssueAfterRepairCount
        ) {
          invalidReasons.push("repair_transition_provenance_mismatch");
        }
        if (
          plan.manifest.mode === "formal"
          && observation.blockingNewIssueAfterRepairCount > 0
        ) {
          invalidReasons.push("blocking_new_issue_after_repair_present");
        }
      }
    }
    repairAttemptCount += observation.primaryRepairCount;
    repairedNoticeCount += observation.primaryRepairCount > 0 ? 1 : 0;
    publishable += observation.noticeOutcome === "publishable" ? 1 : 0;
    held += observation.noticeOutcome === "held" ? 1 : 0;
    const checkpoint = evaluateGate(index + 1, repairedNoticeCount, plan.sequence.length);
    checkpoints.push(checkpoint);
    if (terminalAt !== null) {
      invalidReasons.push("observation_after_terminal_gate");
    } else if (checkpoint.statisticalVerdict !== "CONTINUE") {
      terminalAt = index + 1;
    }
  }

  const statisticalVerdict = checkpoints.at(-1)?.statisticalVerdict ?? null;
  if (
    plan.manifest.mode === "formal" &&
    statisticalVerdict !== null &&
    statisticalVerdict !== "CONTINUE"
  ) {
    const requiredStrata = deepRepairRequiredStrataForVersion(plan.manifest.strataVersion!);
    const observedStrata = new Set(
      plan.sequence.slice(0, observations.length).map((target) => target.stratum),
    );
    if (requiredStrata.some((stratum) => !observedStrata.has(stratum))) {
      invalidReasons.push("required_strata_unobserved");
    }
  }
  if (plan.manifest.mode === "formal" && statisticalVerdict === "GO") {
    if (
      observations.some(
        (observation) =>
          observation.noticeOutcome !== "publishable" ||
          observation.qualityProjection.inputSealed !== "passed" ||
          observation.qualityProjection.deepContract !== "passed",
      )
    ) {
      invalidReasons.push("quality_hard_gate_failed");
    }
    if (lifecycle !== "finished") {
      invalidReasons.push("lifecycle_not_finished_for_go");
    }
  }

  const uniqueInvalidReasons = [...new Set(invalidReasons)];
  let verdict: ReceiptVerdict = statisticalVerdict ?? "INVALID";
  if (statisticalVerdict === "GO" && plan.manifest.mode === "legacy_shadow") {
    uniqueInvalidReasons.push("legacy_shadow_cannot_issue_go");
  }
  if (uniqueInvalidReasons.length > 0) {
    verdict = "INVALID";
  }

  return makeReceipt(plan, observationSha256, {
    lifecycle,
    executionProvenance,
    observedCount: observations.length,
    repairedNoticeCount,
    repairAttemptCount,
    repairBreakdown: repairBreakdownComplete
      ? {
          deterministicPrimary: deterministicPrimaryRepairCount,
          modelPrimary: modelPrimaryRepairCount,
          review: reviewRepairCount,
          newIssuesAfterRepair: newIssueAfterRepairCount,
          ...(plan.manifest.policy.gatePolicyVersion === "repair-sprt-v2"
            ? {
                blockingNewIssuesAfterRepair: blockingNewIssueAfterRepairCount,
                sourceIncompleteIssuesAfterRepair: sourceIncompleteIssueAfterRepairCount,
              }
            : {}),
        }
      : null,
    outcomes: { publishable, held },
    checkpoints,
    statisticalVerdict,
    verdict,
    invalidReasons: uniqueInvalidReasons,
  });
}
