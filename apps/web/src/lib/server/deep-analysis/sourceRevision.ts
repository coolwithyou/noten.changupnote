import { createHash } from "node:crypto";

export interface DeepAnalysisSourceRevisionInput {
  grant: Record<string, unknown>;
  rawHash: string | null;
  attachments: Array<{
    sourceUri: string;
    filename: string;
    sha256: string | null;
    markdownSha256: string | null;
    conversionStatus: string | null;
  }>;
}

/**
 * 공고 구조화 필드, 원문 hash, 첨부 inventory를 함께 봉인한다. 배열 순서는 source URI와
 * 파일명으로 정규화하므로 수집 순서가 달라져도 같은 revision을 만든다.
 */
export function buildDeepAnalysisSourceRevision(
  input: DeepAnalysisSourceRevisionInput,
): { canonicalJson: string; sha256: string } {
  const normalized = {
    schema: "deep-analysis-source-revision-v1",
    grant: input.grant,
    rawHash: input.rawHash,
    attachments: [...input.attachments].sort((left, right) => (
      `${left.sourceUri}\u0000${left.filename}`.localeCompare(
        `${right.sourceUri}\u0000${right.filename}`,
      )
    )),
  };
  const canonicalJson = stableJson(normalized);
  return {
    canonicalJson,
    sha256: sha256Hex(canonicalJson),
  };
}

export function buildAttachmentManifestSha256(manifest: unknown): string {
  return sha256Hex(stableJson(manifest));
}

export function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot contain ${typeof value}`);
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
