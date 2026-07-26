import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { sha256Hex } from "./sourceRevision";

export const DEEP_ANALYSIS_ARTIFACT_KINDS = [
  "input",
  "raw-response",
  "normalized-output",
  "stage-evidence",
  "audit",
  "promotion",
] as const;

export type DeepAnalysisArtifactKind = (typeof DEEP_ANALYSIS_ARTIFACT_KINDS)[number];
export type AggregateSplitArtifactKind = "input" | "manifest" | "raw-response";

export interface DeepAnalysisArtifactIdentity {
  grantId: string;
  sourceRevisionSha256: string;
  runId: string;
  kind: DeepAnalysisArtifactKind;
  contentSha256: string;
  extension: "json" | "jsonl" | "txt";
}

export function deepAnalysisArtifactKey(identity: DeepAnalysisArtifactIdentity): string {
  assertSafePathSegment(identity.grantId, "grantId");
  assertSha256(identity.sourceRevisionSha256, "sourceRevisionSha256");
  assertSafePathSegment(identity.runId, "runId");
  assertSha256(identity.contentSha256, "contentSha256");
  return [
    "deep-analysis",
    "v1",
    "grants",
    identity.grantId,
    "revisions",
    identity.sourceRevisionSha256,
    "runs",
    identity.runId,
    `${identity.kind}-${identity.contentSha256}.${identity.extension}`,
  ].join("/");
}

/**
 * 내용 hash가 포함된 키만 쓰고, 기존 객체는 덮어쓰지 않는다. 업로드 직후 다시 읽어
 * hash를 대조해 DB receipt가 가리킬 수 있는 검증된 key만 반환한다.
 */
export async function putImmutableDeepAnalysisArtifact(input: {
  storage: R2ObjectStorage;
  identity: Omit<DeepAnalysisArtifactIdentity, "contentSha256">;
  body: Buffer | string;
  contentType: string;
}): Promise<{ key: string; sha256: string; bytes: number; reused: boolean }> {
  const bytes = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, "utf8");
  const sha256 = sha256Hex(bytes);
  const key = deepAnalysisArtifactKey({ ...input.identity, contentSha256: sha256 });
  const existed = await input.storage.objectExists(key);
  if (!existed) {
    await input.storage.putObject({
      key,
      body: bytes,
      contentType: input.contentType,
    });
  }
  const stored = await input.storage.getObjectBytes(key);
  const storedSha256 = sha256Hex(stored.body);
  if (storedSha256 !== sha256) {
    throw new Error(`Immutable artifact hash mismatch for ${key}`);
  }
  return { key, sha256, bytes: bytes.length, reused: existed };
}

export function aggregateSplitArtifactKey(input: {
  grantId: string;
  sourceRevisionSha256: string;
  caseId: string;
  kind: AggregateSplitArtifactKind;
  contentSha256: string;
}): string {
  assertSafePathSegment(input.grantId, "grantId");
  assertSha256(input.sourceRevisionSha256, "sourceRevisionSha256");
  assertSafePathSegment(input.caseId, "caseId");
  assertSha256(input.contentSha256, "contentSha256");
  return [
    "deep-analysis",
    "v1",
    "grants",
    input.grantId,
    "revisions",
    input.sourceRevisionSha256,
    "aggregate-splits",
    input.caseId,
    `${input.kind}-${input.contentSha256}.json`,
  ].join("/");
}

export async function putImmutableAggregateSplitArtifact(input: {
  storage: R2ObjectStorage;
  identity: {
    grantId: string;
    sourceRevisionSha256: string;
    caseId: string;
    kind: AggregateSplitArtifactKind;
  };
  body: Buffer | string;
}): Promise<{ key: string; sha256: string; bytes: number; reused: boolean }> {
  const bytes = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, "utf8");
  const sha256 = sha256Hex(bytes);
  const key = aggregateSplitArtifactKey({
    ...input.identity,
    contentSha256: sha256,
  });
  const existed = await input.storage.objectExists(key);
  if (!existed) {
    await input.storage.putObject({
      key,
      body: bytes,
      contentType: "application/json",
    });
  }
  const stored = await input.storage.getObjectBytes(key);
  if (sha256Hex(stored.body) !== sha256) {
    throw new Error(`Immutable aggregate split artifact hash mismatch for ${key}`);
  }
  return { key, sha256, bytes: bytes.length, reused: existed };
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
}

function assertSafePathSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} is not a safe artifact path segment`);
  }
}
