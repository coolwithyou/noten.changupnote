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

/**
 * 새 detail에서 다시 만든 첨부 목록에 기존 R2 보관 메타데이터를 되씌운다.
 *
 * detail 재수집 시 filename/url만 있는 객체로 raw.attachments를 덮어쓰면 이미 확보한
 * storage_key/sha256가 사라진다. 현재 detail에 없는 과거 첨부는 되살리지 않고,
 * 동일한 원본 정체성으로 확인되는 항목만 기존 보관본으로 교체한다.
 */
export function preserveArchivedKStartupAttachmentMetadata(
  fresh: GrantRaw["attachments"] | null | undefined,
  stored: GrantRaw["attachments"] | null | undefined,
): NonNullable<GrantRaw["attachments"]> {
  const storedByIdentity = new Map((stored ?? []).map((attachment) => [identity(attachment), attachment]));
  const freshAttachments = fresh ?? [];
  const merged = freshAttachments.map((attachment) => storedByIdentity.get(identity(attachment)) ?? attachment);
  const freshSourceUris = new Set(freshAttachments.map(sourceIdentity).filter(Boolean));

  // ZIP 내부에서 생성한 보관 항목은 source detail에 직접 나타나지 않는다. 부모 ZIP이
  // 여전히 현재 detail에 있을 때만 해당 자식들을 유지한다.
  const mergedIdentities = new Set(merged.map(identity));
  for (const attachment of stored ?? []) {
    const parentSource = nestedArchiveParentSource(attachment);
    if (!parentSource || !freshSourceUris.has(parentSource) || mergedIdentities.has(identity(attachment))) continue;
    merged.push(attachment);
    mergedIdentities.add(identity(attachment));
  }
  return merged;
}

function identity(attachment: Attachment): string {
  return `${attachment.filename}\u0000${attachment.source_uri ?? attachment.url ?? ""}`;
}

function sourceIdentity(attachment: Attachment): string {
  return attachment.source_uri ?? attachment.url ?? "";
}

function nestedArchiveParentSource(attachment: Attachment): string | null {
  const sourceUri = attachment.source_uri ?? "";
  if (!sourceUri.startsWith("zip:")) return null;
  const hashIndex = sourceUri.indexOf("#", 4);
  return hashIndex >= 0 ? sourceUri.slice(4, hashIndex) : sourceUri.slice(4);
}

function attachmentScore(filename: string): number {
  let score = 0;
  if (/(공\s*고|모집공고|모집요강|사업\s*안내|통합공고|공고문)/i.test(filename)) score += 5;
  if (/(신청서|지원서|사업\s*계획서|양식|서식|서약서|동의서|확약서|별지|증빙)/i.test(filename)) score -= 4;
  if (/\.(?:hwp|hwpx|pdf|docx|txt|zip|xlsx|pptx)$/i.test(filename)) score += 1;
  return score;
}
