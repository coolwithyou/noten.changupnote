export type PublishedGrantRevisionKind = "new" | "unchanged" | "changed";

export interface PublishedGrantRevisionSnapshot {
  rawHash: string | null;
  matchingProjectionHash: string;
  attachments: unknown;
  parserVersion: string | null;
  modelVer: string | null;
  promptVer: string | null;
}

export interface ConfirmedGrantLinkSnapshot {
  canonicalGrantId: string;
  memberGrantId: string;
}

/**
 * 원문뿐 아니라 criteria/파생 projection, 첨부 변환 상태와 추출기 버전도 매칭 입력 revision으로 취급한다.
 * collectedAt/updatedAt 같은 수집 시각은 의도적으로 비교하지 않는다.
 */
export function classifyPublishedGrantRevision(
  previous: PublishedGrantRevisionSnapshot | null,
  next: PublishedGrantRevisionSnapshot,
): PublishedGrantRevisionKind {
  if (!previous) return "new";
  return stableStringify(previous) === stableStringify(next) ? "unchanged" : "changed";
}

/** 서명 URL·수집 시각 변동은 제외하고 extraction readiness/content에 영향 주는 첨부 상태만 남긴다. */
export function matchingAttachmentRevisionProjection(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((item) => {
    const attachment = record(item);
    const conversion = record(attachment.conversion);
    return {
      filename: text(attachment.filename),
      sourceIdentity: text(attachment.source_uri) ?? text(attachment.url),
      archivePresent: Boolean(text(attachment.archive_url) || text(attachment.storage_key)),
      storageKey: text(attachment.storage_key),
      sha256: text(attachment.sha256),
      contentType: text(attachment.content_type),
      bytes: finiteNumber(attachment.bytes),
      conversion: {
        status: text(conversion.status),
        markdownPresent: Boolean(text(conversion.markdown_url) || text(conversion.markdown_storage_key)),
        markdownStorageKey: text(conversion.markdown_storage_key),
        markdownSha256: text(conversion.markdown_sha256),
        markdownBytes: finiteNumber(conversion.markdown_bytes),
        converter: text(conversion.converter),
        error: text(conversion.error),
      },
    };
  }).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

/**
 * confirmed dedup은 사용자에게 canonical 한 건으로 보이므로 member 변경도 canonical 상태를
 * 무효화해야 한다. 연결이 여러 단계인 경우를 위해 무방향 component 전체를 반환한다.
 */
export function expandConfirmedGrantComponentIds(
  seedGrantIds: string[],
  links: ConfirmedGrantLinkSnapshot[],
): string[] {
  const affected = new Set(seedGrantIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const link of links) {
      if (!affected.has(link.canonicalGrantId) && !affected.has(link.memberGrantId)) continue;
      if (!affected.has(link.canonicalGrantId)) {
        affected.add(link.canonicalGrantId);
        expanded = true;
      }
      if (!affected.has(link.memberGrantId)) {
        affected.add(link.memberGrantId);
        expanded = true;
      }
    }
  }
  return [...affected].sort();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
