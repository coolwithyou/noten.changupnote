import { createHash } from "node:crypto";

export type ExtractionWriteBatchSource = "bizinfo" | "kstartup";
export type ExtractionWriteBatchAction = "archive_attachments" | "ocr_images";
export type ExtractionImageOcrProvider = "macos_vision" | "paddleocr";

interface PriorityBatch {
  source: string;
  action: string;
  totalCandidateCount: number;
  selectedCount: number;
  eligibleBlockedCompanyCount: number;
  priorityScoreSum: number;
  sourceIds: string[];
  selectedCandidates: Array<{
    sourceId: string;
    operationalAction: string;
    eligibleBlockedCompanyCount: number;
    priorityScore: number;
    extractionReadiness: string;
    extractionWarnings: string[];
    attachmentState: Record<string, number>;
  }>;
}

interface TrackedCandidate {
  sourceId: string;
  activeGrantFound: boolean;
  source: string | null;
  operationalAction: string;
  eligibleBlockedCompanyCount: number;
  priorityScore: number;
  extractionReadiness: string | null;
  extractionWarnings: string[];
  attachmentState: Record<string, number>;
}

export interface ExtractionPriorityEvidence {
  generatedAt: string;
  asOf: string;
  writeMode: false;
  grantCount: number;
  companyCount: number;
  candidateCount: number;
  totalEligibleBlockedCompanyCount: number;
  operationalActionCounts: Record<string, number>;
  priorityBatches: PriorityBatch[];
  trackedCandidates?: TrackedCandidate[];
}

export interface BusinessNumberEvidence {
  generatedAt: string;
  asOf: string;
  writeMode: false;
  grantCount: number;
  companyCount: number;
  pairCount: number;
  initialRecommendableCount: number;
  falseIneligibleAgainstFullCount: number;
  unsafeIneligibleAgainstFullViableCount: number;
  extractionReadinessCounts: Record<string, number>;
  recommendableByExtractionReadiness: Record<string, number>;
}

export interface ArchiveDryRunEvidence {
  generatedAt: string;
  asOf: string;
  mode: "dry-run";
  batchCandidateCount: number;
  selectedAttachmentCount: number;
  sourceIds: string[];
  imageOcr?: "none" | ExtractionImageOcrProvider;
  candidates: Array<{
    sourceId: string;
    title: string;
    selectedFilenames: string[];
  }>;
}

export interface ImageOcrProbeEvidence {
  generatedAt: string;
  asOf: string;
  writeMode: false;
  provider: ExtractionImageOcrProvider;
  source: ExtractionWriteBatchSource;
  requestedSourceIds: string[];
  targetCount: number;
  recognizedCount: number;
  passingArchiveGateCount: number;
  failureCount: number;
  results: Array<{
    sourceId: string;
    filename: string;
    characterCount?: number;
    averageConfidence?: number;
    converter?: string;
    error?: string;
  }>;
}

export interface ArchiveWriteReceiptEvidence {
  generatedAt: string;
  asOf: string;
  mode: "write";
  source: ExtractionWriteBatchSource;
  imageOcr?: "none" | ExtractionImageOcrProvider;
  sourceIds: string[];
  selectedAttachmentCount: number;
  succeededCount: number;
  failedCount: number;
  candidates: Array<{
    sourceId: string;
    title: string;
    selectedFilenames: string[];
  }>;
  results: Array<{
    sourceId: string;
    archivedCount?: number;
    convertedCount?: number;
    failureCount?: number;
    error?: string;
    selectedAttachments?: ArchiveWriteAttachmentReceipt[];
    generatedAttachments?: ArchiveWriteAttachmentReceipt[];
  }>;
}

export interface ArchiveWriteAttachmentReceipt {
  filename: string;
  archiveIdentityValid: boolean;
  sha256: string | null;
  storageKey: string | null;
  archiveUrlPresent: boolean;
  conversionStatus: "converted" | "failed" | "skipped" | "missing";
  converter: string | null;
  ocrProvider: string | null;
  ocrConfidence: number | null;
  conversionError: string | null;
}

export interface ExtractionWriteBatchManifest {
  schemaVersion: "extraction-write-batch-v1";
  batchId: string;
  createdAt: string;
  asOf: string;
  source: ExtractionWriteBatchSource;
  action: ExtractionWriteBatchAction;
  sourceIds: string[];
  authorization: {
    approved: false;
    writeStillRequiresExplicitCommandConfirmation: true;
  };
  ocrEvidence?: {
    provider: ExtractionImageOcrProvider;
    operationalAccuracyEvidence: false;
    minimumConfidence: 0.6;
    minimumCharacterCount: 20;
    recognizedCount: number;
    results: Array<{
      sourceId: string;
      filename: string;
      characterCount: number;
      averageConfidence: number;
      converter: string;
    }>;
  };
  before: {
    grantCount: number;
    companyCount: number;
    candidateCount: number;
    totalEligibleBlockedCompanyCount: number;
    operationalActionCounts: Record<string, number>;
    initialRecommendableCount: number;
    falseIneligibleAgainstFullCount: number;
    unsafeIneligibleAgainstFullViableCount: number;
    recommendableByExtractionReadiness: Record<string, number>;
    selectedEligibleBlockedCompanyCount: number;
    selectedPriorityScoreSum: number;
    bySourceId: Array<{
      sourceId: string;
      operationalAction: string;
      extractionReadiness: string;
      extractionWarnings: string[];
      attachmentState: Record<string, number>;
    }>;
  };
  expectedArtifacts: {
    selectedInputAttachmentCount: number;
    bySourceId: Array<{ sourceId: string; title: string; selectedFilenames: string[] }>;
    requiredPostWriteEvidence: string[];
  };
  commands: {
    repeatDryRun: CommandContract;
    approvedWriteTemplate: CommandContract;
    afterPriorityReport: CommandContract;
    afterBusinessNumberReport: CommandContract;
    comparisonTemplate: CommandContract;
    repeatOcrProbe?: CommandContract;
  };
}

export interface CommandContract {
  executable: "pnpm";
  args: string[];
  display: string;
}

export interface ExtractionWriteBatchComparison {
  schemaVersion: "extraction-write-batch-comparison-v1";
  batchId: string;
  comparedAt: string;
  asOf: string;
  contaminated: boolean;
  contaminationReasons: string[];
  writeReceiptIssues: string[];
  deltas: {
    totalEligibleBlockedCompanyCount: number;
    initialRecommendableCount: number;
    candidateCount: number;
  };
  sourceIdTransitions: Array<{
    sourceId: string;
    activeGrantFound: boolean;
    fromAction: ExtractionWriteBatchAction;
    toAction: string;
    extractionReadiness: string | null;
    extractionWarnings: string[];
    attachmentState: Record<string, number>;
    validArchivedCountDelta: number;
  }>;
  gates: {
    allSourceIdsTracked: boolean;
    allSourceIdsRemainActive: boolean;
    atLeastOneActionMoved: boolean;
    allSourceIdsGainedArchiveIdentity: boolean;
    noFalseIneligibleRegression: boolean;
    noUnsafeIneligibleRegression: boolean;
    partialOrUnstructuredRecommendableCount: number;
    readinessGateMaintained: boolean;
    comparable: boolean;
    writeReceiptPresent: boolean;
    writeReceiptVerified: boolean;
    writeOutcomeVerified: boolean;
  };
}

export function buildExtractionWriteBatchManifest(input: {
  priority: ExtractionPriorityEvidence;
  business: BusinessNumberEvidence;
  dryRun: ArchiveDryRunEvidence;
  source: ExtractionWriteBatchSource;
  action?: ExtractionWriteBatchAction;
  ocrProbe?: ImageOcrProbeEvidence;
  createdAt?: Date;
}): ExtractionWriteBatchManifest {
  const action = input.action ?? "archive_attachments";
  assertReadOnlyEvidence(input.priority, input.business, input.dryRun);
  assertSameAsOf(
    input.priority.asOf,
    input.business.asOf,
    input.dryRun.asOf,
    ...(input.ocrProbe ? [input.ocrProbe.asOf] : []),
  );
  if (input.priority.grantCount !== input.business.grantCount) {
    throw new Error("priority and business-number evidence must cover the same grant count");
  }
  assertBusinessSafetyMetrics(input.business);
  const batch = input.priority.priorityBatches.find((entry) =>
    entry.source === input.source && entry.action === action);
  if (!batch) throw new Error(`priority batch not found: ${input.source}:${action}`);
  if (batch.sourceIds.length === 0 || batch.sourceIds.length > 20) {
    throw new Error("approval batch must contain 1..20 source IDs");
  }
  if (batch.selectedCount !== batch.sourceIds.length) throw new Error("priority batch selected count is inconsistent");
  assertSafeUniqueSourceIds(batch.sourceIds);
  if (!Array.isArray(batch.selectedCandidates)) throw new Error("priority report is missing selected batch details");
  assertSameSet(batch.selectedCandidates.map((candidate) => candidate.sourceId), batch.sourceIds, "priority batch details");
  assertSameSet(input.dryRun.sourceIds, batch.sourceIds, "dry-run requested source IDs");
  const dryRunCandidateIds = input.dryRun.candidates.map((candidate) => candidate.sourceId);
  assertSameSet(dryRunCandidateIds, batch.sourceIds, "dry-run candidate source IDs");
  if (input.dryRun.batchCandidateCount !== batch.sourceIds.length) {
    throw new Error("dry-run candidate count does not cover the full approval batch");
  }
  const selectedAttachmentCount = input.dryRun.candidates.reduce(
    (sum, candidate) => sum + candidate.selectedFilenames.length,
    0,
  );
  if (selectedAttachmentCount !== input.dryRun.selectedAttachmentCount || selectedAttachmentCount === 0) {
    throw new Error("dry-run attachment count is empty or inconsistent");
  }
  const ocrEvidence = action === "ocr_images"
    ? validateOcrEvidence(input.source, input.dryRun, input.ocrProbe, batch.sourceIds)
    : null;

  const csv = batch.sourceIds.join(",");
  const archiveScript = input.source === "bizinfo"
    ? "backfill:bizinfo-attachments"
    : "backfill:kstartup-attachments";
  const confirmation = input.source === "bizinfo"
    ? "ARCHIVE_BIZINFO_ATTACHMENTS"
    : "ARCHIVE_KSTARTUP_ATTACHMENTS";
  const commonArgs = [
    "--silent",
    archiveScript,
    "--",
    `--sourceIds=${csv}`,
    `--limit=${batch.sourceIds.length}`,
    "--scanLimit=2000",
    `--asOf=${input.priority.asOf}`,
    ...(ocrEvidence ? [`--imageOcr=${ocrEvidence.provider}`] : []),
  ];
  const trackingArgs = ["--silent", "report:extraction-improvement-priority", "--", "--limit=2000", "--samples=0", `--asOf=${input.priority.asOf}`, `--trackSource=${input.source}`, `--trackSourceIds=${csv}`];
  const stableIdentity = {
    asOf: input.priority.asOf,
    source: input.source,
    action,
    sourceIds: batch.sourceIds,
    attachments: input.dryRun.candidates.map((candidate) => ({
      sourceId: candidate.sourceId,
      selectedFilenames: candidate.selectedFilenames,
    })),
    ...(ocrEvidence ? { ocr: ocrEvidence } : {}),
  };
  return {
    schemaVersion: "extraction-write-batch-v1",
    batchId: `extraction-${createHash("sha256").update(JSON.stringify(stableIdentity)).digest("hex").slice(0, 16)}`,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    asOf: input.priority.asOf,
    source: input.source,
    action,
    sourceIds: [...batch.sourceIds],
    authorization: {
      approved: false,
      writeStillRequiresExplicitCommandConfirmation: true,
    },
    ...(ocrEvidence ? { ocrEvidence } : {}),
    before: {
      grantCount: input.priority.grantCount,
      companyCount: input.priority.companyCount,
      candidateCount: input.priority.candidateCount,
      totalEligibleBlockedCompanyCount: input.priority.totalEligibleBlockedCompanyCount,
      operationalActionCounts: input.priority.operationalActionCounts,
      initialRecommendableCount: input.business.initialRecommendableCount,
      falseIneligibleAgainstFullCount: input.business.falseIneligibleAgainstFullCount,
      unsafeIneligibleAgainstFullViableCount: input.business.unsafeIneligibleAgainstFullViableCount,
      recommendableByExtractionReadiness: input.business.recommendableByExtractionReadiness,
      selectedEligibleBlockedCompanyCount: batch.eligibleBlockedCompanyCount,
      selectedPriorityScoreSum: batch.priorityScoreSum,
      bySourceId: batch.selectedCandidates.map((candidate) => ({
        sourceId: candidate.sourceId,
        operationalAction: candidate.operationalAction,
        extractionReadiness: candidate.extractionReadiness,
        extractionWarnings: candidate.extractionWarnings,
        attachmentState: candidate.attachmentState,
      })),
    },
    expectedArtifacts: {
      selectedInputAttachmentCount: selectedAttachmentCount,
      bySourceId: input.dryRun.candidates,
      requiredPostWriteEvidence: [
        "archive identity has sha256 and storageKey or archiveUrl",
        "raw attachment points at the archived storage identity",
        "conversion result is recorded as converted or an explicit failure; never silently skipped",
        "the same source IDs are present in the post-write priority report",
        ...(ocrEvidence ? [
          "every selected image conversion records the probed OCR provider and confidence",
          "no selected image is silently skipped or promoted below the OCR quality gate",
        ] : []),
      ],
    },
    commands: {
      repeatDryRun: command(commonArgs),
      approvedWriteTemplate: command([...commonArgs, "--write", `--confirm=${confirmation}`]),
      afterPriorityReport: command(trackingArgs),
      afterBusinessNumberReport: command(["--silent", "report:business-number-first-results", "--", "--limit=2000", `--asOf=${input.priority.asOf}`]),
      comparisonTemplate: command([
        "--silent",
        "compare:extraction-write-batch",
        "--",
        "--manifest=<manifest.json>",
        "--priority=<after-priority.json>",
        "--business=<after-business.json>",
        "--writeReceipt=<archive-write-output.json>",
        "--require-verified",
      ]),
      ...(ocrEvidence ? {
        repeatOcrProbe: command([
          "--silent",
          "probe:grant-image-ocr",
          "--",
          `--provider=${ocrEvidence.provider}`,
          `--source=${input.source}`,
          `--sourceIds=${csv}`,
          `--limit=${selectedAttachmentCount}`,
          "--scanLimit=2000",
          `--asOf=${input.priority.asOf}`,
        ]),
      } : {}),
    },
  };
}

function validateOcrEvidence(
  source: ExtractionWriteBatchSource,
  dryRun: ArchiveDryRunEvidence,
  probe: ImageOcrProbeEvidence | undefined,
  sourceIds: string[],
): NonNullable<ExtractionWriteBatchManifest["ocrEvidence"]> {
  if (source !== "bizinfo") throw new Error("ocr_images approval batches currently support bizinfo only");
  if (!probe) throw new Error("ocr_images approval batch requires --ocrProbe evidence");
  if (probe.writeMode !== false) throw new Error("OCR probe evidence must be read-only");
  if (probe.source !== source) throw new Error("OCR probe source does not match the approval batch");
  if (dryRun.imageOcr !== probe.provider) throw new Error("archive dry-run and OCR probe providers must match");
  assertSameSet(probe.requestedSourceIds, sourceIds, "OCR probe requested source IDs");
  const selectedFiles = dryRun.candidates.flatMap((candidate) => candidate.selectedFilenames.map((filename) => ({
    sourceId: candidate.sourceId,
    filename,
  })));
  if (selectedFiles.some((file) => !/\.(?:png|jpe?g)$/i.test(file.filename))) {
    throw new Error("ocr_images batch contains a non-image attachment");
  }
  const resultFiles = probe.results.map((result) => ({ sourceId: result.sourceId, filename: result.filename }));
  assertSameFileSet(resultFiles, selectedFiles, "OCR probe files");
  if (probe.targetCount !== selectedFiles.length || probe.recognizedCount !== selectedFiles.length ||
    probe.passingArchiveGateCount !== selectedFiles.length || probe.failureCount !== 0) {
    throw new Error("every selected image must be recognized and pass the archive gate");
  }
  const results = probe.results.map((result) => {
    if (result.error || typeof result.averageConfidence !== "number" || result.averageConfidence < 0.6 ||
      typeof result.characterCount !== "number" || result.characterCount < 20 || !result.converter) {
      throw new Error(`OCR result did not pass the archive gate: ${result.sourceId}:${result.filename}`);
    }
    return {
      sourceId: result.sourceId,
      filename: result.filename,
      characterCount: result.characterCount,
      averageConfidence: result.averageConfidence,
      converter: result.converter,
    };
  });
  return {
    provider: probe.provider,
    operationalAccuracyEvidence: false,
    minimumConfidence: 0.6,
    minimumCharacterCount: 20,
    recognizedCount: results.length,
    results,
  };
}

export function compareExtractionWriteBatch(input: {
  manifest: ExtractionWriteBatchManifest;
  priority: ExtractionPriorityEvidence;
  business: BusinessNumberEvidence;
  writeReceipt?: ArchiveWriteReceiptEvidence;
  comparedAt?: Date;
}): ExtractionWriteBatchComparison {
  assertReadOnlyEvidence(input.priority, input.business);
  assertBusinessSafetyMetrics(input.business);
  const contaminationReasons: string[] = [];
  if (input.priority.asOf !== input.manifest.asOf || input.business.asOf !== input.manifest.asOf) {
    contaminationReasons.push("asOf_mismatch");
  }
  if (input.priority.grantCount !== input.manifest.before.grantCount || input.business.grantCount !== input.manifest.before.grantCount) {
    contaminationReasons.push("grant_universe_changed");
  }
  const tracked = new Map((input.priority.trackedCandidates ?? []).map((candidate) => [candidate.sourceId, candidate]));
  const beforeBySourceId = new Map(input.manifest.before.bySourceId.map((candidate) => [candidate.sourceId, candidate]));
  const transitions = input.manifest.sourceIds.map((sourceId) => {
    const candidate = tracked.get(sourceId);
    const before = beforeBySourceId.get(sourceId);
    return {
      sourceId,
      activeGrantFound: candidate?.activeGrantFound ?? false,
      fromAction: input.manifest.action,
      toAction: candidate?.operationalAction ?? "untracked",
      extractionReadiness: candidate?.extractionReadiness ?? null,
      extractionWarnings: candidate?.extractionWarnings ?? [],
      attachmentState: candidate?.attachmentState ?? {},
      validArchivedCountDelta:
        (candidate?.attachmentState.validArchivedCount ?? 0) - (before?.attachmentState.validArchivedCount ?? 0),
    };
  });
  const allSourceIdsTracked = transitions.every((transition) => transition.toAction !== "untracked");
  const allSourceIdsRemainActive = transitions.every((transition) => transition.activeGrantFound);
  const partialOrUnstructuredRecommendableCount =
    (input.business.recommendableByExtractionReadiness.partial ?? 0) +
    (input.business.recommendableByExtractionReadiness.unstructured ?? 0);
  const noFalseIneligibleRegression =
    input.business.falseIneligibleAgainstFullCount <= input.manifest.before.falseIneligibleAgainstFullCount;
  const noUnsafeIneligibleRegression =
    input.business.unsafeIneligibleAgainstFullViableCount <= input.manifest.before.unsafeIneligibleAgainstFullViableCount;
  const readinessGateMaintained = partialOrUnstructuredRecommendableCount === 0;
  const atLeastOneActionMoved = transitions.some((transition) =>
    transition.toAction !== input.manifest.action && transition.toAction !== "untracked");
  const allSourceIdsGainedArchiveIdentity = transitions.every((transition) =>
    transition.validArchivedCountDelta > 0);
  const comparable = contaminationReasons.length === 0 && allSourceIdsTracked && allSourceIdsRemainActive;
  const writeReceiptIssues = verifyArchiveWriteReceipt(input.manifest, input.writeReceipt);
  const writeReceiptPresent = Boolean(input.writeReceipt);
  const writeReceiptVerified = writeReceiptIssues.length === 0;
  return {
    schemaVersion: "extraction-write-batch-comparison-v1",
    batchId: input.manifest.batchId,
    comparedAt: (input.comparedAt ?? new Date()).toISOString(),
    asOf: input.manifest.asOf,
    contaminated: contaminationReasons.length > 0,
    contaminationReasons,
    writeReceiptIssues,
    deltas: {
      totalEligibleBlockedCompanyCount:
        input.priority.totalEligibleBlockedCompanyCount - input.manifest.before.totalEligibleBlockedCompanyCount,
      initialRecommendableCount:
        input.business.initialRecommendableCount - input.manifest.before.initialRecommendableCount,
      candidateCount: input.priority.candidateCount - input.manifest.before.candidateCount,
    },
    sourceIdTransitions: transitions,
    gates: {
      allSourceIdsTracked,
      allSourceIdsRemainActive,
      atLeastOneActionMoved,
      allSourceIdsGainedArchiveIdentity,
      noFalseIneligibleRegression,
      noUnsafeIneligibleRegression,
      partialOrUnstructuredRecommendableCount,
      readinessGateMaintained,
      comparable,
      writeReceiptPresent,
      writeReceiptVerified,
      writeOutcomeVerified: comparable && atLeastOneActionMoved && allSourceIdsGainedArchiveIdentity &&
        noFalseIneligibleRegression && noUnsafeIneligibleRegression && readinessGateMaintained && writeReceiptVerified,
    },
  };
}

export function verifyArchiveWriteReceipt(
  manifest: ExtractionWriteBatchManifest,
  receipt: ArchiveWriteReceiptEvidence | undefined,
): string[] {
  if (!receipt) return ["write_receipt_missing"];
  const issues: string[] = [];
  if (receipt.mode !== "write") issues.push("write_receipt_not_write_mode");
  if (receipt.asOf !== manifest.asOf) issues.push("write_receipt_asof_mismatch");
  if (receipt.source !== manifest.source) issues.push("write_receipt_source_mismatch");
  if (!sameSet(receipt.sourceIds, manifest.sourceIds)) issues.push("write_receipt_source_ids_mismatch");
  if (receipt.succeededCount !== manifest.sourceIds.length || receipt.failedCount !== 0) {
    issues.push("write_receipt_grant_failures");
  }
  if (receipt.selectedAttachmentCount !== manifest.expectedArtifacts.selectedInputAttachmentCount) {
    issues.push("write_receipt_attachment_count_mismatch");
  }
  const expectedFiles = manifest.expectedArtifacts.bySourceId.flatMap((candidate) =>
    candidate.selectedFilenames.map((filename) => ({ sourceId: candidate.sourceId, filename })));
  const candidateFiles = receipt.candidates.flatMap((candidate) =>
    candidate.selectedFilenames.map((filename) => ({ sourceId: candidate.sourceId, filename })));
  if (!sameFileSet(candidateFiles, expectedFiles)) issues.push("write_receipt_candidate_files_mismatch");
  const resultIds = receipt.results.map((result) => result.sourceId);
  if (!sameSet(resultIds, manifest.sourceIds)) issues.push("write_receipt_result_ids_mismatch");
  const expectedOcrProvider = manifest.ocrEvidence?.provider === "macos_vision"
    ? "macos_vision"
    : manifest.ocrEvidence?.provider === "paddleocr"
      ? "paddleocr_ppstructurev3"
      : null;
  if (manifest.ocrEvidence && receipt.imageOcr !== manifest.ocrEvidence.provider) {
    issues.push("write_receipt_ocr_selection_mismatch");
  }
  const expectedOcrByFile = new Map((manifest.ocrEvidence?.results ?? []).map((result) => [
    `${result.sourceId}\u0000${result.filename}`,
    result,
  ]));
  for (const candidate of manifest.expectedArtifacts.bySourceId) {
    const result = receipt.results.find((entry) => entry.sourceId === candidate.sourceId);
    if (!result || result.error) {
      issues.push(`write_receipt_result_failed:${candidate.sourceId}`);
      continue;
    }
    if (expectedOcrProvider && (result.failureCount ?? 0) !== 0) {
      issues.push(`write_receipt_ocr_bundle_failure:${candidate.sourceId}`);
    }
    const selectedAttachments = result.selectedAttachments ?? [];
    if (!sameSet(selectedAttachments.map((attachment) => attachment.filename), candidate.selectedFilenames)) {
      issues.push(`write_receipt_selected_files_mismatch:${candidate.sourceId}`);
      continue;
    }
    for (const attachment of selectedAttachments) {
      const key = `${candidate.sourceId}\u0000${attachment.filename}`;
      if (!attachment.archiveIdentityValid || !attachment.sha256 || (!attachment.storageKey && !attachment.archiveUrlPresent)) {
        issues.push(`write_receipt_archive_identity_missing:${key}`);
      }
      if (attachment.conversionStatus === "missing") {
        issues.push(`write_receipt_conversion_status_missing:${key}`);
      }
      if (expectedOcrProvider) {
        const probe = expectedOcrByFile.get(key);
        if (attachment.conversionStatus !== "converted") issues.push(`write_receipt_ocr_not_converted:${key}`);
        if (attachment.conversionError) issues.push(`write_receipt_ocr_conversion_error:${key}`);
        if (attachment.ocrProvider !== expectedOcrProvider) issues.push(`write_receipt_ocr_provider_mismatch:${key}`);
        if (typeof attachment.ocrConfidence !== "number" || attachment.ocrConfidence < 0.6) {
          issues.push(`write_receipt_ocr_confidence_failed:${key}`);
        }
        if (!probe || attachment.converter !== probe.converter) issues.push(`write_receipt_ocr_converter_mismatch:${key}`);
      }
    }
  }
  return [...new Set(issues)];
}

function assertBusinessSafetyMetrics(business: BusinessNumberEvidence): void {
  if (!business.recommendableByExtractionReadiness ||
    typeof business.recommendableByExtractionReadiness.partial !== "number" ||
    typeof business.recommendableByExtractionReadiness.unstructured !== "number") {
    throw new Error("business-number evidence is missing recommendableByExtractionReadiness safety metrics");
  }
}

function assertReadOnlyEvidence(
  priority: ExtractionPriorityEvidence,
  business: BusinessNumberEvidence,
  dryRun?: ArchiveDryRunEvidence,
): void {
  if (priority.writeMode !== false || business.writeMode !== false) {
    throw new Error("only read-only report evidence can be used");
  }
  if (dryRun && dryRun.mode !== "dry-run") throw new Error("archive evidence must be a dry-run");
}

function assertSameAsOf(...values: string[]): void {
  if (new Set(values).size !== 1) throw new Error("all evidence must use the exact same asOf");
}

function assertSafeUniqueSourceIds(sourceIds: string[]): void {
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error("source IDs must be unique");
  for (const sourceId of sourceIds) {
    if (!/^[A-Za-z0-9._:-]+$/.test(sourceId)) throw new Error(`unsafe source ID: ${sourceId}`);
  }
}

function assertSameSet(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || [...actual].sort().join("\n") !== [...expected].sort().join("\n")) {
    throw new Error(`${label} do not exactly match the priority batch`);
  }
}

function assertSameFileSet(
  actual: Array<{ sourceId: string; filename: string }>,
  expected: Array<{ sourceId: string; filename: string }>,
  label: string,
): void {
  const key = (value: { sourceId: string; filename: string }) => `${value.sourceId}\u0000${value.filename}`;
  if (actual.length !== expected.length || actual.map(key).sort().join("\n") !== expected.map(key).sort().join("\n")) {
    throw new Error(`${label} do not exactly match the archive dry-run`);
  }
}

function sameSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && [...actual].sort().join("\n") === [...expected].sort().join("\n");
}

function sameFileSet(
  actual: Array<{ sourceId: string; filename: string }>,
  expected: Array<{ sourceId: string; filename: string }>,
): boolean {
  const key = (value: { sourceId: string; filename: string }) => `${value.sourceId}\u0000${value.filename}`;
  return actual.length === expected.length && actual.map(key).sort().join("\n") === expected.map(key).sort().join("\n");
}

function command(args: string[]): CommandContract {
  return { executable: "pnpm", args, display: ["pnpm", ...args].join(" ") };
}
