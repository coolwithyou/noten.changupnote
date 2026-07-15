import { createHash } from "node:crypto";
import type { GrantRaw, NormalizedGrant } from "@cunote/contracts";
import {
  buildBizInfoProgramExtractionInput,
  buildKStartupExtractionInput,
  resolveGrantExtractionManifest,
  type BizInfoProgram,
  type BizInfoProgramExtractionInput,
  type KStartupAnnouncement,
  type KStartupAttachmentMarkdown,
  type KStartupExtractionInput,
} from "@cunote/core";
import { loadKStartupAttachmentMarkdowns } from "./kstartupAttachmentMarkdown";

type Attachment = NonNullable<GrantRaw["attachments"]>[number];

export type GrantAnalysisPilotExtractionInput =
  | KStartupExtractionInput
  | BizInfoProgramExtractionInput;

export interface GrantAnalysisPilotAttachmentLimits {
  maxAttachments: number;
  maxCharsPerAttachment: number;
  maxTotalChars: number;
  maxDeclaredBytes: number;
}

export const DEFAULT_GRANT_ANALYSIS_PILOT_ATTACHMENT_LIMITS: Readonly<GrantAnalysisPilotAttachmentLimits> = {
  maxAttachments: 3,
  maxCharsPerAttachment: 8_000,
  maxTotalChars: 18_000,
  maxDeclaredBytes: 2_000_000,
};

export interface GrantAnalysisPilotInputVariant {
  kind: "api_only" | "api_plus_attachments";
  input: GrantAnalysisPilotExtractionInput;
  inputSha256: string;
  characterCount: number;
  includedAttachmentCount: number;
  includedAttachmentCharacterCount: number;
}

export interface GrantAnalysisPilotAttachmentFailure {
  stage: "conversion" | "readability" | "load";
  filename: string;
  message: string;
}

export interface GrantAnalysisPilotAttachmentAudit {
  limits: GrantAnalysisPilotAttachmentLimits;
  counts: {
    sourceDeclaredExpected: number;
    manifestExpected: number;
    expected: number;
    present: number;
    fetched: number;
    converted: number;
    loadableConverted: number;
    selectedForLoad: number;
    loaded: number;
    included: number;
    skippedConversion: number;
    failedConversion: number;
  };
  characters: {
    apiOnlyInput: number;
    loadedAttachmentMarkdown: number;
    includedAttachmentMarkdown: number;
    apiPlusAttachmentsInput: number;
    attachmentInputEnvelope: number;
  };
  truncation: {
    truncatedAttachmentCount: number;
    skippedOversizeCount: number;
    excludedByAttachmentLimitCount: number;
    selectedButNotLoadedCount: number;
  };
  includedAttachments: Array<{ filename: string; characterCount: number }>;
  failures: GrantAnalysisPilotAttachmentFailure[];
}

export interface GrantAnalysisPilotInputs {
  recordType: "grant_analysis_pilot_inputs";
  source: "kstartup" | "bizinfo";
  sourceId: string;
  title: string;
  sourceRevision: string;
  apiOnly: GrantAnalysisPilotInputVariant;
  apiPlusAttachments: GrantAnalysisPilotInputVariant;
  attachments: GrantAnalysisPilotAttachmentAudit;
  warnings: string[];
  readOnly: true;
  externalLlmCalls: 0;
}

/**
 * Builds the two immutable pilot inputs without database writes or LLM calls.
 * Attachment conversion metadata is never treated as proof that content was
 * read: only markdown returned by the storage loader can enter the attachment
 * variant and increment the included counters.
 */
export async function buildGrantAnalysisPilotInputs(options: {
  entry: NormalizedGrant<unknown>;
  storage: Parameters<typeof loadKStartupAttachmentMarkdowns>[0]["storage"];
  limits?: Partial<GrantAnalysisPilotAttachmentLimits>;
}): Promise<GrantAnalysisPilotInputs> {
  assertSupportedSourceIdentity(options.entry);
  const limits = resolveLimits(options.limits);
  const manifest = resolveGrantExtractionManifest(options.entry);
  const apiOnlyInput = buildSourceInput(options.entry, []);
  const attachments = options.entry.raw.attachments ?? [];
  const attachmentLoad = await loadKStartupAttachmentMarkdowns({
    attachments,
    storage: options.storage,
    ...limits,
  });
  const apiPlusAttachmentsInput = buildSourceInput(options.entry, attachmentLoad.markdowns);
  const includedAttachments = apiPlusAttachmentsInput.blocks
    .filter((block) => block.source === "attachment_markdown")
    .map((block) => ({
      filename: block.filename ?? "unknown",
      characterCount: block.text.length,
    }));

  const sourceDeclaredExpected = sourceDeclaredAttachmentCount(options.entry, apiOnlyInput);
  const presentCount = attachments.length;
  const expectedCount = Math.max(sourceDeclaredExpected, manifest.attachmentsExpected, presentCount);
  const fetchedCount = attachments.filter(hasStableArchiveIdentity).length;
  const convertedCount = attachments.filter(isDeclaredConverted).length;
  const loadableConvertedCount = attachments.filter(isLoadableConverted).length;
  const loadedAttachmentCharacters = attachmentLoad.markdowns
    .reduce((total, attachment) => total + attachment.markdown.length, 0);
  const includedAttachmentCharacters = includedAttachments
    .reduce((total, attachment) => total + attachment.characterCount, 0);
  const failures = attachmentFailures(attachments, attachmentLoad.failures);
  const warnings: string[] = [];

  if (expectedCount > presentCount) warnings.push("attachment_inventory_incomplete");
  if (convertedCount > loadableConvertedCount) warnings.push("converted_attachment_not_loadable");
  if (attachmentLoad.loadedCount > includedAttachments.length) warnings.push("loaded_attachment_not_included");
  if (convertedCount > includedAttachments.length) warnings.push("converted_attachment_not_fully_included");
  if (fetchedCount < convertedCount) warnings.push("converted_attachment_missing_stable_archive_identity");

  const apiOnly = variant("api_only", apiOnlyInput, []);
  const apiPlusAttachments = variant(
    "api_plus_attachments",
    apiPlusAttachmentsInput,
    includedAttachments,
  );

  return {
    recordType: "grant_analysis_pilot_inputs",
    source: options.entry.grant.source as "kstartup" | "bizinfo",
    sourceId: options.entry.grant.source_id,
    title: options.entry.grant.title,
    sourceRevision: manifest.revision,
    apiOnly,
    apiPlusAttachments,
    attachments: {
      limits,
      counts: {
        sourceDeclaredExpected,
        manifestExpected: manifest.attachmentsExpected,
        expected: expectedCount,
        present: presentCount,
        fetched: fetchedCount,
        converted: convertedCount,
        loadableConverted: loadableConvertedCount,
        selectedForLoad: attachmentLoad.candidateCount,
        loaded: attachmentLoad.loadedCount,
        included: includedAttachments.length,
        skippedConversion: attachments.filter((attachment) => attachment.conversion?.status === "skipped").length,
        failedConversion: attachments.filter((attachment) => attachment.conversion?.status === "failed").length,
      },
      characters: {
        apiOnlyInput: apiOnlyInput.text.length,
        loadedAttachmentMarkdown: loadedAttachmentCharacters,
        includedAttachmentMarkdown: includedAttachmentCharacters,
        apiPlusAttachmentsInput: apiPlusAttachmentsInput.text.length,
        attachmentInputEnvelope: Math.max(
          0,
          apiPlusAttachmentsInput.text.length - apiOnlyInput.text.length - includedAttachmentCharacters,
        ),
      },
      truncation: {
        truncatedAttachmentCount: attachmentLoad.truncatedCount,
        skippedOversizeCount: attachmentLoad.skippedOversizeCount,
        excludedByAttachmentLimitCount: Math.max(
          0,
          loadableConvertedCount - attachmentLoad.candidateCount,
        ),
        selectedButNotLoadedCount: Math.max(
          0,
          attachmentLoad.candidateCount - attachmentLoad.loadedCount,
        ),
      },
      includedAttachments,
      failures,
    },
    warnings: [...new Set(warnings)],
    readOnly: true,
    externalLlmCalls: 0,
  };
}

function variant(
  kind: GrantAnalysisPilotInputVariant["kind"],
  input: GrantAnalysisPilotExtractionInput,
  includedAttachments: Array<{ filename: string; characterCount: number }>,
): GrantAnalysisPilotInputVariant {
  return {
    kind,
    input,
    inputSha256: createHash("sha256").update(input.text, "utf8").digest("hex"),
    characterCount: input.text.length,
    includedAttachmentCount: includedAttachments.length,
    includedAttachmentCharacterCount: includedAttachments
      .reduce((total, attachment) => total + attachment.characterCount, 0),
  };
}

function buildSourceInput(
  entry: NormalizedGrant<unknown>,
  attachmentMarkdowns: KStartupAttachmentMarkdown[],
): GrantAnalysisPilotExtractionInput {
  if (entry.grant.source === "kstartup") {
    return buildKStartupExtractionInput(entry.raw.payload as KStartupAnnouncement, { attachmentMarkdowns });
  }
  if (entry.grant.source === "bizinfo") {
    return buildBizInfoProgramExtractionInput(entry.raw.payload as BizInfoProgram, { attachmentMarkdowns });
  }
  throw new Error(`Unsupported grant analysis pilot source: ${entry.grant.source}`);
}

function sourceDeclaredAttachmentCount(
  entry: NormalizedGrant<unknown>,
  apiOnlyInput: GrantAnalysisPilotExtractionInput,
): number {
  if (entry.grant.source === "kstartup") {
    return (entry.raw.payload as KStartupAnnouncement).detail?.attachments.length ?? 0;
  }
  return apiOnlyInput.source === "bizinfo" ? apiOnlyInput.metadata.attachments.length : 0;
}

function attachmentFailures(
  attachments: Attachment[],
  loadFailures: Array<{ filename: string; message: string }>,
): GrantAnalysisPilotAttachmentFailure[] {
  const failures: GrantAnalysisPilotAttachmentFailure[] = [];
  for (const attachment of attachments) {
    if (attachment.conversion?.status === "failed") {
      failures.push({
        stage: "conversion",
        filename: attachment.filename,
        message: cleanMessage(attachment.conversion.error) ?? "Attachment conversion failed.",
      });
    } else if (attachment.conversion?.status === "converted" && !validStorageKey(
      attachment.conversion.markdown_storage_key,
    )) {
      failures.push({
        stage: "readability",
        filename: attachment.filename,
        message: "Converted attachment has no valid markdown storage key.",
      });
    }
  }
  failures.push(...loadFailures.map((failure) => ({ stage: "load" as const, ...failure })));
  return failures;
}

function assertSupportedSourceIdentity(entry: NormalizedGrant<unknown>): void {
  const source = entry.grant.source;
  if (source !== "kstartup" && source !== "bizinfo") {
    throw new Error(`Unsupported grant analysis pilot source: ${source}`);
  }
  if (entry.raw.source !== source || entry.raw.source_id !== entry.grant.source_id) {
    throw new Error("Grant analysis pilot source identity mismatch between grant and raw payload.");
  }
  if (!isRecord(entry.raw.payload)) {
    throw new Error("Grant analysis pilot payload must be an object.");
  }
  const payloadSourceId = source === "kstartup"
    ? scalarSourceId(entry.raw.payload.pbanc_sn)
    : scalarSourceId(entry.raw.payload.pblancId);
  if (!payloadSourceId || payloadSourceId !== entry.grant.source_id) {
    throw new Error("Grant analysis pilot source identity mismatch between record and payload.");
  }
}

function resolveLimits(
  input: Partial<GrantAnalysisPilotAttachmentLimits> | undefined,
): GrantAnalysisPilotAttachmentLimits {
  const limits = { ...DEFAULT_GRANT_ANALYSIS_PILOT_ATTACHMENT_LIMITS, ...input };
  assertNonNegativeInteger("maxAttachments", limits.maxAttachments);
  assertPositiveInteger("maxCharsPerAttachment", limits.maxCharsPerAttachment);
  assertPositiveInteger("maxTotalChars", limits.maxTotalChars);
  assertPositiveInteger("maxDeclaredBytes", limits.maxDeclaredBytes);
  return limits;
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

function hasStableArchiveIdentity(attachment: Attachment): boolean {
  return Boolean(cleanMessage(attachment.storage_key) && cleanMessage(attachment.sha256));
}

function isDeclaredConverted(attachment: Attachment): boolean {
  return attachment.conversion?.status === "converted";
}

function isLoadableConverted(attachment: Attachment): boolean {
  return isDeclaredConverted(attachment) && validStorageKey(attachment.conversion?.markdown_storage_key);
}

function validStorageKey(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
}

function scalarSourceId(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function cleanMessage(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
