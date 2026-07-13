import type { GrantAttachmentArchiveBundle } from "./grantAttachmentArchive";

export interface GrantArchiveAttachmentReceipt {
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

export function buildGrantArchiveAttachmentReceipts(input: {
  selectedFilenames: string[];
  bundle: GrantAttachmentArchiveBundle;
}): {
  selectedAttachments: GrantArchiveAttachmentReceipt[];
  generatedAttachments: GrantArchiveAttachmentReceipt[];
} {
  const selected = input.selectedFilenames.map((filename) => {
    const attachment = input.bundle.attachments.find((candidate) => candidate.filename === filename);
    return attachment ? toReceipt(attachment) : missingReceipt(filename);
  });
  const selectedNames = new Set(input.selectedFilenames);
  return {
    selectedAttachments: selected,
    generatedAttachments: input.bundle.attachments
      .filter((attachment) => !selectedNames.has(attachment.filename))
      .map(toReceipt),
  };
}

function toReceipt(
  attachment: GrantAttachmentArchiveBundle["attachments"][number],
): GrantArchiveAttachmentReceipt {
  const conversion = attachment.conversion;
  return {
    filename: attachment.filename,
    archiveIdentityValid: Boolean(attachment.sha256 && (attachment.storage_key || attachment.archive_url)),
    sha256: attachment.sha256 ?? null,
    storageKey: attachment.storage_key ?? null,
    archiveUrlPresent: Boolean(attachment.archive_url),
    conversionStatus: conversion?.status ?? "missing",
    converter: conversion?.converter ?? null,
    ocrProvider: conversion?.ocr_provider ?? null,
    ocrConfidence: typeof conversion?.ocr_confidence === "number" ? conversion.ocr_confidence : null,
    conversionError: conversion?.error ?? null,
  };
}

function missingReceipt(filename: string): GrantArchiveAttachmentReceipt {
  return {
    filename,
    archiveIdentityValid: false,
    sha256: null,
    storageKey: null,
    archiveUrlPresent: false,
    conversionStatus: "missing",
    converter: null,
    ocrProvider: null,
    ocrConfidence: null,
    conversionError: "selected_attachment_missing_from_archive_bundle",
  };
}
