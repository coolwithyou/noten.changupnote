import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/features/dev/analysis-lab/contract";
import { ANALYSIS_QUALITY_POLICY_VERSION } from "@/features/dev/analysis-lab/quality-contract";
import {
  createDeepRepairExperimentPlan,
  type DeepRepairExperimentPlan,
} from "./deep-repair-experiment";
import {
  DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE,
  DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE,
  DEEP_REPAIR_FORMAL_REQUIRED_STRATA,
} from "./deep-repair-formal-policy";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import { analysisLabDir } from "./run-store";

export const DEEP_REPAIR_PREPARATION_POLICY = Object.freeze({
  seriesId: "deep-v18" as const,
  seed: 20260814,
  targetCount: DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE,
  waveSize: DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE,
  model: "claude-opus-5" as const,
  transport: "claude-cli" as const,
  gatePolicyVersion: "repair-sprt-v1" as const,
});

const SHA256 = /^[a-f0-9]{64}$/;
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACT_PREFIX = "spike-out/analysis-lab/experiments/";
const PREPARATION_ARTIFACT_PATH = /^spike-out\/analysis-lab\/experiments\/(cohorts|plans|proposals)\/([a-f0-9]{64})\.json$/;
const SERIES_MARKER_PATH = "spike-out/analysis-lab/experiments/series/deep-v18.json";

export interface DeepRepairProposalTarget {
  readonly grantId: string;
  readonly source: string;
  readonly title: string;
  readonly stratum: string;
}

export interface DeepRepairProposalSelection {
  readonly targets: readonly DeepRepairProposalTarget[];
  readonly quotas: {
    readonly unified: { readonly target: number; readonly achieved: number };
    readonly richCriteria: { readonly target: number; readonly achieved: number };
  };
  readonly warnings: readonly string[];
}

export interface DeepRepairPreparedProposalTarget {
  readonly grantId: string;
  readonly source: string;
  readonly title: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly inputTotalChars: number;
  readonly inputBlocks: readonly {
    readonly label: string;
    readonly chars: number;
    readonly truncated: boolean;
  }[];
}

export interface DeepRepairExecutionProvenance {
  readonly gitSha: string;
  readonly packageRuntimeSha256: string;
  readonly validatorVersion: string;
}

export interface DeepRepairProposalArtifactWrite {
  readonly path: string;
  readonly bytes: Buffer;
}

export interface DeepRepairPreparationDependencies {
  readonly now: () => Date;
  readonly readExecutionProvenance: () => Promise<DeepRepairExecutionProvenance>;
  readonly listExcludedGrantIds: () => Promise<readonly string[]>;
  readonly selectTargets: (input: {
    readonly excludedGrantIds: readonly string[];
  }) => Promise<DeepRepairProposalSelection>;
  readonly prepareTarget: (grantId: string) => Promise<DeepRepairPreparedProposalTarget>;
  readonly writeImmutableArtifact: (artifact: DeepRepairProposalArtifactWrite) => Promise<void>;
}

export interface DeepRepairProposalPreparationResult {
  readonly plan: DeepRepairExperimentPlan;
  readonly planArtifactSha256: string;
  readonly proposalSha256: string;
  readonly proposalPath: string;
  readonly seriesMarkerPath: typeof SERIES_MARKER_PATH;
  readonly cohortArtifacts: readonly {
    readonly waveId: string;
    readonly sha256: string;
    readonly path: string;
  }[];
}

export interface DeepRepairProposalPreparer {
  prepare(input: {
    readonly seriesId: string;
  }): Promise<DeepRepairProposalPreparationResult>;
}

interface MaterializedTarget extends DeepRepairProposalTarget {
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly inputTotalChars: number;
  readonly inputBlocks: readonly {
    readonly label: string;
    readonly chars: number;
    readonly truncated: boolean;
  }[];
}

interface EncodedArtifact {
  readonly path: string;
  readonly bytes: Buffer;
  readonly rawSha256: string;
}

/**
 * Gate R의 proposal-only 준비 seam. 외부에 노출되는 입력은 series 하나뿐이고, 대상 수·시드·
 * 모델·transport·wave 크기와 안전 정책은 모듈 안에 고정한다.
 */
export function createDeepRepairProposalPreparer(
  dependencies: DeepRepairPreparationDependencies,
): DeepRepairProposalPreparer {
  return {
    async prepare(input) {
      if (input.seriesId !== DEEP_REPAIR_PREPARATION_POLICY.seriesId) {
        throw new Error(`only ${DEEP_REPAIR_PREPARATION_POLICY.seriesId} can be prepared`);
      }

      const provenanceBefore = normalizeProvenance(
        await dependencies.readExecutionProvenance(),
      );
      const excludedBefore = normalizeExcludedGrantIds(
        await dependencies.listExcludedGrantIds(),
      );
      const rawSelection = await dependencies.selectTargets({ excludedGrantIds: excludedBefore });
      const selected = normalizeSelectedTargets(
        rawSelection.targets,
        excludedBefore,
      );
      const selectionReview = normalizeSelectionReview(rawSelection, selected);

      const materialized: MaterializedTarget[] = [];
      for (const target of selected) {
        const prepared = await dependencies.prepareTarget(target.grantId);
        if (
          prepared.grantId !== target.grantId
          || prepared.source !== target.source
          || prepared.title !== target.title
        ) {
          throw new Error(`prepared target metadata drift: ${target.grantId}`);
        }
        materialized.push({
          ...target,
          inputSha256: exactSha(prepared.inputSha256, `${target.grantId}.inputSha256`),
          attachmentManifestSha256: exactSha(
            prepared.attachmentManifestSha256,
            `${target.grantId}.attachmentManifestSha256`,
          ),
          inputTotalChars: nonNegativeInteger(
            prepared.inputTotalChars,
            `${target.grantId}.inputTotalChars`,
          ),
          inputBlocks: normalizeInputBlocks(prepared.inputBlocks, target.grantId),
        });
      }

      const excludedAfterValues = normalizeExcludedGrantIds(
        await dependencies.listExcludedGrantIds(),
      );
      const excludedAfter = new Set(excludedAfterValues);
      const newOverlap = materialized.find((target) => excludedAfter.has(target.grantId));
      if (newOverlap) {
        throw new Error(`selected target became excluded during preparation: ${newOverlap.grantId}`);
      }
      if (canonicalJson(excludedAfterValues) !== canonicalJson(excludedBefore)) {
        throw new Error("historical exclusion set drift during proposal preparation");
      }
      const selectionAfterRaw = await dependencies.selectTargets({
        excludedGrantIds: excludedAfterValues,
      });
      const selectionAfter = normalizeSelectedTargets(
        selectionAfterRaw.targets,
        excludedAfterValues,
      );
      const selectionReviewAfter = normalizeSelectionReview(selectionAfterRaw, selectionAfter);
      if (
        canonicalJson(selectionAfter) !== canonicalJson(selected)
        || canonicalJson(selectionReviewAfter) !== canonicalJson(selectionReview)
      ) {
        throw new Error("candidate selection or stratum basis drift during proposal preparation");
      }
      const provenanceAfter = normalizeProvenance(
        await dependencies.readExecutionProvenance(),
      );
      if (canonicalJson(provenanceAfter) !== canonicalJson(provenanceBefore)) {
        throw new Error("execution provenance drift during proposal preparation");
      }

      const selectedAt = exactIsoDate(dependencies.now());
      const cohortArtifacts = buildCohortArtifacts(materialized, selectedAt);
      const plan = createPlan(materialized, provenanceBefore, selectedAt, cohortArtifacts);
      const planBytes = encodeDeterministicJson(plan);
      const planArtifactSha256 = sha256Bytes(planBytes);
      const planArtifact: EncodedArtifact = {
        path: `${ARTIFACT_PREFIX}plans/${plan.planSha256}.json`,
        bytes: planBytes,
        rawSha256: planArtifactSha256,
      };
      const proposal = buildProposal({
        materialized,
        plan,
        planArtifactSha256,
        cohortArtifacts,
        preparedAt: selectedAt,
        excludedGrantCount: excludedBefore.length,
        excludedGrantIdsSha256: sha256Bytes(Buffer.from(canonicalJson(excludedBefore), "utf8")),
        selectionReview,
      });
      const proposalBytes = encodeDeterministicJson(proposal);
      const proposalSha256 = sha256Bytes(proposalBytes);
      const proposalArtifact: EncodedArtifact = {
        path: `${ARTIFACT_PREFIX}proposals/${proposalSha256}.json`,
        bytes: proposalBytes,
        rawSha256: proposalSha256,
      };
      const seriesMarker = {
        schema: "deep-repair-series-proposal-v1" as const,
        seriesId: DEEP_REPAIR_PREPARATION_POLICY.seriesId,
        proposalPath: proposalArtifact.path,
        proposalSha256,
        planSha256: plan.planSha256,
        planArtifactSha256,
        manifestSha256: plan.manifestSha256,
      };
      const seriesMarkerBytes = encodeDeterministicJson(seriesMarker);
      const seriesMarkerArtifact: EncodedArtifact = {
        path: SERIES_MARKER_PATH,
        bytes: seriesMarkerBytes,
        rawSha256: sha256Bytes(seriesMarkerBytes),
      };
      const result = Object.freeze({
        plan,
        planArtifactSha256,
        proposalSha256,
        proposalPath: proposalArtifact.path,
        seriesMarkerPath: SERIES_MARKER_PATH,
        cohortArtifacts: Object.freeze(cohortArtifacts.map((artifact) => Object.freeze({
          waveId: artifact.waveId,
          sha256: artifact.rawSha256,
          path: artifact.path,
        }))),
      });

      const allArtifacts = [
        ...cohortArtifacts,
        planArtifact,
        proposalArtifact,
        seriesMarkerArtifact,
      ];
      for (const artifact of allArtifacts) {
        await dependencies.writeImmutableArtifact({ path: artifact.path, bytes: artifact.bytes });
      }
      return result;
    },
  };
}

function normalizeSelectedTargets(
  targets: readonly DeepRepairProposalTarget[],
  excludedGrantIds: readonly string[],
): DeepRepairProposalTarget[] {
  if (targets.length !== DEEP_REPAIR_PREPARATION_POLICY.targetCount) {
    throw new Error(
      `proposal selection must contain exactly ${DEEP_REPAIR_PREPARATION_POLICY.targetCount} targets`,
    );
  }
  const excluded = new Set(excludedGrantIds);
  const seen = new Set<string>();
  const normalized = targets.map((target, index) => {
    for (const [label, value] of Object.entries({
      grantId: target.grantId,
      source: target.source,
      title: target.title,
      stratum: target.stratum,
    })) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`selected target ${index}.${label} must be a non-empty string`);
      }
    }
    if (seen.has(target.grantId)) {
      throw new Error(`duplicate selected target: ${target.grantId}`);
    }
    if (excluded.has(target.grantId)) {
      throw new Error(`excluded target selected: ${target.grantId}`);
    }
    if (!UUID.test(target.grantId)) {
      throw new Error(`selected target ${index}.grantId must be a lowercase UUID`);
    }
    if (!DEEP_REPAIR_FORMAL_REQUIRED_STRATA.some((stratum) => stratum === target.stratum)) {
      throw new Error(`unsupported selected target stratum: ${target.stratum}`);
    }
    seen.add(target.grantId);
    return Object.freeze({
      grantId: target.grantId,
      source: target.source,
      title: target.title,
      stratum: target.stratum,
    });
  });
  const prefixStrata = new Set(
    normalized.slice(0, DEEP_REPAIR_PREPARATION_POLICY.waveSize).map((target) => target.stratum),
  );
  const missing = DEEP_REPAIR_FORMAL_REQUIRED_STRATA.filter(
    (stratum) => !prefixStrata.has(stratum),
  );
  if (missing.length > 0) {
    throw new Error(`first 15 targets are missing required strata: ${missing.join(", ")}`);
  }
  return normalized;
}

function buildCohortArtifacts(
  targets: readonly MaterializedTarget[],
  selectedAt: string,
): Array<EncodedArtifact & { readonly waveId: string }> {
  const artifacts: Array<EncodedArtifact & { readonly waveId: string }> = [];
  for (let offset = 0; offset < targets.length; offset += DEEP_REPAIR_PREPARATION_POLICY.waveSize) {
    const waveIndex = offset / DEEP_REPAIR_PREPARATION_POLICY.waveSize + 1;
    const waveId = `wave-${waveIndex}`;
    const body = {
      schema: "deep-repair-cohort-v1" as const,
      seriesId: DEEP_REPAIR_PREPARATION_POLICY.seriesId,
      waveId,
      selectedAt,
      seed: DEEP_REPAIR_PREPARATION_POLICY.seed,
      orderedTargets: targets
        .slice(offset, offset + DEEP_REPAIR_PREPARATION_POLICY.waveSize)
        .map((target) => ({ grantId: target.grantId, stratum: target.stratum })),
    };
    const bytes = encodeDeterministicJson(body);
    const rawSha256 = sha256Bytes(bytes);
    artifacts.push({
      waveId,
      path: `${ARTIFACT_PREFIX}cohorts/${rawSha256}.json`,
      bytes,
      rawSha256,
    });
  }
  return artifacts;
}

function createPlan(
  targets: readonly MaterializedTarget[],
  provenance: DeepRepairExecutionProvenance,
  selectedAt: string,
  cohortArtifacts: readonly (EncodedArtifact & { readonly waveId: string })[],
): DeepRepairExperimentPlan {
  return createDeepRepairExperimentPlan({
    schema: "deep-repair-series-manifest-v1",
    seriesId: DEEP_REPAIR_PREPARATION_POLICY.seriesId,
    objective: "deep-primary-repair-rate",
    mode: "formal",
    formation: "prospective",
    strataVersion: "deep-repair-strata-v1",
    provenance: {
      status: "complete",
      unavailable: [],
      gitSha: provenance.gitSha,
      packageRuntimeSha256: provenance.packageRuntimeSha256,
      validatorVersion: provenance.validatorVersion,
    },
    policy: {
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      model: DEEP_REPAIR_PREPARATION_POLICY.model,
      transport: DEEP_REPAIR_PREPARATION_POLICY.transport,
      qualityPolicyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
      gatePolicyVersion: DEEP_REPAIR_PREPARATION_POLICY.gatePolicyVersion,
    },
    waves: cohortArtifacts.map((artifact, waveIndex) => {
      const offset = waveIndex * DEEP_REPAIR_PREPARATION_POLICY.waveSize;
      return {
        waveId: artifact.waveId,
        cohort: {
          artifactPath: artifact.path,
          sha256: artifact.rawSha256,
          selectedAt,
          seed: DEEP_REPAIR_PREPARATION_POLICY.seed,
        },
        targets: targets
          .slice(offset, offset + DEEP_REPAIR_PREPARATION_POLICY.waveSize)
          .map((target) => ({
            grantId: target.grantId,
            stratum: target.stratum,
            inputSha256: target.inputSha256,
            attachmentManifestSha256: target.attachmentManifestSha256,
          })),
      };
    }),
  });
}

function buildProposal(input: {
  readonly materialized: readonly MaterializedTarget[];
  readonly plan: DeepRepairExperimentPlan;
  readonly planArtifactSha256: string;
  readonly cohortArtifacts: readonly (EncodedArtifact & { readonly waveId: string })[];
  readonly preparedAt: string;
  readonly excludedGrantCount: number;
  readonly excludedGrantIdsSha256: string;
  readonly selectionReview: ReturnType<typeof normalizeSelectionReview>;
}) {
  const metadata = new Map(
    input.materialized.map((target) => [target.grantId, target] as const),
  );
  return {
    schema: "deep-repair-proposal-v1" as const,
    preparedAt: input.preparedAt,
    policy: {
      seriesId: DEEP_REPAIR_PREPARATION_POLICY.seriesId,
      seed: DEEP_REPAIR_PREPARATION_POLICY.seed,
      targetCount: DEEP_REPAIR_PREPARATION_POLICY.targetCount,
      waveSize: DEEP_REPAIR_PREPARATION_POLICY.waveSize,
      objective: input.plan.manifest.objective,
      promptVersion: input.plan.manifest.policy.promptVersion,
      model: DEEP_REPAIR_PREPARATION_POLICY.model,
      transport: DEEP_REPAIR_PREPARATION_POLICY.transport,
      qualityPolicyVersion: input.plan.manifest.policy.qualityPolicyVersion,
      gatePolicyVersion: DEEP_REPAIR_PREPARATION_POLICY.gatePolicyVersion,
    },
    provenance: input.plan.manifest.provenance,
    exclusions: {
      source: "existing-runs-and-cohort-snapshots" as const,
      grantCount: input.excludedGrantCount,
      grantIdsSha256: input.excludedGrantIdsSha256,
    },
    selection: input.selectionReview,
    plan: {
      path: `${ARTIFACT_PREFIX}plans/${input.plan.planSha256}.json`,
      planSha256: input.plan.planSha256,
      rawSha256: input.planArtifactSha256,
      manifestSha256: input.plan.manifestSha256,
    },
    cohorts: input.cohortArtifacts.map((artifact) => ({
      waveId: artifact.waveId,
      path: artifact.path,
      rawSha256: artifact.rawSha256,
    })),
    sequence: input.plan.sequence.map((target) => {
      const exact = metadata.get(target.grantId);
      if (!exact) throw new Error(`proposal metadata missing: ${target.grantId}`);
      return {
        sequence: target.sequence,
        waveId: target.waveId,
        grantId: target.grantId,
        source: exact.source,
        title: exact.title,
        stratum: target.stratum,
        inputSha256: target.inputSha256,
        attachmentManifestSha256: target.attachmentManifestSha256,
        inputTotalChars: exact.inputTotalChars,
        inputBlocks: exact.inputBlocks,
      };
    }),
    safety: {
      artifactKind: "proposal-only" as const,
      liveExecutionAuthorized: false,
      authorityScope: "one-authority-one-target" as const,
      nextTarget: "new-user-approval-required" as const,
      continueVerdictAction: "new-user-approval-required" as const,
      excludedLanes: ["kordoc", "review", "promotion"] as const,
      stopVerdicts: ["GO", "NO_GO", "INCONCLUSIVE", "INVALID"] as const,
    },
    unresolvedGateConditions: [
      "current-production-observe-only-evidence",
      "runtime-generation-and-lease",
      "per-target-user-approval-and-authority",
    ] as const,
  };
}

function normalizeSelectionReview(
  selection: DeepRepairProposalSelection,
  targets: readonly DeepRepairProposalTarget[],
) {
  const strataCounts: Record<string, number> = {};
  for (const stratum of DEEP_REPAIR_FORMAL_REQUIRED_STRATA) strataCounts[stratum] = 0;
  for (const target of targets) strataCounts[target.stratum] = (strataCounts[target.stratum] ?? 0) + 1;
  if (!selection.quotas || typeof selection.quotas !== "object") {
    throw new Error("selection soft quotas are required");
  }
  const normalizeQuota = (
    quota: { readonly target: number; readonly achieved: number } | undefined,
    label: string,
  ) => {
    if (!quota || typeof quota !== "object") throw new Error(`selection ${label} quota is required`);
    return Object.freeze({
      target: nonNegativeInteger(quota.target, `selection.${label}.target`),
      achieved: nonNegativeInteger(quota.achieved, `selection.${label}.achieved`),
    });
  };
  if (!Array.isArray(selection.warnings)) throw new Error("selection warnings must be an array");
  const warnings = selection.warnings.map((warning, index) => {
    if (typeof warning !== "string" || warning.trim() === "") {
      throw new Error(`selection.warnings[${index}] must be a non-empty string`);
    }
    return warning;
  });
  return Object.freeze({
    strataCounts: Object.freeze(strataCounts),
    softQuotas: Object.freeze({
      unified: normalizeQuota(selection.quotas.unified, "unified"),
      richCriteria: normalizeQuota(selection.quotas.richCriteria, "richCriteria"),
    }),
    warnings: Object.freeze(warnings),
  });
}

export function createDeepRepairProposalFilesystemWriter(options: {
  readonly rootDir?: string;
} = {}): (artifact: DeepRepairProposalArtifactWrite) => Promise<void> {
  const rootDir = resolve(options.rootDir ?? join(analysisLabDir(), "experiments"));
  return async (artifact) => {
    if (artifact.path === SERIES_MARKER_PATH) {
      let markerSource: Record<string, unknown>;
      try {
        markerSource = JSON.parse(artifact.bytes.toString("utf8")) as Record<string, unknown>;
      } catch (error) {
        throw new Error("series marker must be canonical JSON", { cause: error });
      }
      const proposalSha256 = typeof markerSource.proposalSha256 === "string"
        ? markerSource.proposalSha256
        : "";
      const marker = {
        schema: "deep-repair-series-proposal-v1" as const,
        seriesId: DEEP_REPAIR_PREPARATION_POLICY.seriesId,
        proposalPath: `${ARTIFACT_PREFIX}proposals/${proposalSha256}.json`,
        proposalSha256,
        planSha256: markerSource.planSha256,
        planArtifactSha256: markerSource.planArtifactSha256,
        manifestSha256: markerSource.manifestSha256,
      };
      if (
        !SHA256.test(proposalSha256)
        || typeof marker.planSha256 !== "string"
        || !SHA256.test(marker.planSha256)
        || typeof marker.planArtifactSha256 !== "string"
        || !SHA256.test(marker.planArtifactSha256)
        || typeof marker.manifestSha256 !== "string"
        || !SHA256.test(marker.manifestSha256)
        || canonicalJson(markerSource) !== canonicalJson(marker)
        || canonicalJson(marker) !== artifact.bytes.toString("utf8").trimEnd()
      ) {
        throw new Error("series marker binding must be exact and canonical");
      }
      await writePreparationArtifact(rootDir, artifact);
      return;
    }
    const match = PREPARATION_ARTIFACT_PATH.exec(artifact.path);
    if (!match) throw new Error(`unsupported preparation artifact path: ${artifact.path}`);
    const artifactKind = match[1]!;
    const filenameSha256 = match[2]!;
    if (artifactKind === "plans") {
      let storedPlan: unknown;
      try {
        storedPlan = JSON.parse(artifact.bytes.toString("utf8"));
        const source = storedPlan as { manifest?: unknown };
        const canonicalPlan = createDeepRepairExperimentPlan(source.manifest);
        if (
          canonicalPlan.planSha256 !== filenameSha256
          || canonicalJson(storedPlan) !== canonicalJson(canonicalPlan)
        ) {
          throw new Error("canonical plan mismatch");
        }
      } catch (error) {
        throw new Error("plan filename must equal the parsed canonical planSha", { cause: error });
      }
    } else if (sha256Bytes(artifact.bytes) !== filenameSha256) {
      throw new Error(`${artifactKind} content address mismatch`);
    }
    await writePreparationArtifact(rootDir, artifact);
  };
}

async function writePreparationArtifact(
  rootDir: string,
  artifact: DeepRepairProposalArtifactWrite,
): Promise<void> {
  const relativePath = artifact.path.slice(ARTIFACT_PREFIX.length);
  const path = resolve(rootDir, relativePath);
  if (!isWithin(rootDir, path) || relative(rootDir, path).startsWith("..")) {
    throw new Error(`unsupported preparation artifact path: ${artifact.path}`);
  }
  await writeImmutableBytesAtomic(path, artifact.bytes);
}

function normalizeInputBlocks(
  blocks: readonly {
    readonly label: string;
    readonly chars: number;
    readonly truncated: boolean;
  }[],
  grantId: string,
) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error(`${grantId}.inputBlocks must not be empty`);
  }
  return Object.freeze(blocks.map((block, index) => {
    if (typeof block.label !== "string" || block.label.trim() === "") {
      throw new Error(`${grantId}.inputBlocks[${index}].label must be a non-empty string`);
    }
    if (typeof block.truncated !== "boolean") {
      throw new Error(`${grantId}.inputBlocks[${index}].truncated must be boolean`);
    }
    return Object.freeze({
      label: block.label,
      chars: nonNegativeInteger(block.chars, `${grantId}.inputBlocks[${index}].chars`),
      truncated: block.truncated,
    });
  }));
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeProvenance(
  provenance: DeepRepairExecutionProvenance,
): DeepRepairExecutionProvenance {
  if (!FULL_GIT_SHA.test(provenance.gitSha)) {
    throw new Error("execution provenance gitSha must be exact");
  }
  if (typeof provenance.validatorVersion !== "string" || provenance.validatorVersion.trim() === "") {
    throw new Error("execution provenance validatorVersion must be exact");
  }
  return Object.freeze({
    gitSha: provenance.gitSha,
    packageRuntimeSha256: exactSha(
      provenance.packageRuntimeSha256,
      "execution provenance packageRuntimeSha256",
    ),
    validatorVersion: provenance.validatorVersion,
  });
}

function normalizeExcludedGrantIds(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("excluded grantId must be a non-empty string");
    }
    const grantId = value.toLowerCase();
    if (!UUID.test(grantId)) {
      throw new Error(`excluded grantId must be a UUID: ${value}`);
    }
    if (!seen.has(grantId)) {
      seen.add(grantId);
      normalized.push(grantId);
    }
  }
  return normalized.sort();
}

function exactSha(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be an exact lowercase SHA-256`);
  return value;
}

function exactIsoDate(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("proposal preparation time must be a valid Date");
  }
  return value.toISOString();
}

function encodeDeterministicJson(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
