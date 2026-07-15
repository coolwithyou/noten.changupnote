import { createHash } from "node:crypto";
import type { GrantRaw, NormalizedGrant } from "@cunote/contracts";
import {
  buildBizInfoProgramExtractionInput,
  type BizInfoProgram,
  type KStartupAnnouncement,
} from "@cunote/core";
import { FROZEN_GRANT_ANALYSIS_PILOT_COHORT } from "./grantAnalysisPilotCohort";
import { hashGrantRawPayload, stableJsonStringify } from "./grantRawHash";

export const GRANT_ANALYSIS_EVALUATION_AS_OF = "2026-07-15T00:00:00+09:00";
export const GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION =
  "grant-analysis-evaluation-cohort-v1";
export const GRANT_ANALYSIS_ATTACHMENT_SUMMARY_VERSION =
  "grant-analysis-attachment-summary-v1";
export const GRANT_ANALYSIS_SOURCE_REVISION_VERSION =
  "grant-analysis-source-revision-v1";

export const GRANT_ANALYSIS_EVALUATION_STRATA = [
  "sparse_attachment_unavailable",
  "sparse_attachment_loadable",
  "baseline_density_mid",
  "baseline_density_high_control",
] as const;

export type GrantAnalysisEvaluationSource = "kstartup" | "bizinfo";
export type GrantAnalysisEvaluationStratum =
  (typeof GRANT_ANALYSIS_EVALUATION_STRATA)[number];
export type GrantAnalysisEvaluationSplit = "validation" | "sealed";

export interface GrantAnalysisEvaluationQuota {
  validation: number;
  sealed: number;
}

export const GRANT_ANALYSIS_EVALUATION_QUOTAS: Readonly<
  Record<GrantAnalysisEvaluationStratum, GrantAnalysisEvaluationQuota>
> = {
  sparse_attachment_unavailable: { validation: 5, sealed: 3 },
  sparse_attachment_loadable: { validation: 2, sealed: 2 },
  baseline_density_mid: { validation: 3, sealed: 1 },
  baseline_density_high_control: { validation: 2, sealed: 2 },
};

export const GRANT_ANALYSIS_EVALUATION_SOURCE_QUOTAS = {
  kstartup: GRANT_ANALYSIS_EVALUATION_QUOTAS,
  bizinfo: GRANT_ANALYSIS_EVALUATION_QUOTAS,
} as const;

type Attachment = NonNullable<GrantRaw["attachments"]>[number];

export interface GrantAnalysisAttachmentArtifactCommitment {
  artifactCommitmentSha256: string;
  filename: string;
  contentType: string | null;
  bytes: number | null;
  sourceLocatorPresent: boolean;
  archiveUrlPresent: boolean;
  archiveLocatorPresent: boolean;
  archiveLocatorValid: boolean;
  archiveSha256: string | null;
  conversionStatus: "converted" | "skipped" | "failed" | null;
  markdownUrlPresent: boolean;
  markdownLocatorPresent: boolean;
  markdownLocatorValid: boolean;
  markdownSha256: string | null;
  markdownBytes: number | null;
  converter: string | null;
  ocrProvider: string | null;
  ocrConfidence: number | null;
  contentBoundLoadable: boolean;
}

export interface GrantAnalysisAttachmentSummary {
  schemaVersion: typeof GRANT_ANALYSIS_ATTACHMENT_SUMMARY_VERSION;
  declaredKnown: boolean;
  declaredCount: number;
  presentCount: number;
  expectedCount: number;
  inventoryIncomplete: boolean;
  stableArchiveCount: number;
  convertedCount: number;
  contentBoundLoadableCount: number;
  skippedCount: number;
  failedCount: number;
  artifacts: GrantAnalysisAttachmentArtifactCommitment[];
  attachmentSummarySha256: string;
}

export interface GrantAnalysisEvaluationFullEntry {
  source: GrantAnalysisEvaluationSource;
  sourceId: string;
  canonicalId: string;
  title: string;
  status: NormalizedGrant["grant"]["status"];
  applyStart: string | null;
  applyEnd: string | null;
  rawPayloadSha256: string;
  attachmentSummary: GrantAnalysisAttachmentSummary;
  sourceRevision: string;
  baselineCriteriaCount: number;
  stratum: GrantAnalysisEvaluationStratum;
  split: GrantAnalysisEvaluationSplit;
  selectorRankSha256: string;
  opaqueCommitmentSha256: string;
}

export interface GrantAnalysisEvaluationPublicValidationEntry
  extends Omit<
    GrantAnalysisEvaluationFullEntry,
    "opaqueCommitmentSha256" | "selectorRankSha256"
  > {
  split: "validation";
}

export interface GrantAnalysisEvaluationPublicSealedEntry {
  split: "sealed";
  source: GrantAnalysisEvaluationSource;
  stratum: GrantAnalysisEvaluationStratum;
  opaqueCommitmentSha256: string;
}

export type GrantAnalysisAvailabilityCounts = Record<
  GrantAnalysisEvaluationSource,
  Record<GrantAnalysisEvaluationStratum, number>
>;

export interface GrantAnalysisEvaluationPopulationAudit {
  canonicalCount: number;
  duplicateInclusiveCount: number;
  canonicalSha256: string;
  duplicateInclusiveSha256: string;
}

export interface GrantAnalysisEvaluationExclusionAudit {
  configuredLegacyKeyCount: number;
  excludedCanonicalCount: number;
  exclusionSha256: string;
}

export interface GrantAnalysisEvaluationPublicManifest {
  recordType: "grant_analysis_evaluation_cohort_public";
  schemaVersion: 1;
  selectorVersion: typeof GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION;
  asOf: typeof GRANT_ANALYSIS_EVALUATION_AS_OF;
  population: GrantAnalysisEvaluationPopulationAudit;
  exclusions: GrantAnalysisEvaluationExclusionAudit;
  quotas: typeof GRANT_ANALYSIS_EVALUATION_SOURCE_QUOTAS;
  quotaSha256: string;
  availability: GrantAnalysisAvailabilityCounts;
  availabilitySha256: string;
  validationCount: 24;
  sealedCount: 16;
  validation: GrantAnalysisEvaluationPublicValidationEntry[];
  sealed: GrantAnalysisEvaluationPublicSealedEntry[];
  selectionCommitmentSha256: string;
  externalLlmCalls: 0;
  databaseWriteMode: false;
  manifestSha256: string;
}

export interface GrantAnalysisEvaluationSecretManifest {
  recordType: "grant_analysis_evaluation_cohort_secret";
  schemaVersion: 1;
  selectorVersion: typeof GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION;
  asOf: typeof GRANT_ANALYSIS_EVALUATION_AS_OF;
  seed: string;
  publicManifestSha256: string;
  population: GrantAnalysisEvaluationPopulationAudit;
  exclusions: GrantAnalysisEvaluationExclusionAudit;
  quotas: typeof GRANT_ANALYSIS_EVALUATION_SOURCE_QUOTAS;
  quotaSha256: string;
  availability: GrantAnalysisAvailabilityCounts;
  availabilitySha256: string;
  selected: GrantAnalysisEvaluationFullEntry[];
  externalLlmCalls: 0;
  databaseWriteMode: false;
  manifestSha256: string;
}

export interface GrantAnalysisEvaluationCohortSelection {
  publicManifest: GrantAnalysisEvaluationPublicManifest;
  secretManifest: GrantAnalysisEvaluationSecretManifest;
}

export interface GrantAnalysisEvaluationExpectedReceipt {
  canonicalCount: number;
  duplicateInclusiveCount: number;
  configuredLegacyKeyCount: number;
  excludedCanonicalCount: number;
}

interface PreparedCandidate extends Omit<GrantAnalysisEvaluationFullEntry, "split"> {}

interface PopulationFingerprint {
  source: GrantAnalysisEvaluationSource;
  sourceId: string;
  canonicalId: string;
  status: NormalizedGrant["grant"]["status"];
  applyStart: string | null;
  applyEnd: string | null;
  rawPayloadSha256: string;
  attachmentSummarySha256: string;
  sourceRevision: string;
  baselineCriteriaCount: number;
  stratum: GrantAnalysisEvaluationStratum;
}

const LEGACY_KEYS = new Set(
  FROZEN_GRANT_ANALYSIS_PILOT_COHORT.map((entry) => `${entry.source}:${entry.sourceId}`),
);

export function selectGrantAnalysisEvaluationCohort(options: {
  entries: readonly NormalizedGrant<unknown>[];
  duplicateInclusiveEntries: readonly NormalizedGrant<unknown>[];
  expectedReceipt: GrantAnalysisEvaluationExpectedReceipt;
  seed: string;
  asOf?: string;
}): GrantAnalysisEvaluationCohortSelection {
  const asOf = options.asOf ?? GRANT_ANALYSIS_EVALUATION_AS_OF;
  if (asOf !== GRANT_ANALYSIS_EVALUATION_AS_OF) {
    throw new Error(`Evaluation cohort asOf must be ${GRANT_ANALYSIS_EVALUATION_AS_OF}.`);
  }
  assertSeed(options.seed);
  if (!Array.isArray(options.duplicateInclusiveEntries)) {
    throw new Error("Evaluation cohort duplicate-inclusive population is required.");
  }
  assertExpectedReceipt(options.expectedReceipt);

  const canonical = preparePopulation(options.entries, options.seed, asOf, true);
  const duplicateInclusive = preparePopulation(
    options.duplicateInclusiveEntries,
    options.seed,
    asOf,
    false,
  );
  const population = populationAudit(canonical, duplicateInclusive);
  const excluded = canonical.filter((candidate) => LEGACY_KEYS.has(candidateKey(candidate)));
  const eligible = canonical.filter((candidate) => !LEGACY_KEYS.has(candidateKey(candidate)));
  const exclusions = exclusionAudit(excluded);
  assertExpectedReceiptMatches(options.expectedReceipt, population, exclusions);
  const availability = availabilityCounts(eligible);
  const quotaSha256 = sha256Canonical({
    selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
    quotas: GRANT_ANALYSIS_EVALUATION_SOURCE_QUOTAS,
  });
  const availabilitySha256 = sha256Canonical({
    selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
    availability,
  });
  const selected = selectExactQuotas(eligible);
  const validation = selected
    .filter((entry): entry is GrantAnalysisEvaluationFullEntry & { split: "validation" } =>
      entry.split === "validation")
    .map(publicValidationProjection)
    .sort(comparePublicValidationEntries);
  const sealed = selected
    .filter((entry) => entry.split === "sealed")
    .map(publicSealedProjection)
    .sort(comparePublicSealedEntries);

  if (validation.length !== 24 || sealed.length !== 16 || selected.length !== 40) {
    throw new Error("Evaluation cohort selector produced an invalid 24/16 split.");
  }

  const selectionCommitmentSha256 = sha256Canonical(selected.map((entry) => ({
    split: entry.split,
    source: entry.source,
    stratum: entry.stratum,
    commitment: entry.opaqueCommitmentSha256,
  })));
  const publicWithoutHash: Omit<GrantAnalysisEvaluationPublicManifest, "manifestSha256"> = {
    recordType: "grant_analysis_evaluation_cohort_public" as const,
    schemaVersion: 1 as const,
    selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
    asOf: GRANT_ANALYSIS_EVALUATION_AS_OF,
    population,
    exclusions,
    quotas: GRANT_ANALYSIS_EVALUATION_SOURCE_QUOTAS,
    quotaSha256,
    availability,
    availabilitySha256,
    validationCount: 24 as const,
    sealedCount: 16 as const,
    validation,
    sealed,
    selectionCommitmentSha256,
    externalLlmCalls: 0 as const,
    databaseWriteMode: false as const,
  };
  const publicManifest: GrantAnalysisEvaluationPublicManifest = {
    ...publicWithoutHash,
    manifestSha256: sha256Canonical(publicWithoutHash),
  };
  const secretWithoutHash: Omit<GrantAnalysisEvaluationSecretManifest, "manifestSha256"> = {
    recordType: "grant_analysis_evaluation_cohort_secret" as const,
    schemaVersion: 1 as const,
    selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
    asOf: GRANT_ANALYSIS_EVALUATION_AS_OF,
    seed: options.seed,
    publicManifestSha256: publicManifest.manifestSha256,
    population,
    exclusions,
    quotas: GRANT_ANALYSIS_EVALUATION_SOURCE_QUOTAS,
    quotaSha256,
    availability,
    availabilitySha256,
    selected,
    externalLlmCalls: 0 as const,
    databaseWriteMode: false as const,
  };
  const secretManifest: GrantAnalysisEvaluationSecretManifest = {
    ...secretWithoutHash,
    manifestSha256: sha256Canonical(secretWithoutHash),
  };
  verifyGrantAnalysisEvaluationManifestPair(
    publicManifest,
    secretManifest,
    options.expectedReceipt,
  );
  return { publicManifest, secretManifest };
}

/**
 * Commits attachment content and source-declared inventory without persisting
 * URL or storage-locator values, timestamps, or errors. Presence/validity flags
 * remain committed. The API payload itself is hashed separately in full, so
 * every API payload mutation (including a payload URL change) changes the
 * source revision.
 */
export function buildGrantAnalysisAttachmentSummary(
  raw: Pick<GrantRaw, "source" | "payload" | "attachments">,
): GrantAnalysisAttachmentSummary {
  const declared = sourceDeclaredAttachmentInventory(raw);
  const artifacts = (raw.attachments ?? [])
    .map(normalizeAttachment)
    .sort((left, right) => compareText(
      stableJsonStringify(artifactHashPayload(left)),
      stableJsonStringify(artifactHashPayload(right)),
    ));
  const summaryPayload: Omit<GrantAnalysisAttachmentSummary, "attachmentSummarySha256"> = {
    schemaVersion: GRANT_ANALYSIS_ATTACHMENT_SUMMARY_VERSION,
    declaredKnown: declared.known,
    declaredCount: declared.count,
    presentCount: artifacts.length,
    expectedCount: Math.max(declared.count, artifacts.length),
    inventoryIncomplete: declared.count > artifacts.length,
    stableArchiveCount: artifacts.filter((artifact) =>
      artifact.archiveLocatorValid && isSha256(artifact.archiveSha256)).length,
    convertedCount: artifacts.filter((artifact) => artifact.conversionStatus === "converted").length,
    contentBoundLoadableCount: artifacts.filter((artifact) => artifact.contentBoundLoadable).length,
    skippedCount: artifacts.filter((artifact) => artifact.conversionStatus === "skipped").length,
    failedCount: artifacts.filter((artifact) => artifact.conversionStatus === "failed").length,
    artifacts,
  };
  return {
    ...summaryPayload,
    attachmentSummarySha256: sha256Canonical({
      ...summaryPayload,
      artifacts: artifacts.map(artifactHashPayload),
    }),
  };
}

export function buildGrantAnalysisSourceRevision(input: {
  source: GrantAnalysisEvaluationSource;
  sourceId: string;
  rawPayloadSha256: string;
  attachmentSummarySha256: string;
}): string {
  return sha256Canonical({
    version: GRANT_ANALYSIS_SOURCE_REVISION_VERSION,
    source: input.source,
    sourceId: input.sourceId,
    rawPayloadSha256: input.rawPayloadSha256,
    attachmentSummarySha256: input.attachmentSummarySha256,
  });
}

export function grantAnalysisEvaluationKey(entry: {
  source: GrantAnalysisEvaluationSource;
  sourceId: string;
}): string {
  return `${entry.source}:${entry.sourceId}`;
}

/**
 * Verifies a parsed public/secret pair without I/O or ambient state. Callers
 * must provide the frozen population receipt that authorized the selection.
 */
export function verifyGrantAnalysisEvaluationManifestPair(
  publicManifest: GrantAnalysisEvaluationPublicManifest,
  secretManifest: GrantAnalysisEvaluationSecretManifest,
  expectedReceipt: GrantAnalysisEvaluationExpectedReceipt,
): void {
  assertExpectedReceipt(expectedReceipt);
  assertManifestEnvelope(publicManifest, secretManifest);

  const publicHash = sha256Canonical(manifestHashPayload(publicManifest));
  if (!isSha256(publicManifest.manifestSha256) || publicManifest.manifestSha256 !== publicHash) {
    throw new Error("Evaluation public manifest hash verification failed.");
  }
  const secretHash = sha256Canonical(manifestHashPayload(secretManifest));
  if (!isSha256(secretManifest.manifestSha256) || secretManifest.manifestSha256 !== secretHash) {
    throw new Error("Evaluation secret manifest hash verification failed.");
  }
  if (secretManifest.publicManifestSha256 !== publicManifest.manifestSha256) {
    throw new Error("Evaluation secret manifest is not linked to the public manifest.");
  }

  assertCanonicalEqual("population audit", secretManifest.population, publicManifest.population);
  assertCanonicalEqual("exclusion audit", secretManifest.exclusions, publicManifest.exclusions);
  assertCanonicalEqual("quota contract", secretManifest.quotas, publicManifest.quotas);
  assertCanonicalEqual("availability audit", secretManifest.availability, publicManifest.availability);
  if (secretManifest.quotaSha256 !== publicManifest.quotaSha256 ||
    secretManifest.availabilitySha256 !== publicManifest.availabilitySha256) {
    throw new Error("Evaluation public and secret audit hashes do not match.");
  }
  assertExpectedReceiptMatches(
    expectedReceipt,
    publicManifest.population,
    publicManifest.exclusions,
  );
  assertCanonicalEqual(
    "frozen quotas",
    publicManifest.quotas,
    GRANT_ANALYSIS_EVALUATION_SOURCE_QUOTAS,
  );
  const expectedQuotaSha256 = sha256Canonical({
    selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
    quotas: GRANT_ANALYSIS_EVALUATION_SOURCE_QUOTAS,
  });
  if (publicManifest.quotaSha256 !== expectedQuotaSha256) {
    throw new Error("Evaluation quota commitment verification failed.");
  }
  const expectedAvailabilitySha256 = sha256Canonical({
    selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
    availability: publicManifest.availability,
  });
  if (publicManifest.availabilitySha256 !== expectedAvailabilitySha256) {
    throw new Error("Evaluation availability commitment verification failed.");
  }

  assertSeed(secretManifest.seed);
  if (!Array.isArray(secretManifest.selected) || secretManifest.selected.length !== 40) {
    throw new Error("Evaluation secret manifest must contain exactly 40 selected entries.");
  }
  const selectedKeys = new Set(secretManifest.selected.map(candidateKey));
  if (selectedKeys.size !== secretManifest.selected.length) {
    throw new Error("Evaluation secret manifest contains duplicate selected entries.");
  }
  assertCanonicalEqual(
    "secret selection order",
    secretManifest.selected,
    [...secretManifest.selected].sort(compareFullEntries),
  );
  for (const entry of secretManifest.selected) {
    const expectedRank = seededCommitment(secretManifest.seed, "rank", {
      selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
      source: entry.source,
      sourceId: entry.sourceId,
      sourceRevision: entry.sourceRevision,
    });
    if (entry.selectorRankSha256 !== expectedRank) {
      throw new Error(`Evaluation selector rank verification failed for ${candidateKey(entry)}.`);
    }
    const expectedOpaqueCommitment = seededCommitment(secretManifest.seed, "sealed-entry", {
      selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
      source: entry.source,
      sourceId: entry.sourceId,
      sourceRevision: entry.sourceRevision,
    });
    if (entry.opaqueCommitmentSha256 !== expectedOpaqueCommitment) {
      throw new Error(`Evaluation opaque commitment verification failed for ${candidateKey(entry)}.`);
    }
  }

  for (const source of ["kstartup", "bizinfo"] as const) {
    for (const stratum of GRANT_ANALYSIS_EVALUATION_STRATA) {
      const quota = GRANT_ANALYSIS_EVALUATION_QUOTAS[stratum];
      const validationCount = selectedCount(secretManifest.selected, source, stratum, "validation");
      const sealedCount = selectedCount(secretManifest.selected, source, stratum, "sealed");
      if (validationCount !== quota.validation || sealedCount !== quota.sealed) {
        throw new Error(`Evaluation selected quota mismatch for ${source}/${stratum}.`);
      }
    }
  }

  const validationProjection = secretManifest.selected
    .filter((entry): entry is GrantAnalysisEvaluationFullEntry & { split: "validation" } =>
      entry.split === "validation")
    .map(publicValidationProjection)
    .sort(comparePublicValidationEntries);
  if (publicManifest.validationCount !== 24 || !Array.isArray(publicManifest.validation) ||
    publicManifest.validation.length !== 24) {
    throw new Error("Evaluation public validation count must be exactly 24.");
  }
  assertCanonicalEqual("public validation projection", publicManifest.validation, validationProjection);

  const sealedProjection = secretManifest.selected
    .filter((entry) => entry.split === "sealed")
    .map(publicSealedProjection)
    .sort(comparePublicSealedEntries);
  if (publicManifest.sealedCount !== 16 || !Array.isArray(publicManifest.sealed) ||
    publicManifest.sealed.length !== 16) {
    throw new Error("Evaluation public sealed count must be exactly 16.");
  }
  assertCanonicalEqual("public sealed commitment projection", publicManifest.sealed, sealedProjection);

  const selectionCommitmentSha256 = sha256Canonical(secretManifest.selected.map((entry) => ({
    split: entry.split,
    source: entry.source,
    stratum: entry.stratum,
    commitment: entry.opaqueCommitmentSha256,
  })));
  if (publicManifest.selectionCommitmentSha256 !== selectionCommitmentSha256) {
    throw new Error("Evaluation selection commitment verification failed.");
  }
}

function preparePopulation(
  entries: readonly NormalizedGrant<unknown>[],
  seed: string,
  asOf: string,
  requireUniqueKeys: boolean,
): PreparedCandidate[] {
  const prepared = entries.flatMap((entry) => {
    if (entry.grant.source !== "kstartup" && entry.grant.source !== "bizinfo") return [];
    if (!isStructurallyActive(entry, asOf)) return [];
    return [prepareCandidate(entry, seed)];
  });
  if (requireUniqueKeys) {
    const seen = new Set<string>();
    for (const entry of prepared) {
      const key = candidateKey(entry);
      if (seen.has(key)) throw new Error(`Duplicate canonical evaluation candidate: ${key}`);
      seen.add(key);
    }
  }
  return prepared.sort(comparePreparedCandidates);
}

function prepareCandidate(entry: NormalizedGrant<unknown>, seed: string): PreparedCandidate {
  const source = entry.grant.source as GrantAnalysisEvaluationSource;
  const sourceId = entry.grant.source_id;
  const key = `${source}:${sourceId}`;
  if (entry.raw.source !== source || entry.raw.source_id !== sourceId) {
    throw new Error(`${key}: raw and normalized source identity mismatch.`);
  }
  const rawPayloadSha256 = hashGrantRawPayload(entry.raw.payload);
  const storedRawHash = entry.raw.raw_hash ?? null;
  if (!isSha256(storedRawHash)) {
    throw new Error(`${key}: stored raw_hash must be present as 64 hexadecimal characters.`);
  }
  if (storedRawHash.toLowerCase() !== rawPayloadSha256) {
    throw new Error(`${key}: stored raw_hash does not match the canonical raw payload hash.`);
  }
  const attachmentSummary = buildGrantAnalysisAttachmentSummary(entry.raw);
  const sourceRevision = buildGrantAnalysisSourceRevision({
    source,
    sourceId,
    rawPayloadSha256,
    attachmentSummarySha256: attachmentSummary.attachmentSummarySha256,
  });
  const baselineCriteriaCount = entry.criteria.length;
  const stratum = resolveStratum(baselineCriteriaCount, attachmentSummary);
  const selectorRankSha256 = seededCommitment(seed, "rank", {
    selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
    source,
    sourceId,
    sourceRevision,
  });
  const opaqueCommitmentSha256 = seededCommitment(seed, "sealed-entry", {
    selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
    source,
    sourceId,
    sourceRevision,
  });
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
    sourceRevision,
    baselineCriteriaCount,
    stratum,
    selectorRankSha256,
    opaqueCommitmentSha256,
  };
}

function normalizeAttachment(attachment: Attachment): GrantAnalysisAttachmentArtifactCommitment {
  const conversionStatus = attachment.conversion?.status ?? null;
  const archiveLocatorPresent = hasNonEmptyString(attachment.storage_key);
  const archiveLocatorValid = validRelativeObjectKey(attachment.storage_key);
  const markdownLocatorPresent = hasNonEmptyString(attachment.conversion?.markdown_storage_key);
  const markdownLocatorValid = validRelativeObjectKey(attachment.conversion?.markdown_storage_key);
  const archiveSha256 = normalizedHashField(attachment.sha256);
  const markdownSha256 = normalizedHashField(attachment.conversion?.markdown_sha256);
  const payload = {
    filename: String(attachment.filename ?? ""),
    contentType: cleanOptionalString(attachment.content_type),
    bytes: finiteNonNegativeInteger(attachment.bytes),
    sourceLocatorPresent: hasNonEmptyString(attachment.source_uri) || hasNonEmptyString(attachment.url),
    archiveUrlPresent: hasNonEmptyString(attachment.archive_url),
    archiveLocatorPresent,
    archiveLocatorValid,
    archiveSha256,
    conversionStatus,
    markdownUrlPresent: hasNonEmptyString(attachment.conversion?.markdown_url),
    markdownLocatorPresent,
    markdownLocatorValid,
    markdownSha256,
    markdownBytes: finiteNonNegativeInteger(attachment.conversion?.markdown_bytes),
    converter: cleanOptionalString(attachment.conversion?.converter),
    ocrProvider: cleanOptionalString(attachment.conversion?.ocr_provider),
    ocrConfidence: finiteNumber(attachment.conversion?.ocr_confidence),
    contentBoundLoadable: archiveLocatorValid && isSha256(archiveSha256) &&
      conversionStatus === "converted" && markdownLocatorValid && isSha256(markdownSha256),
  };
  return {
    artifactCommitmentSha256: sha256Canonical(payload),
    ...payload,
  };
}

function artifactHashPayload(artifact: GrantAnalysisAttachmentArtifactCommitment) {
  const { artifactCommitmentSha256: _derived, ...payload } = artifact;
  return payload;
}

function sourceDeclaredAttachmentInventory(
  raw: Pick<GrantRaw, "source" | "payload">,
): { known: boolean; count: number } {
  if (raw.source === "kstartup") {
    const detail = (raw.payload as KStartupAnnouncement).detail;
    return { known: Boolean(detail), count: detail?.attachments.length ?? 0 };
  }
  if (raw.source === "bizinfo") {
    const input = buildBizInfoProgramExtractionInput(raw.payload as BizInfoProgram);
    return { known: true, count: input.metadata.attachments.length };
  }
  throw new Error(`Unsupported grant analysis attachment source: ${raw.source}`);
}

function resolveStratum(
  baselineCriteriaCount: number,
  attachmentSummary: GrantAnalysisAttachmentSummary,
): GrantAnalysisEvaluationStratum {
  if (!Number.isInteger(baselineCriteriaCount) || baselineCriteriaCount < 0) {
    throw new Error("Baseline criteria count must be a non-negative integer.");
  }
  if (baselineCriteriaCount <= 1) {
    return attachmentSummary.contentBoundLoadableCount > 0
      ? "sparse_attachment_loadable"
      : "sparse_attachment_unavailable";
  }
  return baselineCriteriaCount <= 5
    ? "baseline_density_mid"
    : "baseline_density_high_control";
}

function selectExactQuotas(candidates: PreparedCandidate[]): GrantAnalysisEvaluationFullEntry[] {
  const selected: GrantAnalysisEvaluationFullEntry[] = [];
  for (const source of ["kstartup", "bizinfo"] as const) {
    for (const stratum of GRANT_ANALYSIS_EVALUATION_STRATA) {
      const quota = GRANT_ANALYSIS_EVALUATION_QUOTAS[stratum];
      const available = candidates
        .filter((candidate) => candidate.source === source && candidate.stratum === stratum)
        .sort(comparePreparedCandidates);
      const needed = quota.validation + quota.sealed;
      if (available.length < needed) {
        throw new Error(
          `Infeasible evaluation cohort quota for ${source}/${stratum}: need ${needed}, found ${available.length}.`,
        );
      }
      for (const [index, candidate] of available.slice(0, needed).entries()) {
        selected.push({
          ...candidate,
          split: index < quota.validation ? "validation" : "sealed",
        });
      }
    }
  }
  return selected.sort(compareFullEntries);
}

function populationAudit(
  canonical: PreparedCandidate[],
  duplicateInclusive: PreparedCandidate[],
): GrantAnalysisEvaluationPopulationAudit {
  return {
    canonicalCount: canonical.length,
    duplicateInclusiveCount: duplicateInclusive.length,
    canonicalSha256: sha256Canonical(canonical.map(populationFingerprint)),
    duplicateInclusiveSha256: sha256Canonical(duplicateInclusive.map(populationFingerprint)),
  };
}

function populationFingerprint(candidate: PreparedCandidate): PopulationFingerprint {
  return {
    source: candidate.source,
    sourceId: candidate.sourceId,
    canonicalId: candidate.canonicalId,
    status: candidate.status,
    applyStart: candidate.applyStart,
    applyEnd: candidate.applyEnd,
    rawPayloadSha256: candidate.rawPayloadSha256,
    attachmentSummarySha256: candidate.attachmentSummary.attachmentSummarySha256,
    sourceRevision: candidate.sourceRevision,
    baselineCriteriaCount: candidate.baselineCriteriaCount,
    stratum: candidate.stratum,
  };
}

function exclusionAudit(excluded: PreparedCandidate[]): GrantAnalysisEvaluationExclusionAudit {
  return {
    configuredLegacyKeyCount: LEGACY_KEYS.size,
    excludedCanonicalCount: excluded.length,
    exclusionSha256: sha256Canonical({
      selectorVersion: GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION,
      configuredLegacyKeys: [...LEGACY_KEYS].sort(compareText),
      excluded: excluded.map(populationFingerprint),
    }),
  };
}

function availabilityCounts(candidates: PreparedCandidate[]): GrantAnalysisAvailabilityCounts {
  const result = {
    kstartup: emptyStratumCounts(),
    bizinfo: emptyStratumCounts(),
  } satisfies GrantAnalysisAvailabilityCounts;
  for (const candidate of candidates) result[candidate.source][candidate.stratum] += 1;
  return result;
}

function emptyStratumCounts(): Record<GrantAnalysisEvaluationStratum, number> {
  return {
    sparse_attachment_unavailable: 0,
    sparse_attachment_loadable: 0,
    baseline_density_mid: 0,
    baseline_density_high_control: 0,
  };
}

function publicValidationProjection(
  entry: GrantAnalysisEvaluationFullEntry & { split: "validation" },
): GrantAnalysisEvaluationPublicValidationEntry {
  const {
    opaqueCommitmentSha256: _secretCommitment,
    selectorRankSha256: _secretRank,
    ...publicEntry
  } = entry;
  return publicEntry;
}

function publicSealedProjection(
  entry: GrantAnalysisEvaluationFullEntry,
): GrantAnalysisEvaluationPublicSealedEntry {
  return {
    split: "sealed",
    source: entry.source,
    stratum: entry.stratum,
    opaqueCommitmentSha256: entry.opaqueCommitmentSha256,
  };
}

function selectedCount(
  selected: readonly GrantAnalysisEvaluationFullEntry[],
  source: GrantAnalysisEvaluationSource,
  stratum: GrantAnalysisEvaluationStratum,
  split: GrantAnalysisEvaluationSplit,
): number {
  return selected.filter((entry) =>
    entry.source === source && entry.stratum === stratum && entry.split === split).length;
}

function assertExpectedReceipt(receipt: GrantAnalysisEvaluationExpectedReceipt): void {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("Evaluation cohort expected receipt is required.");
  }
  for (const field of [
    "canonicalCount",
    "duplicateInclusiveCount",
    "configuredLegacyKeyCount",
    "excludedCanonicalCount",
  ] as const) {
    if (!Number.isSafeInteger(receipt[field]) || receipt[field] < 0) {
      throw new Error(`Evaluation cohort expected receipt requires ${field}.`);
    }
  }
}

function assertExpectedReceiptMatches(
  expected: GrantAnalysisEvaluationExpectedReceipt,
  population: GrantAnalysisEvaluationPopulationAudit,
  exclusions: GrantAnalysisEvaluationExclusionAudit,
): void {
  const actual: GrantAnalysisEvaluationExpectedReceipt = {
    canonicalCount: population.canonicalCount,
    duplicateInclusiveCount: population.duplicateInclusiveCount,
    configuredLegacyKeyCount: exclusions.configuredLegacyKeyCount,
    excludedCanonicalCount: exclusions.excludedCanonicalCount,
  };
  assertCanonicalEqual("expected population receipt", actual, expected);
}

function assertManifestEnvelope(
  publicManifest: GrantAnalysisEvaluationPublicManifest,
  secretManifest: GrantAnalysisEvaluationSecretManifest,
): void {
  if (!publicManifest || typeof publicManifest !== "object" ||
    !secretManifest || typeof secretManifest !== "object") {
    throw new Error("Evaluation manifest pair must contain public and secret objects.");
  }
  if (publicManifest.recordType !== "grant_analysis_evaluation_cohort_public" ||
    secretManifest.recordType !== "grant_analysis_evaluation_cohort_secret" ||
    publicManifest.schemaVersion !== 1 || secretManifest.schemaVersion !== 1 ||
    publicManifest.selectorVersion !== GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION ||
    secretManifest.selectorVersion !== GRANT_ANALYSIS_EVALUATION_SELECTOR_VERSION ||
    publicManifest.asOf !== GRANT_ANALYSIS_EVALUATION_AS_OF ||
    secretManifest.asOf !== GRANT_ANALYSIS_EVALUATION_AS_OF) {
    throw new Error("Evaluation manifest envelope does not match the frozen contract.");
  }
  if (publicManifest.externalLlmCalls !== 0 || secretManifest.externalLlmCalls !== 0 ||
    publicManifest.databaseWriteMode !== false || secretManifest.databaseWriteMode !== false) {
    throw new Error("Evaluation manifest side-effect contract verification failed.");
  }
  for (const hash of [
    publicManifest.population?.canonicalSha256,
    publicManifest.population?.duplicateInclusiveSha256,
    publicManifest.exclusions?.exclusionSha256,
    publicManifest.quotaSha256,
    publicManifest.availabilitySha256,
    publicManifest.selectionCommitmentSha256,
  ]) {
    if (!isSha256(hash ?? null)) {
      throw new Error("Evaluation manifest contains an invalid SHA-256 commitment.");
    }
  }
}

function assertSeed(seed: string): void {
  if (typeof seed !== "string" || !/^[a-f0-9]{64}$/i.test(seed)) {
    throw new Error("Evaluation cohort seed must be exactly 64 hexadecimal characters.");
  }
}

function manifestHashPayload<T extends { manifestSha256: string }>(manifest: T): Omit<T, "manifestSha256"> {
  const { manifestSha256: _derived, ...payload } = manifest;
  return payload;
}

function assertCanonicalEqual(label: string, actual: unknown, expected: unknown): void {
  if (stableJsonStringify(actual) !== stableJsonStringify(expected)) {
    throw new Error(`Evaluation ${label} verification failed.`);
  }
}

function isStructurallyActive(entry: NormalizedGrant<unknown>, asOf: string): boolean {
  if (entry.grant.status !== "open" && entry.grant.status !== "upcoming" &&
    entry.grant.status !== "unknown") return false;
  const applyEnd = entry.grant.apply_end;
  if (!applyEnd) return true;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(applyEnd);
  if (!match?.[1]) {
    throw new Error(`${entry.grant.source}:${entry.grant.source_id}: apply_end is not an ISO date.`);
  }
  return match[1] >= asOf.slice(0, 10);
}

function candidateKey(candidate: Pick<PreparedCandidate, "source" | "sourceId">): string {
  return `${candidate.source}:${candidate.sourceId}`;
}

function seededCommitment(seed: string, domain: string, payload: unknown): string {
  return createHash("sha256")
    .update(stableJsonStringify({ domain, seed, payload }), "utf8")
    .digest("hex");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

function validRelativeObjectKey(value: string | null | undefined): boolean {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") &&
    !value.split("/").includes("..");
}

function isSha256(value: string | null): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function cleanOptionalString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedHashField(value: string | null | undefined): string | null {
  const cleaned = cleanOptionalString(value);
  return cleaned && isSha256(cleaned) ? cleaned.toLowerCase() : cleaned;
}

function hasNonEmptyString(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function comparePreparedCandidates(left: PreparedCandidate, right: PreparedCandidate): number {
  return compareText(left.selectorRankSha256, right.selectorRankSha256) ||
    compareText(candidateKey(left), candidateKey(right));
}

function compareFullEntries(
  left: GrantAnalysisEvaluationFullEntry,
  right: GrantAnalysisEvaluationFullEntry,
): number {
  return compareText(left.source, right.source) ||
    compareText(left.stratum, right.stratum) ||
    compareText(left.split, right.split) ||
    compareText(left.selectorRankSha256, right.selectorRankSha256);
}

function comparePublicValidationEntries(
  left: GrantAnalysisEvaluationPublicValidationEntry,
  right: GrantAnalysisEvaluationPublicValidationEntry,
): number {
  return compareText(left.source, right.source) ||
    compareText(left.stratum, right.stratum) ||
    compareText(left.sourceId, right.sourceId) ||
    compareText(left.sourceRevision, right.sourceRevision);
}

function comparePublicSealedEntries(
  left: GrantAnalysisEvaluationPublicSealedEntry,
  right: GrantAnalysisEvaluationPublicSealedEntry,
): number {
  return compareText(left.source, right.source) ||
    compareText(left.stratum, right.stratum) ||
    compareText(left.opaqueCommitmentSha256, right.opaqueCommitmentSha256);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
