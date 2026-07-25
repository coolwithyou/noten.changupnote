import { createHash } from "node:crypto";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  buildGrantAnalysisAttachmentSummary,
  buildGrantAnalysisSourceRevision,
  type GrantAnalysisAttachmentSummary,
  type GrantAnalysisEvaluationSource,
} from "../ingestion/grantAnalysisEvaluationCohort";
import { FROZEN_GRANT_ANALYSIS_PILOT_COHORT } from "../ingestion/grantAnalysisPilotCohort";
import { hashGrantRawPayload, stableJsonStringify } from "../ingestion/grantRawHash";

export const DEEP_ANALYSIS_QUALITY_COHORT_AS_OF = "2026-07-25T00:00:00+09:00";
export const DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION =
  "deep-analysis-quality-cohort-v1";

export const DEEP_ANALYSIS_QUALITY_COVERAGE_TAGS = [
  "hwp_attachment",
  "hwpx_attachment",
  "multi_attachment",
  "complex_document_candidate",
  "attachment_only_hard_sentinel_candidate",
  "exclusion_candidate",
  "sparse_condition_candidate",
  "mixed_program_candidate",
] as const;

export type DeepAnalysisQualityCoverageTag =
  (typeof DEEP_ANALYSIS_QUALITY_COVERAGE_TAGS)[number];
export type DeepAnalysisQualitySplit = "validation" | "sealed";

export const DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS = {
  hwp_attachment: 30,
  hwpx_attachment: 15,
  multi_attachment: 20,
  complex_document_candidate: 15,
  attachment_only_hard_sentinel_candidate: 15,
  exclusion_candidate: 20,
  sparse_condition_candidate: 10,
  mixed_program_candidate: 2,
} as const satisfies Readonly<Record<DeepAnalysisQualityCoverageTag, number>>;

export const DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS = {
  kstartup: { validation: 24, sealed: 16, total: 40 },
  bizinfo: { validation: 24, sealed: 16, total: 40 },
} as const;

export const DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS = [
  "kstartup:178320",
  "kstartup:178329",
  "kstartup:178352",
  "bizinfo:PBLN_000000000121478",
] as const;

const COVERAGE_SELECTION_ORDER = [
  "attachment_only_hard_sentinel_candidate",
  "hwpx_attachment",
  "exclusion_candidate",
  "mixed_program_candidate",
  "hwp_attachment",
  "multi_attachment",
  "complex_document_candidate",
  "sparse_condition_candidate",
] as const satisfies readonly DeepAnalysisQualityCoverageTag[];

const PREVIOUS_EVALUATION_KEYS = new Set(
  FROZEN_GRANT_ANALYSIS_PILOT_COHORT.map(
    (entry) => `${entry.source}:${entry.sourceId}`,
  ),
);

export interface DeepAnalysisQualityExpectedReceipt {
  activeCanonicalCount: number;
  activeDuplicateInclusiveCount: number;
  configuredPreviousEvaluationKeyCount: number;
  excludedActivePreviousEvaluationCount: number;
  requiredRecoveryCount: number;
  historicalRecoveryCount: number;
}

export interface DeepAnalysisQualityPopulationAudit {
  activeCanonicalCount: number;
  activeDuplicateInclusiveCount: number;
  activeCanonicalSha256: string;
  activeDuplicateInclusiveSha256: string;
}

export interface DeepAnalysisQualityExclusionAudit {
  configuredPreviousEvaluationKeyCount: number;
  excludedActivePreviousEvaluationCount: number;
  exclusionSha256: string;
}

export interface DeepAnalysisQualityRecoveryAudit {
  requiredRecoveryCount: number;
  historicalRecoveryCount: number;
  recoveryCommitmentSha256: string;
}

export interface DeepAnalysisQualityCohortEntry {
  source: GrantAnalysisEvaluationSource;
  sourceId: string;
  canonicalId: string;
  title: string;
  status: string;
  applyStart: string | null;
  applyEnd: string | null;
  rawPayloadSha256: string;
  attachmentSummary: GrantAnalysisAttachmentSummary;
  sourceRevisionSha256: string;
  baselineCriteriaCount: number;
  baselineExclusionCount: number;
  coverageTags: DeepAnalysisQualityCoverageTag[];
  requiredRecovery: boolean;
  split: DeepAnalysisQualitySplit;
  selectorRankSha256: string;
  opaqueCommitmentSha256: string;
}

interface PreparedCandidate extends Omit<DeepAnalysisQualityCohortEntry, "split"> {}

export interface DeepAnalysisQualityPublicValidationEntry extends Omit<
  DeepAnalysisQualityCohortEntry,
  "opaqueCommitmentSha256" | "selectorRankSha256"
> {
  split: "validation";
}

export interface DeepAnalysisQualityPublicSealedEntry {
  source: GrantAnalysisEvaluationSource;
  split: "sealed";
  coverageTags: DeepAnalysisQualityCoverageTag[];
  opaqueCommitmentSha256: string;
}

export interface DeepAnalysisQualityPublicManifest {
  recordType: "deep_analysis_quality_cohort_public";
  schemaVersion: 1;
  selectorVersion: typeof DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION;
  asOf: typeof DEEP_ANALYSIS_QUALITY_COHORT_AS_OF;
  population: DeepAnalysisQualityPopulationAudit;
  exclusions: DeepAnalysisQualityExclusionAudit;
  recovery: DeepAnalysisQualityRecoveryAudit;
  sourceQuotas: typeof DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS;
  coverageTargets: typeof DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS;
  coverageAvailability: Record<DeepAnalysisQualityCoverageTag, number>;
  coverageCounts: Record<DeepAnalysisQualityCoverageTag, number>;
  validationCount: 48;
  sealedCount: 32;
  validation: DeepAnalysisQualityPublicValidationEntry[];
  sealed: DeepAnalysisQualityPublicSealedEntry[];
  selectionCommitmentSha256: string;
  externalLlmCalls: 0;
  databaseWriteMode: false;
  manifestSha256: string;
}

export interface DeepAnalysisQualitySecretManifest {
  recordType: "deep_analysis_quality_cohort_secret";
  schemaVersion: 1;
  selectorVersion: typeof DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION;
  asOf: typeof DEEP_ANALYSIS_QUALITY_COHORT_AS_OF;
  seed: string;
  publicManifestSha256: string;
  population: DeepAnalysisQualityPopulationAudit;
  exclusions: DeepAnalysisQualityExclusionAudit;
  recovery: DeepAnalysisQualityRecoveryAudit;
  sourceQuotas: typeof DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS;
  coverageTargets: typeof DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS;
  coverageAvailability: Record<DeepAnalysisQualityCoverageTag, number>;
  coverageCounts: Record<DeepAnalysisQualityCoverageTag, number>;
  selected: DeepAnalysisQualityCohortEntry[];
  externalLlmCalls: 0;
  databaseWriteMode: false;
  manifestSha256: string;
}

export interface DeepAnalysisQualityCohortSelection {
  publicManifest: DeepAnalysisQualityPublicManifest;
  secretManifest: DeepAnalysisQualitySecretManifest;
}

export function selectDeepAnalysisQualityCohort(input: {
  activeEntries: readonly NormalizedGrant<unknown>[];
  duplicateInclusiveEntries: readonly NormalizedGrant<unknown>[];
  requiredRecoveryEntries: readonly NormalizedGrant<unknown>[];
  expectedReceipt: DeepAnalysisQualityExpectedReceipt;
  seed: string;
}): DeepAnalysisQualityCohortSelection {
  assertSeed(input.seed);
  assertExpectedReceipt(input.expectedReceipt);

  const activeCanonical = preparePopulation(input.activeEntries, input.seed, false);
  const activeDuplicateInclusive = preparePopulation(
    input.duplicateInclusiveEntries,
    input.seed,
    false,
  );
  assertUniqueKeys(activeCanonical, "active canonical population");

  const activeKeys = new Set(activeCanonical.map(candidateKey));
  const recoveryEntries = preparePopulation(
    input.requiredRecoveryEntries,
    input.seed,
    true,
  );
  assertUniqueKeys(recoveryEntries, "required recovery population");
  const recoveryByKey = new Map(recoveryEntries.map((entry) => [candidateKey(entry), entry]));
  for (const key of DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS) {
    if (!recoveryByKey.has(key)) {
      throw new Error(`Deep analysis quality recovery fixture is missing: ${key}`);
    }
    if (PREVIOUS_EVALUATION_KEYS.has(key)) {
      throw new Error(`Recovery fixture overlaps the previous evaluation exclusion: ${key}`);
    }
  }
  if (recoveryByKey.size !== DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS.length) {
    throw new Error("Deep analysis quality recovery input contains an unexpected grant.");
  }

  const population = populationAudit(activeCanonical, activeDuplicateInclusive);
  const excludedActive = activeCanonical.filter((entry) =>
    PREVIOUS_EVALUATION_KEYS.has(candidateKey(entry)));
  const exclusions = exclusionAudit(excludedActive);
  const historicalRecoveryCount = recoveryEntries.filter(
    (entry) => !activeKeys.has(candidateKey(entry)),
  ).length;
  const recovery = recoveryAudit(recoveryEntries, historicalRecoveryCount);
  assertExpectedReceiptMatches(input.expectedReceipt, population, exclusions, recovery);

  const poolByKey = new Map(
    activeCanonical
      .filter((entry) => !PREVIOUS_EVALUATION_KEYS.has(candidateKey(entry)))
      .map((entry) => [candidateKey(entry), entry]),
  );
  for (const entry of recoveryEntries) poolByKey.set(candidateKey(entry), entry);
  const pool = [...poolByKey.values()].sort(comparePreparedCandidates);
  const coverageAvailability = coverageCounts(pool);
  const selected = assignSplits(selectExactCohort(pool));
  const selectedCoverageCounts = coverageCounts(selected);
  assertCoverageTargets(selectedCoverageCounts);

  const validation = selected
    .filter((entry): entry is DeepAnalysisQualityCohortEntry & { split: "validation" } =>
      entry.split === "validation")
    .map(publicValidationProjection)
    .sort(comparePublicValidationEntries);
  const sealed = selected
    .filter((entry) => entry.split === "sealed")
    .map(publicSealedProjection)
    .sort(comparePublicSealedEntries);
  const selectionCommitmentSha256 = sha256Canonical(selected.map((entry) => ({
    split: entry.split,
    source: entry.source,
    coverageTags: entry.coverageTags,
    commitment: entry.opaqueCommitmentSha256,
  })));

  const publicWithoutHash: Omit<DeepAnalysisQualityPublicManifest, "manifestSha256"> = {
    recordType: "deep_analysis_quality_cohort_public",
    schemaVersion: 1,
    selectorVersion: DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION,
    asOf: DEEP_ANALYSIS_QUALITY_COHORT_AS_OF,
    population,
    exclusions,
    recovery,
    sourceQuotas: DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS,
    coverageTargets: DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS,
    coverageAvailability,
    coverageCounts: selectedCoverageCounts,
    validationCount: 48,
    sealedCount: 32,
    validation,
    sealed,
    selectionCommitmentSha256,
    externalLlmCalls: 0,
    databaseWriteMode: false,
  };
  const publicManifest: DeepAnalysisQualityPublicManifest = {
    ...publicWithoutHash,
    manifestSha256: sha256Canonical(publicWithoutHash),
  };
  const secretWithoutHash: Omit<DeepAnalysisQualitySecretManifest, "manifestSha256"> = {
    recordType: "deep_analysis_quality_cohort_secret",
    schemaVersion: 1,
    selectorVersion: DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION,
    asOf: DEEP_ANALYSIS_QUALITY_COHORT_AS_OF,
    seed: input.seed,
    publicManifestSha256: publicManifest.manifestSha256,
    population,
    exclusions,
    recovery,
    sourceQuotas: DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS,
    coverageTargets: DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS,
    coverageAvailability,
    coverageCounts: selectedCoverageCounts,
    selected,
    externalLlmCalls: 0,
    databaseWriteMode: false,
  };
  const secretManifest: DeepAnalysisQualitySecretManifest = {
    ...secretWithoutHash,
    manifestSha256: sha256Canonical(secretWithoutHash),
  };
  verifyDeepAnalysisQualityManifestPair(
    publicManifest,
    secretManifest,
    input.expectedReceipt,
  );
  return { publicManifest, secretManifest };
}

export function verifyDeepAnalysisQualityManifestPair(
  publicManifest: DeepAnalysisQualityPublicManifest,
  secretManifest: DeepAnalysisQualitySecretManifest,
  expectedReceipt: DeepAnalysisQualityExpectedReceipt,
): void {
  assertExpectedReceipt(expectedReceipt);
  if (
    publicManifest.recordType !== "deep_analysis_quality_cohort_public"
    || secretManifest.recordType !== "deep_analysis_quality_cohort_secret"
    || publicManifest.schemaVersion !== 1
    || secretManifest.schemaVersion !== 1
    || publicManifest.selectorVersion !== DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION
    || secretManifest.selectorVersion !== DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION
    || publicManifest.asOf !== DEEP_ANALYSIS_QUALITY_COHORT_AS_OF
    || secretManifest.asOf !== DEEP_ANALYSIS_QUALITY_COHORT_AS_OF
  ) {
    throw new Error("Deep analysis quality manifest envelope is invalid.");
  }
  const publicHash = sha256Canonical(manifestHashPayload(publicManifest));
  const secretHash = sha256Canonical(manifestHashPayload(secretManifest));
  if (publicManifest.manifestSha256 !== publicHash) {
    throw new Error("Deep analysis quality public manifest hash verification failed.");
  }
  if (secretManifest.manifestSha256 !== secretHash) {
    throw new Error("Deep analysis quality secret manifest hash verification failed.");
  }
  if (secretManifest.publicManifestSha256 !== publicManifest.manifestSha256) {
    throw new Error("Deep analysis quality manifest pair is not linked.");
  }
  assertCanonicalEqual("population", secretManifest.population, publicManifest.population);
  assertCanonicalEqual("exclusions", secretManifest.exclusions, publicManifest.exclusions);
  assertCanonicalEqual("recovery", secretManifest.recovery, publicManifest.recovery);
  assertCanonicalEqual("source quotas", secretManifest.sourceQuotas, publicManifest.sourceQuotas);
  assertCanonicalEqual(
    "coverage targets",
    secretManifest.coverageTargets,
    publicManifest.coverageTargets,
  );
  assertCanonicalEqual(
    "coverage availability",
    secretManifest.coverageAvailability,
    publicManifest.coverageAvailability,
  );
  assertCanonicalEqual(
    "coverage counts",
    secretManifest.coverageCounts,
    publicManifest.coverageCounts,
  );
  assertCanonicalEqual(
    "frozen source quotas",
    publicManifest.sourceQuotas,
    DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS,
  );
  assertCanonicalEqual(
    "frozen coverage targets",
    publicManifest.coverageTargets,
    DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS,
  );
  assertExpectedReceiptMatches(
    expectedReceipt,
    publicManifest.population,
    publicManifest.exclusions,
    publicManifest.recovery,
  );
  assertSeed(secretManifest.seed);
  if (!Array.isArray(secretManifest.selected) || secretManifest.selected.length !== 80) {
    throw new Error("Deep analysis quality secret manifest must contain exactly 80 grants.");
  }
  assertUniqueKeys(secretManifest.selected, "selected cohort");
  assertCanonicalEqual(
    "secret selection order",
    secretManifest.selected,
    [...secretManifest.selected].sort(compareFullEntries),
  );

  for (const entry of secretManifest.selected) {
    const expectedRank = seededCommitment(secretManifest.seed, "rank", {
      selectorVersion: DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION,
      source: entry.source,
      sourceId: entry.sourceId,
      sourceRevisionSha256: entry.sourceRevisionSha256,
    });
    if (entry.selectorRankSha256 !== expectedRank) {
      throw new Error(`Deep analysis quality selector rank mismatch: ${candidateKey(entry)}`);
    }
    const expectedCommitment = seededCommitment(secretManifest.seed, "sealed-entry", {
      selectorVersion: DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION,
      source: entry.source,
      sourceId: entry.sourceId,
      sourceRevisionSha256: entry.sourceRevisionSha256,
    });
    if (entry.opaqueCommitmentSha256 !== expectedCommitment) {
      throw new Error(`Deep analysis quality opaque commitment mismatch: ${candidateKey(entry)}`);
    }
  }

  for (const source of ["kstartup", "bizinfo"] as const) {
    const quota = DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS[source];
    const sourceEntries = secretManifest.selected.filter((entry) => entry.source === source);
    if (
      sourceEntries.length !== quota.total
      || sourceEntries.filter((entry) => entry.split === "validation").length !== quota.validation
      || sourceEntries.filter((entry) => entry.split === "sealed").length !== quota.sealed
    ) {
      throw new Error(`Deep analysis quality source/split quota mismatch: ${source}`);
    }
  }
  const selectedRecoveryKeys = new Set(
    secretManifest.selected
      .filter((entry) => entry.requiredRecovery)
      .map(candidateKey),
  );
  for (const key of DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS) {
    if (!selectedRecoveryKeys.has(key)) {
      throw new Error(`Deep analysis quality selected cohort misses recovery fixture: ${key}`);
    }
  }

  const selectedCoverageCounts = coverageCounts(secretManifest.selected);
  assertCanonicalEqual(
    "selected coverage counts",
    selectedCoverageCounts,
    publicManifest.coverageCounts,
  );
  assertCoverageTargets(selectedCoverageCounts);

  const validationProjection = secretManifest.selected
    .filter((entry): entry is DeepAnalysisQualityCohortEntry & { split: "validation" } =>
      entry.split === "validation")
    .map(publicValidationProjection)
    .sort(comparePublicValidationEntries);
  if (
    publicManifest.validationCount !== 48
    || !Array.isArray(publicManifest.validation)
    || publicManifest.validation.length !== 48
  ) {
    throw new Error("Deep analysis quality public validation count must be exactly 48.");
  }
  assertCanonicalEqual("public validation projection", publicManifest.validation, validationProjection);

  const sealedProjection = secretManifest.selected
    .filter((entry) => entry.split === "sealed")
    .map(publicSealedProjection)
    .sort(comparePublicSealedEntries);
  if (
    publicManifest.sealedCount !== 32
    || !Array.isArray(publicManifest.sealed)
    || publicManifest.sealed.length !== 32
  ) {
    throw new Error("Deep analysis quality public sealed count must be exactly 32.");
  }
  assertCanonicalEqual("public sealed projection", publicManifest.sealed, sealedProjection);

  const selectionCommitmentSha256 = sha256Canonical(secretManifest.selected.map((entry) => ({
    split: entry.split,
    source: entry.source,
    coverageTags: entry.coverageTags,
    commitment: entry.opaqueCommitmentSha256,
  })));
  if (publicManifest.selectionCommitmentSha256 !== selectionCommitmentSha256) {
    throw new Error("Deep analysis quality selection commitment verification failed.");
  }
  if (publicManifest.externalLlmCalls !== 0 || secretManifest.externalLlmCalls !== 0) {
    throw new Error("Deep analysis quality cohort freeze cannot make external LLM calls.");
  }
  if (publicManifest.databaseWriteMode || secretManifest.databaseWriteMode) {
    throw new Error("Deep analysis quality cohort freeze cannot enable DB writes.");
  }
}

function preparePopulation(
  entries: readonly NormalizedGrant<unknown>[],
  seed: string,
  requiredRecovery: boolean,
): PreparedCandidate[] {
  return entries.flatMap((entry) => {
    if (entry.grant.source !== "kstartup" && entry.grant.source !== "bizinfo") return [];
    return [prepareCandidate(entry, seed, requiredRecovery)];
  }).sort(comparePreparedCandidates);
}

function prepareCandidate(
  entry: NormalizedGrant<unknown>,
  seed: string,
  requiredRecovery: boolean,
): PreparedCandidate {
  const source = entry.grant.source as GrantAnalysisEvaluationSource;
  const sourceId = entry.grant.source_id;
  const key = `${source}:${sourceId}`;
  if (entry.raw.source !== source || entry.raw.source_id !== sourceId) {
    throw new Error(`${key}: raw and normalized source identity mismatch.`);
  }
  const rawPayloadSha256 = hashGrantRawPayload(entry.raw.payload);
  if (
    !isSha256(entry.raw.raw_hash)
    || entry.raw.raw_hash.toLowerCase() !== rawPayloadSha256
  ) {
    throw new Error(`${key}: stored raw hash does not match the canonical payload.`);
  }
  const attachmentSummary = buildGrantAnalysisAttachmentSummary(entry.raw);
  const sourceRevisionSha256 = buildGrantAnalysisSourceRevision({
    source,
    sourceId,
    rawPayloadSha256,
    attachmentSummarySha256: attachmentSummary.attachmentSummarySha256,
  });
  const baselineExclusionCount = entry.criteria.filter(
    (criterion) => criterion.kind === "exclusion",
  ).length;
  const coverageTags = resolveCoverageTags({
    title: entry.grant.title,
    rawPayload: entry.raw.payload,
    attachmentSummary,
    baselineCriteriaCount: entry.criteria.length,
    baselineExclusionCount,
  });
  const selectorIdentity = {
    selectorVersion: DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION,
    source,
    sourceId,
    sourceRevisionSha256,
  };
  return {
    source,
    sourceId,
    canonicalId: entry.grant.id ?? key,
    title: entry.grant.title,
    status: entry.grant.status,
    applyStart: entry.grant.apply_start ?? null,
    applyEnd: entry.grant.apply_end ?? null,
    rawPayloadSha256,
    attachmentSummary,
    sourceRevisionSha256,
    baselineCriteriaCount: entry.criteria.length,
    baselineExclusionCount,
    coverageTags,
    requiredRecovery,
    selectorRankSha256: seededCommitment(seed, "rank", selectorIdentity),
    opaqueCommitmentSha256: seededCommitment(seed, "sealed-entry", selectorIdentity),
  };
}

function resolveCoverageTags(input: {
  title: string;
  rawPayload: unknown;
  attachmentSummary: GrantAnalysisAttachmentSummary;
  baselineCriteriaCount: number;
  baselineExclusionCount: number;
}): DeepAnalysisQualityCoverageTag[] {
  const filenames = input.attachmentSummary.artifacts.map(
    (artifact) => artifact.filename.trim().toLowerCase(),
  );
  const mixedProgramSurface = `${input.title}\n${stableJsonStringify(input.rawPayload)}`;
  const flags: Record<DeepAnalysisQualityCoverageTag, boolean> = {
    hwp_attachment: filenames.some((filename) => filename.endsWith(".hwp")),
    hwpx_attachment: filenames.some((filename) => filename.endsWith(".hwpx")),
    multi_attachment: input.attachmentSummary.expectedCount >= 2,
    complex_document_candidate: (
      input.attachmentSummary.expectedCount >= 3
      || input.attachmentSummary.artifacts.some(
        (artifact) => (artifact.markdownBytes ?? 0) >= 20_000,
      )
    ),
    attachment_only_hard_sentinel_candidate: (
      input.baselineCriteriaCount <= 1
      && input.attachmentSummary.contentBoundLoadableCount > 0
    ),
    exclusion_candidate: input.baselineExclusionCount > 0,
    sparse_condition_candidate: input.baselineCriteriaCount <= 1,
    mixed_program_candidate: (
      /통합\s*공고|세부\s*사업|하위\s*사업|분야별|사업별/.test(mixedProgramSurface)
    ),
  };
  return DEEP_ANALYSIS_QUALITY_COVERAGE_TAGS.filter((tag) => flags[tag]);
}

function selectExactCohort(pool: PreparedCandidate[]): PreparedCandidate[] {
  const selected: PreparedCandidate[] = [];
  const selectedKeys = new Set<string>();
  const sourceCounts: Record<GrantAnalysisEvaluationSource, number> = {
    kstartup: 0,
    bizinfo: 0,
  };
  const add = (entry: PreparedCandidate): boolean => {
    const key = candidateKey(entry);
    if (selectedKeys.has(key)) return false;
    if (sourceCounts[entry.source] >= DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS[entry.source].total) {
      return false;
    }
    selectedKeys.add(key);
    selected.push(entry);
    sourceCounts[entry.source] += 1;
    return true;
  };

  for (const entry of pool.filter((candidate) => candidate.requiredRecovery)) add(entry);
  for (const tag of COVERAGE_SELECTION_ORDER) {
    const target = DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS[tag];
    for (const entry of pool.filter((candidate) => candidate.coverageTags.includes(tag))) {
      if (selected.filter((candidate) => candidate.coverageTags.includes(tag)).length >= target) {
        break;
      }
      add(entry);
    }
  }
  for (const source of ["kstartup", "bizinfo"] as const) {
    for (const entry of pool.filter((candidate) => candidate.source === source)) {
      if (sourceCounts[source] >= DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS[source].total) break;
      add(entry);
    }
  }

  if (
    selected.length !== 80
    || sourceCounts.kstartup !== 40
    || sourceCounts.bizinfo !== 40
  ) {
    throw new Error(
      `Deep analysis quality cohort source quota is infeasible: `
      + `selected=${selected.length}, kstartup=${sourceCounts.kstartup}, `
      + `bizinfo=${sourceCounts.bizinfo}.`,
    );
  }
  assertCoverageTargets(coverageCounts(selected));
  return selected;
}

function assignSplits(selected: PreparedCandidate[]): DeepAnalysisQualityCohortEntry[] {
  const result: DeepAnalysisQualityCohortEntry[] = [];
  for (const source of ["kstartup", "bizinfo"] as const) {
    const sourceEntries = selected
      .filter((entry) => entry.source === source)
      .sort(comparePreparedCandidates);
    const validationCount = DEEP_ANALYSIS_QUALITY_SOURCE_QUOTAS[source].validation;
    for (const [index, entry] of sourceEntries.entries()) {
      result.push({
        ...entry,
        split: index < validationCount ? "validation" : "sealed",
      });
    }
  }
  return result.sort(compareFullEntries);
}

function coverageCounts(
  entries: readonly Pick<PreparedCandidate, "coverageTags">[],
): Record<DeepAnalysisQualityCoverageTag, number> {
  return Object.fromEntries(DEEP_ANALYSIS_QUALITY_COVERAGE_TAGS.map((tag) => [
    tag,
    entries.filter((entry) => entry.coverageTags.includes(tag)).length,
  ])) as Record<DeepAnalysisQualityCoverageTag, number>;
}

function assertCoverageTargets(
  counts: Readonly<Record<DeepAnalysisQualityCoverageTag, number>>,
): void {
  for (const tag of DEEP_ANALYSIS_QUALITY_COVERAGE_TAGS) {
    const target = DEEP_ANALYSIS_QUALITY_COVERAGE_TARGETS[tag];
    if (counts[tag] < target) {
      throw new Error(
        `Deep analysis quality coverage target is infeasible for ${tag}: `
        + `need ${target}, selected ${counts[tag]}.`,
      );
    }
  }
}

function populationAudit(
  canonical: PreparedCandidate[],
  duplicateInclusive: PreparedCandidate[],
): DeepAnalysisQualityPopulationAudit {
  return {
    activeCanonicalCount: canonical.length,
    activeDuplicateInclusiveCount: duplicateInclusive.length,
    activeCanonicalSha256: sha256Canonical(canonical.map(populationFingerprint)),
    activeDuplicateInclusiveSha256: sha256Canonical(
      duplicateInclusive.map(populationFingerprint),
    ),
  };
}

function populationFingerprint(entry: PreparedCandidate): Record<string, unknown> {
  return {
    source: entry.source,
    sourceId: entry.sourceId,
    canonicalId: entry.canonicalId,
    status: entry.status,
    applyStart: entry.applyStart,
    applyEnd: entry.applyEnd,
    rawPayloadSha256: entry.rawPayloadSha256,
    attachmentSummarySha256: entry.attachmentSummary.attachmentSummarySha256,
    sourceRevisionSha256: entry.sourceRevisionSha256,
    baselineCriteriaCount: entry.baselineCriteriaCount,
    baselineExclusionCount: entry.baselineExclusionCount,
    coverageTags: entry.coverageTags,
  };
}

function exclusionAudit(
  excludedActive: PreparedCandidate[],
): DeepAnalysisQualityExclusionAudit {
  return {
    configuredPreviousEvaluationKeyCount: PREVIOUS_EVALUATION_KEYS.size,
    excludedActivePreviousEvaluationCount: excludedActive.length,
    exclusionSha256: sha256Canonical({
      selectorVersion: DEEP_ANALYSIS_QUALITY_COHORT_SELECTOR_VERSION,
      configuredKeys: [...PREVIOUS_EVALUATION_KEYS].sort(compareText),
      excludedActive: excludedActive.map(populationFingerprint),
    }),
  };
}

function recoveryAudit(
  recoveryEntries: PreparedCandidate[],
  historicalRecoveryCount: number,
): DeepAnalysisQualityRecoveryAudit {
  return {
    requiredRecoveryCount: recoveryEntries.length,
    historicalRecoveryCount,
    recoveryCommitmentSha256: sha256Canonical(
      recoveryEntries.map((entry) => ({
        key: candidateKey(entry),
        sourceRevisionSha256: entry.sourceRevisionSha256,
      })),
    ),
  };
}

function publicValidationProjection(
  entry: DeepAnalysisQualityCohortEntry & { split: "validation" },
): DeepAnalysisQualityPublicValidationEntry {
  const {
    selectorRankSha256: _selectorRankSha256,
    opaqueCommitmentSha256: _opaqueCommitmentSha256,
    ...publicEntry
  } = entry;
  return publicEntry;
}

function publicSealedProjection(
  entry: DeepAnalysisQualityCohortEntry,
): DeepAnalysisQualityPublicSealedEntry {
  return {
    source: entry.source,
    split: "sealed",
    coverageTags: entry.coverageTags,
    opaqueCommitmentSha256: entry.opaqueCommitmentSha256,
  };
}

function assertExpectedReceipt(receipt: DeepAnalysisQualityExpectedReceipt): void {
  for (const [key, value] of Object.entries(receipt)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Deep analysis quality expected receipt ${key} must be non-negative.`);
    }
  }
}

function assertExpectedReceiptMatches(
  expected: DeepAnalysisQualityExpectedReceipt,
  population: DeepAnalysisQualityPopulationAudit,
  exclusions: DeepAnalysisQualityExclusionAudit,
  recovery: DeepAnalysisQualityRecoveryAudit,
): void {
  const actual: DeepAnalysisQualityExpectedReceipt = {
    activeCanonicalCount: population.activeCanonicalCount,
    activeDuplicateInclusiveCount: population.activeDuplicateInclusiveCount,
    configuredPreviousEvaluationKeyCount: exclusions.configuredPreviousEvaluationKeyCount,
    excludedActivePreviousEvaluationCount: exclusions.excludedActivePreviousEvaluationCount,
    requiredRecoveryCount: recovery.requiredRecoveryCount,
    historicalRecoveryCount: recovery.historicalRecoveryCount,
  };
  assertCanonicalEqual("expected receipt", actual, expected);
}

function assertUniqueKeys(
  entries: readonly Pick<PreparedCandidate, "source" | "sourceId">[],
  label: string,
): void {
  const keys = entries.map(candidateKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Deep analysis quality ${label} contains duplicate grant keys.`);
  }
}

function candidateKey(entry: {
  source: GrantAnalysisEvaluationSource;
  sourceId: string;
}): string {
  return `${entry.source}:${entry.sourceId}`;
}

function comparePreparedCandidates(
  left: PreparedCandidate,
  right: PreparedCandidate,
): number {
  return compareText(left.selectorRankSha256, right.selectorRankSha256)
    || compareText(candidateKey(left), candidateKey(right));
}

function compareFullEntries(
  left: DeepAnalysisQualityCohortEntry,
  right: DeepAnalysisQualityCohortEntry,
): number {
  return compareText(left.source, right.source)
    || compareText(left.split, right.split)
    || compareText(left.selectorRankSha256, right.selectorRankSha256)
    || compareText(candidateKey(left), candidateKey(right));
}

function comparePublicValidationEntries(
  left: DeepAnalysisQualityPublicValidationEntry,
  right: DeepAnalysisQualityPublicValidationEntry,
): number {
  return compareText(left.source, right.source)
    || compareText(candidateKey(left), candidateKey(right));
}

function comparePublicSealedEntries(
  left: DeepAnalysisQualityPublicSealedEntry,
  right: DeepAnalysisQualityPublicSealedEntry,
): number {
  return compareText(left.source, right.source)
    || compareText(left.opaqueCommitmentSha256, right.opaqueCommitmentSha256);
}

function seededCommitment(seed: string, domain: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${seed}\0${stableJsonStringify(payload)}`)
    .digest("hex");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function manifestHashPayload<T extends { manifestSha256: string }>(
  manifest: T,
): Omit<T, "manifestSha256"> {
  const { manifestSha256: _manifestSha256, ...payload } = manifest;
  return payload;
}

function assertCanonicalEqual(label: string, actual: unknown, expected: unknown): void {
  if (stableJsonStringify(actual) !== stableJsonStringify(expected)) {
    throw new Error(`Deep analysis quality ${label} mismatch.`);
  }
}

function assertSeed(seed: string): void {
  if (!/^[0-9a-f]{64}$/i.test(seed)) {
    throw new Error("Deep analysis quality cohort seed must be 64 hexadecimal characters.");
  }
}

function isSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
