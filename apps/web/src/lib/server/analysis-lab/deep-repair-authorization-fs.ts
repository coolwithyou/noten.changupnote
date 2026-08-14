import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  DeepRepairAuthorizationRepository,
  DeepRepairAuthorizationStoredArtifact,
} from "./deep-repair-authorization";
import { analysisLabDir } from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/u;
const COHORT_PREFIX = "spike-out/analysis-lab/experiments/cohorts/";
const PROPOSAL_PREFIX = "spike-out/analysis-lab/experiments/proposals/";
const SERIES_MARKER_PATH = "spike-out/analysis-lab/experiments/series/deep-v18.json";

export function createDeepRepairAuthorizationFilesystemRepository(options: {
  readonly rootDir?: string;
} = {}): DeepRepairAuthorizationRepository {
  const rootDir = resolve(options.rootDir ?? join(analysisLabDir(), "experiments"));
  const cohortRoot = join(rootDir, "cohorts");
  return {
    readApproval: (sha256) => readArtifact(join(rootDir, "approvals", `${safeSha(sha256)}.json`)),
    readSeriesMarker: () => readArtifact(join(rootDir, "series", "deep-v18.json"), SERIES_MARKER_PATH),
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
      join(rootDir, "attempts", safeSha(planSha256), safeSequence(sequence), "start.json"),
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
      const directory = dirname(path);
      const temporaryPath = join(
        directory,
        `.issuance-${approvalSha256}-${randomUUID()}.tmp`,
      );
      const desired = Buffer.from(bytes);
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, desired, { flag: "wx" });
      try {
        try {
          // 완전히 기록된 같은-filesystem 임시 inode만 final path에 원자적으로 link한다.
          // 따라서 동시 loser가 EEXIST 직후 zero/partial marker를 읽을 수 없다.
          await link(temporaryPath, path);
        } catch (error) {
          if (isAlreadyExists(error)) return false;
          throw error;
        }
        const stored = await readFile(path);
        if (Buffer.compare(stored, desired) !== 0) {
          throw new Error(`immutable issuance read-back mismatch: ${path}`);
        }
        return true;
      } finally {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
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
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readFile(path);
    if (Buffer.compare(existing, Buffer.from(bytes)) !== 0) {
      throw new Error(`immutable artifact conflict: ${path}`);
    }
  }
  const stored = await readFile(path);
  if (Buffer.compare(stored, Buffer.from(bytes)) !== 0) {
    throw new Error(`immutable artifact read-back mismatch: ${path}`);
  }
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

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
