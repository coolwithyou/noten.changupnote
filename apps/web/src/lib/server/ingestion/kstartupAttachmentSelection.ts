import type { GrantRaw } from "@cunote/contracts";

type Attachment = NonNullable<GrantRaw["attachments"]>[number];

export function selectKStartupAttachmentsForArchive(
  attachments: GrantRaw["attachments"] | null | undefined,
  maxAttachments: number,
  options: { includeImages?: boolean } = {},
): Array<{ filename: string; url: string | null }> {
  const supported = options.includeImages
    ? /\.(?:hwp|hwpx|pdf|docx|txt|zip|xlsx|pptx|png|jpe?g)$/i
    : /\.(?:hwp|hwpx|pdf|docx|txt|zip|xlsx|pptx)$/i;
  return [...(attachments ?? [])]
    .filter((attachment) => Boolean(attachment.source_uri ?? attachment.url))
    .filter((attachment) => supported.test(attachment.filename))
    .sort((left, right) => attachmentScore(right.filename) - attachmentScore(left.filename) ||
      left.filename.localeCompare(right.filename, "ko"))
    .slice(0, Math.max(0, maxAttachments))
    .map((attachment) => ({
      filename: attachment.filename,
      url: attachment.source_uri ?? attachment.url ?? null,
    }));
}

export function mergeArchivedKStartupAttachments(
  existing: GrantRaw["attachments"] | null | undefined,
  archived: NonNullable<GrantRaw["attachments"]>,
): NonNullable<GrantRaw["attachments"]> {
  const archivedByIdentity = new Map(archived.map((attachment) => [identity(attachment), attachment]));
  const merged = (existing ?? []).map((attachment) =>
    archivedByIdentity.get(identity(attachment)) ?? attachment);
  const mergedIdentities = new Set(merged.map(identity));
  for (const attachment of archived) {
    if (!mergedIdentities.has(identity(attachment))) merged.push(attachment);
  }
  return merged;
}

function identity(attachment: Attachment): string {
  return `${attachment.filename}\u0000${attachment.source_uri ?? attachment.url ?? ""}`;
}

function attachmentScore(filename: string): number {
  let score = 0;
  if (/(공\s*고|모집공고|모집요강|사업\s*안내|통합공고|공고문)/i.test(filename)) score += 5;
  if (/(신청서|지원서|사업\s*계획서|양식|서식|서약서|동의서|확약서|별지|증빙)/i.test(filename)) score -= 4;
  if (/\.(?:hwp|hwpx|pdf|docx|txt|zip|xlsx|pptx)$/i.test(filename)) score += 1;
  return score;
}
