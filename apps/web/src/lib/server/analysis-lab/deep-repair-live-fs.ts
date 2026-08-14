import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { analysisLabDir } from "./run-store";
import type {
  DeepRepairLiveArtifactRepository,
  DeepRepairLiveReceipt,
  DeepRepairLiveStoredArtifact,
} from "./deep-repair-live-experiment";
import type { DeepRepairExperimentReceipt } from "./deep-repair-experiment";
import {
  claimImmutableBytesAtomic,
  writeImmutableBytesAtomic,
} from "./immutable-artifact-fs";

const SHA256 = /^[a-f0-9]{64}$/;
const COHORT_LOGICAL_PREFIX = "spike-out/analysis-lab/experiments/cohorts/";

export function createDeepRepairLiveFilesystemRepository(options: {
  readonly rootDir?: string;
} = {}): DeepRepairLiveArtifactRepository {
  const rootDir = resolve(options.rootDir ?? join(analysisLabDir(), "experiments"));
  const cohortRootDir = join(rootDir, "cohorts");

  return {
    readAuthority: (sha256) => readStoredArtifact(join(rootDir, "authorities", `${safeSha(sha256)}.json`)),
    readApproval: (sha256) => readStoredArtifact(join(rootDir, "approvals", `${safeSha(sha256)}.json`)),
    readIssuance: (approvalSha256) =>
      readStoredArtifact(join(rootDir, "issued-authorities", `${safeSha(approvalSha256)}.json`)),
    readOperationalEvidence: (sha256) =>
      readStoredArtifact(join(rootDir, "operational-evidence", `${safeSha(sha256)}.json`)),
    readPlan: (sha256) => readStoredArtifact(join(rootDir, "plans", `${safeSha(sha256)}.json`)),
    async readCohort(path) {
      if (!path.startsWith(COHORT_LOGICAL_PREFIX)) return null;
      const suffix = path.slice(COHORT_LOGICAL_PREFIX.length);
      const segments = suffix.split("/");
      if (
        !suffix
        || suffix.startsWith("/")
        || suffix.includes("\\")
        || segments.some((segment) => segment === "" || segment === "." || segment === "..")
      ) return null;
      const resolvedPath = resolve(cohortRootDir, suffix);
      if (!isWithin(cohortRootDir, resolvedPath)) return null;
      return readStoredArtifact(resolvedPath, path);
    },
    readLiveReceipt: (sha256) =>
      readStoredArtifact(join(rootDir, "receipts", `${safeSha(sha256)}.json`)),
    readObservations: (sha256) =>
      readStoredArtifact(join(rootDir, "observations", `${safeSha(sha256)}.json`)),
    readEvaluatorReceipt: (sha256) =>
      readStoredArtifact(join(rootDir, "evaluator-receipts", `${safeSha(sha256)}.json`)),
    async readAttempt(key) {
      const attemptDir = attemptDirectory(rootDir, key);
      const start = await readStoredArtifact(join(attemptDir, "start.json"));
      if (!start) return null;
      return {
        start,
        terminal: await readStoredArtifact(join(attemptDir, "terminal.json")),
      };
    },
    async claimStart(key, start) {
      const attemptDir = attemptDirectory(rootDir, key);
      const path = join(attemptDir, "start.json");
      return claimImmutableBytesAtomic(path, encodeJson(start));
    },
    async writeObservations(sha256, value) {
      await writeImmutableJson(join(rootDir, "observations", `${safeSha(sha256)}.json`), value);
    },
    async writeEvaluatorReceipt(sha256, value: DeepRepairExperimentReceipt) {
      await writeImmutableJson(join(rootDir, "evaluator-receipts", `${safeSha(sha256)}.json`), value);
    },
    async commitTerminal(key, receiptSha256, value: DeepRepairLiveReceipt) {
      const attemptDir = attemptDirectory(rootDir, key);
      const startPath = join(attemptDir, "start.json");
      const terminalPath = join(attemptDir, "terminal.json");
      await access(startPath, constants.F_OK);
      const desired = encodeJson(value);
      const existing = await readBytesOrNull(terminalPath);
      if (existing) {
        if (Buffer.compare(existing, desired) === 0) {
          await writeImmutableBytesAtomic(
            join(rootDir, "receipts", `${safeSha(receiptSha256)}.json`),
            desired,
          );
          return;
        }
        throw new Error(`immutable artifact conflict: ${terminalPath}`);
      }
      await writeImmutableBytesAtomic(
        join(rootDir, "receipts", `${safeSha(receiptSha256)}.json`),
        desired,
      );
      await writeImmutableBytesAtomic(terminalPath, desired);
    },
  };
}

async function readStoredArtifact(path: string, reportedPath = path): Promise<DeepRepairLiveStoredArtifact | null> {
  const bytes = await readBytesOrNull(path);
  return bytes ? { path: reportedPath, bytes } : null;
}

async function readBytesOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await writeImmutableBytesAtomic(path, encodeJson(value));
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeSha(value: string): string {
  if (!SHA256.test(value)) throw new Error(`invalid SHA-256 path segment: ${value}`);
  return value;
}

function attemptDirectory(
  rootDir: string,
  key: { readonly planSha256: string; readonly sequence: number },
): string {
  if (!Number.isSafeInteger(key.sequence) || key.sequence < 0 || key.sequence > 29) {
    throw new Error(`invalid experiment sequence: ${key.sequence}`);
  }
  return join(rootDir, "attempts", safeSha(key.planSha256), String(key.sequence).padStart(2, "0"));
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
