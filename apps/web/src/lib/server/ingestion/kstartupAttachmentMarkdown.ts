import type { GrantRaw } from "@cunote/contracts";
import type { KStartupAttachmentMarkdown } from "@cunote/core";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";

type Attachment = NonNullable<GrantRaw["attachments"]>[number];

export interface KStartupAttachmentMarkdownLoadResult {
  markdowns: KStartupAttachmentMarkdown[];
  candidateCount: number;
  loadedCount: number;
  truncatedCount: number;
  skippedOversizeCount: number;
  failures: Array<{ filename: string; message: string }>;
}

export async function loadKStartupAttachmentMarkdowns(options: {
  attachments: GrantRaw["attachments"] | null | undefined;
  storage: Pick<R2ObjectStorage, "getObjectText"> | null;
  maxAttachments?: number;
  maxCharsPerAttachment?: number;
  maxTotalChars?: number;
  maxDeclaredBytes?: number;
}): Promise<KStartupAttachmentMarkdownLoadResult> {
  const maxAttachments = options.maxAttachments ?? 3;
  const maxCharsPerAttachment = options.maxCharsPerAttachment ?? 8_000;
  const maxTotalChars = options.maxTotalChars ?? 18_000;
  const maxDeclaredBytes = options.maxDeclaredBytes ?? 2_000_000;
  const candidates = (options.attachments ?? [])
    .filter(hasConvertedMarkdown)
    .sort(compareAttachmentPriority)
    .slice(0, maxAttachments);
  const result: KStartupAttachmentMarkdownLoadResult = {
    markdowns: [],
    candidateCount: candidates.length,
    loadedCount: 0,
    truncatedCount: 0,
    skippedOversizeCount: 0,
    failures: [],
  };
  if (!options.storage) {
    for (const attachment of candidates) {
      result.failures.push({ filename: attachment.filename, message: "R2 markdown storage is not configured." });
    }
    return result;
  }

  let remaining = maxTotalChars;
  for (const attachment of candidates) {
    if (remaining <= 0) break;
    const declaredBytes = attachment.conversion?.markdown_bytes;
    if (typeof declaredBytes === "number" && declaredBytes > maxDeclaredBytes) {
      result.skippedOversizeCount += 1;
      continue;
    }
    try {
      const key = attachment.conversion!.markdown_storage_key!;
      const raw = await options.storage.getObjectText(key);
      const safe = sanitizeMarkdown(raw);
      const cap = Math.min(maxCharsPerAttachment, remaining);
      const markdown = safe.slice(0, cap);
      if (!markdown.trim()) continue;
      if (safe.length > markdown.length) result.truncatedCount += 1;
      result.markdowns.push({ filename: attachment.filename, markdown });
      result.loadedCount += 1;
      remaining -= markdown.length;
    } catch (error) {
      result.failures.push({
        filename: attachment.filename,
        message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }
  return result;
}

function hasConvertedMarkdown(attachment: Attachment): boolean {
  return attachment.conversion?.status === "converted" &&
    validStorageKey(attachment.conversion.markdown_storage_key);
}

function validStorageKey(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
}

function compareAttachmentPriority(left: Attachment, right: Attachment): number {
  return attachmentScore(right.filename) - attachmentScore(left.filename) ||
    (right.conversion?.markdown_bytes ?? 0) - (left.conversion?.markdown_bytes ?? 0) ||
    left.filename.localeCompare(right.filename, "ko");
}

function attachmentScore(filename: string): number {
  let score = 0;
  if (/(공\s*고|모집공고|모집요강|사업\s*안내|통합공고|공고문)/i.test(filename)) score += 3;
  if (/(신청서|지원서|사업\s*계획서|양식|서식|서약서|동의서|확약서|별지|증빙)/i.test(filename)) score -= 3;
  return score;
}

function sanitizeMarkdown(value: string): string {
  const withoutFrontmatter = value.startsWith("---")
    ? value.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "")
    : value;
  return withoutFrontmatter
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
