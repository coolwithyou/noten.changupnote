import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  DeepRepairRecoveryRepository,
  DeepRepairRecoveryStoredArtifact,
} from "./deep-repair-recovery";
import {
  claimImmutableBytesAtomic,
  writeImmutableBytesAtomic,
} from "./immutable-artifact-fs";
import { analysisLabDir } from "./run-store";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function createDeepRepairRecoveryFilesystemRepository(options: {
  readonly rootDir?: string;
} = {}): DeepRepairRecoveryRepository {
  const rootDir = resolve(options.rootDir ?? join(analysisLabDir(), "experiments"));
  return {
    readRecoveryApproval: (sha256) => readArtifact(
      join(rootDir, "recovery-approvals", `${safeSha(sha256)}.json`),
    ),
    readAuthority: (sha256) => readArtifact(
      join(rootDir, "authorities", `${safeSha(sha256)}.json`),
    ),
    readIssuance: (approvalSha256) => readArtifact(
      join(rootDir, "issued-authorities", `${safeSha(approvalSha256)}.json`),
    ),
    readPlan: (planSha256) => readArtifact(
      join(rootDir, "plans", `${safeSha(planSha256)}.json`),
    ),
    readLiveReceipt: (sha256) => readArtifact(
      join(rootDir, "receipts", `${safeSha(sha256)}.json`),
    ),
    async readAttempt(key) {
      const directory = attemptDirectory(rootDir, key);
      const [claim, resolution] = await Promise.all([
        readArtifact(join(directory, "claim.json")),
        readArtifact(join(directory, "resolution.json")),
      ]);
      return { claim, resolution };
    },
    readRuntimeCleanup: (key) => readArtifact(
      join(attemptDirectory(rootDir, key), "runtime-cleanup.json"),
    ),
    readRecoveryReceipt: (sha256) => readArtifact(
      join(rootDir, "recovery-receipts", `${safeSha(sha256)}.json`),
    ),
    writeRecoveryReceipt: (sha256, bytes) => writeImmutableBytesAtomic(
      join(rootDir, "recovery-receipts", `${safeSha(sha256)}.json`),
      bytes,
    ),
    claimAttemptResolution: (key, bytes) => claimImmutableBytesAtomic(
      join(attemptDirectory(rootDir, key), "resolution.json"),
      bytes,
    ),
    claimRuntimeCleanup: (key, bytes) => claimImmutableBytesAtomic(
      join(attemptDirectory(rootDir, key), "runtime-cleanup.json"),
      bytes,
    ),
  };
}

async function readArtifact(path: string): Promise<DeepRepairRecoveryStoredArtifact | null> {
  try {
    return { path, bytes: await readFile(path) };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function attemptDirectory(
  rootDir: string,
  key: { readonly planSha256: string; readonly sequence: number },
): string {
  if (!Number.isSafeInteger(key.sequence) || key.sequence < 0 || key.sequence > 29) {
    throw new Error(`invalid experiment sequence: ${key.sequence}`);
  }
  return join(
    rootDir,
    "attempts",
    safeSha(key.planSha256),
    String(key.sequence).padStart(2, "0"),
  );
}

function safeSha(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`invalid SHA-256 path segment: ${value}`);
  return value;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
