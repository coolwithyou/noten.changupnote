import { buildBizInfoProgramExtractionInput } from "@cunote/core";

type Attachment = Record<string, unknown>;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/** Recover source-declared references without downloading or inventing archive metadata.
 * A same-name file at a different URL is a new input, not proof of existing coverage. */
export function includeDeclaredAttachments(
  source: string,
  payload: Record<string, unknown> | null | undefined,
  existing: readonly Attachment[],
): Attachment[] {
  const result = [...existing];
  if (!payload) return result;
  const detail = payload.detail && typeof payload.detail === "object"
    ? payload.detail as Record<string, unknown> : {};
  const declared: Attachment[] = source === "bizinfo"
    ? buildBizInfoProgramExtractionInput({ ...payload, pblancId: text(payload.pblancId) }).metadata.attachments
    : source === "kstartup" && Array.isArray(detail.attachments)
      ? detail.attachments.filter((a): a is Attachment => Boolean(a) && typeof a === "object") : [];
  for (const attachment of declared) {
    const filename = text(attachment.filename);
    const url = text(attachment.source_uri) || text(attachment.url);
    if (!filename) continue;
    if (result.some(a => {
      const existingUrl = text(a.source_uri) || text(a.url);
      return url && existingUrl ? url === existingUrl : text(a.filename) === filename;
    })) continue;
    result.push({ filename, url: url || null });
  }
  return result;
}

/** Original-byte coverage only; text/image extraction coverage is checked by
 * input preparation. A single archived application form cannot cover a notice. */
export function declaredArchiveCoverage(
  declared: readonly Attachment[],
  archives: readonly { filename: string; sourceUri: string; storageKey: string | null; sha256: string | null }[],
): "not_required" | "complete" | "missing" {
  if (!declared.length && !archives.length) return "not_required";
  const stored = (a: typeof archives[number]) => Boolean(a.storageKey && a.sha256 && /^[a-f0-9]{64}$/u.test(a.sha256));
  if (archives.some(a => !stored(a))) return "missing";
  return declared.every(d => archives.some(a => {
    if (!stored(a)) return false;
    const url = text(d.source_uri) || text(d.url);
    return url ? url === a.sourceUri : text(d.filename) === a.filename;
  })) ? "complete" : "missing";
}
