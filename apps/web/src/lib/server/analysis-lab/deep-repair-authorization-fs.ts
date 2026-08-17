import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type {
  DeepRepairAuthorizationRepository,
  DeepRepairAuthorizationStoredArtifact,
} from "./deep-repair-authorization";
import {
  claimImmutableBytesAtomic,
  writeImmutableBytesAtomic,
} from "./immutable-artifact-fs";
import { analysisLabDir } from "./run-store";
import { ACTIVE_DEEP_REPAIR_SERIES_ID } from "./deep-repair-formal-policy";

const SHA256 = /^[a-f0-9]{64}$/u;
const COHORT_PREFIX = "spike-out/analysis-lab/experiments/cohorts/";
const PROPOSAL_PREFIX = "spike-out/analysis-lab/experiments/proposals/";
const SERIES_MARKER_PATH = `spike-out/analysis-lab/experiments/series/${ACTIVE_DEEP_REPAIR_SERIES_ID}.json`;

export function createDeepRepairAuthorizationFilesystemRepository(options: {
  readonly rootDir?: string;
} = {}): DeepRepairAuthorizationRepository {
  const rootDir = resolve(options.rootDir ?? join(analysisLabDir(), "experiments"));
  const cohortRoot = join(rootDir, "cohorts");
  return {
    readApproval: (sha256) => readArtifact(join(rootDir, "approvals", `${safeSha(sha256)}.json`)),
    readSeriesMarker: () => readArtifact(
      join(rootDir, "series", `${ACTIVE_DEEP_REPAIR_SERIES_ID}.json`),
      SERIES_MARKER_PATH,
    ),
    readProposal: (sha256) => readArtifact(
      join(rootDir, "proposals", `${safeSha(sha256)}.json`),
      `${PROPOSAL_PREFIX}${sha256}.json`,
    ),
    readPlan: (sha256) => readArtifact(join(rootDir, "plans", `${safeSha(sha256)}.json`)),
    async readCohort(path) {
      if (!path.startsWith(COHORT_PREFIX)) return null;
      const suffix = path.slice(COHORT_PREFIX.length);
      const segments = suffix.split("/");
      if (
        !suffix
        || suffix.startsWith("/")
        || suffix.includes("\\")
        || segments.some((segment) => !segment || segment === "." || segment === "..")
      ) return null;
      const resolved = resolve(cohortRoot, suffix);
      if (!isWithin(cohortRoot, resolved)) return null;
      return readArtifact(resolved, path);
    },
    readLiveReceipt: (sha256) => readArtifact(
      join(rootDir, "receipts", `${safeSha(sha256)}.json`),
    ),
    readAttemptStart: (planSha256, sequence) => readArtifact(
      join(rootDir, "attempts", safeSha(planSha256), safeSequence(sequence), "claim.json"),
    ),
    readAttemptTerminal: (planSha256, sequence) => readArtifact(
      join(rootDir, "attempts", safeSha(planSha256), safeSequence(sequence), "resolution.json"),
    ),
    readResumeAttemptStart: (planSha256, sequence, resumeOfReceiptSha256) => readArtifact(
      join(
        rootDir,
        "attempts",
        safeSha(planSha256),
        safeSequence(sequence),
        "resumes",
        safeSha(resumeOfReceiptSha256),
        "claim.json",
      ),
    ),
    readOperationalEvidence: (sha256) => readArtifact(
      join(rootDir, "operational-evidence", `${safeSha(sha256)}.json`),
    ),
    readAuthority: (sha256) => readArtifact(
      join(rootDir, "authorities", `${safeSha(sha256)}.json`),
    ),
    readIssuance: (approvalSha256) => readArtifact(
      join(rootDir, "issued-authorities", `${safeSha(approvalSha256)}.json`),
    ),
    writeOperationalEvidence: (sha256, bytes) => writeContentAddressed(
      join(rootDir, "operational-evidence", `${safeSha(sha256)}.json`),
      sha256,
      bytes,
    ),
    writeAuthority: (sha256, bytes) => writeContentAddressed(
      join(rootDir, "authorities", `${safeSha(sha256)}.json`),
      sha256,
      bytes,
    ),
    async claimIssuance(approvalSha256, bytes) {
      const path = join(rootDir, "issued-authorities", `${safeSha(approvalSha256)}.json`);
      return claimImmutableBytesAtomic(path, bytes);
    },
  };
}

async function readArtifact(
  path: string,
  reportedPath = path,
): Promise<DeepRepairAuthorizationStoredArtifact | null> {
  try {
    return { path: reportedPath, bytes: await readFile(path) };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function writeContentAddressed(
  path: string,
  expectedSha256: string,
  bytes: Uint8Array,
): Promise<void> {
  if (rawSha256(bytes) !== expectedSha256) {
    throw new Error(`content address raw SHA-256 mismatch: ${path}`);
  }
  await writeImmutableBytesAtomic(path, bytes);
}

function safeSha(value: string): string {
  if (!SHA256.test(value)) throw new Error(`invalid SHA-256 path segment: ${value}`);
  return value;
}

function safeSequence(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 29) {
    throw new Error(`invalid experiment sequence: ${value}`);
  }
  return String(value).padStart(2, "0");
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
