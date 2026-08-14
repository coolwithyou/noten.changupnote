import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { analysisLabDir } from "./run-store";

const LEGACY_COHORT_SNAPSHOT_FILE = /^cohort\..+\.json$/;
const PRIMARY_RUN_FILE = /^run-[0-9TZ.\-]{10,40}(?:-[a-f0-9]{4,8})?\.json$/;
const SERIES_MARKER_FILE = /^([a-z0-9][a-z0-9-]*)\.json$/;
const PROPOSAL_LOGICAL_PREFIX = "spike-out/analysis-lab/experiments/proposals/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * proposal이 재사용하면 안 되는 모든 과거 grantId를 strict하게 읽는다. 관련 JSON이 깨졌거나
 * content-address가 맞지 않으면 일부만 제외한 표본을 만들지 않고 즉시 실패한다.
 */
export async function readDeepRepairHistoricalGrantIds(options: {
  readonly rootDir?: string;
} = {}): Promise<string[]> {
  const root = options.rootDir ?? analysisLabDir();
  const ids = new Set<string>();
  const rootEntries = await readRequiredHistoryRoot(root);

  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    if (entry.name === "cohort.json" || LEGACY_COHORT_SNAPSHOT_FILE.test(entry.name)) {
      const label = `historical cohort ${entry.name}`;
      for (const grantId of await readLegacyCohortGrantIds(join(root, entry.name), label)) {
        ids.add(grantId);
      }
    }
  }

  for (const entry of rootEntries) {
    if (!entry.isDirectory() || !entry.name.includes("__")) continue;
    const runDir = join(root, entry.name);
    for (const file of await readDirectoryOrEmpty(runDir)) {
      if (!file.isFile() || !PRIMARY_RUN_FILE.test(file.name)) continue;
      const label = `historical run ${entry.name}/${file.name}`;
      const run = await readJsonRecord(join(runDir, file.name), label);
      ids.add(requiredGrantId(run.grantId, `${label}.grantId`));
    }
  }

  const seriesRoot = join(root, "experiments", "series");
  for (const entry of await readDirectoryOrEmpty(seriesRoot)) {
    if (!entry.isFile()) throw new Error(`unexpected experiment series entry: ${entry.name}`);
    const match = SERIES_MARKER_FILE.exec(entry.name);
    if (!match) throw new Error(`unexpected experiment series marker: ${entry.name}`);
    const marker = await readJsonRecord(
      join(seriesRoot, entry.name),
      `experiment series marker ${entry.name}`,
    );
    const proposalSha256 = requiredSha(
      marker.proposalSha256,
      `experiment series marker ${entry.name}.proposalSha256`,
    );
    requiredSha(marker.planSha256, `experiment series marker ${entry.name}.planSha256`);
    requiredSha(
      marker.planArtifactSha256,
      `experiment series marker ${entry.name}.planArtifactSha256`,
    );
    requiredSha(
      marker.manifestSha256,
      `experiment series marker ${entry.name}.manifestSha256`,
    );
    if (
      marker.schema !== "deep-repair-series-proposal-v1"
      || marker.seriesId !== match[1]
      || marker.proposalPath !== `${PROPOSAL_LOGICAL_PREFIX}${proposalSha256}.json`
    ) {
      throw new Error(`malformed experiment series marker: ${entry.name}`);
    }
    const proposalPath = join(root, "experiments", "proposals", `${proposalSha256}.json`);
    const proposalBytes = await readFile(proposalPath).catch((error: unknown) => {
      throw new Error(`cannot read committed experiment proposal ${proposalSha256}`, { cause: error });
    });
    if (createHash("sha256").update(proposalBytes).digest("hex") !== proposalSha256) {
      throw new Error(`experiment proposal content address mismatch: ${proposalPath}`);
    }
    const proposal = parseJsonRecord(proposalBytes, `experiment proposal ${proposalSha256}`);
    if (
      proposal.schema !== "deep-repair-proposal-v1"
      || !Array.isArray(proposal.sequence)
      || proposal.sequence.length === 0
    ) {
      throw new Error(`malformed experiment proposal: ${proposalSha256}`);
    }
    for (let index = 0; index < proposal.sequence.length; index += 1) {
      const target = asRecord(
        proposal.sequence[index],
        `experiment proposal ${proposalSha256}.sequence[${index}]`,
      );
      ids.add(requiredGrantId(
        target.grantId,
        `experiment proposal ${proposalSha256}.sequence[${index}].grantId`,
      ));
    }
  }

  return [...ids].sort();
}

async function readLegacyCohortGrantIds(path: string, label: string): Promise<string[]> {
  const cohort = await readJsonRecord(path, label);
  if (cohort.version === 2 && Array.isArray(cohort.entries)) {
    return cohort.entries.map((entry, index) => requiredGrantId(
      asRecord(entry, `${label}.entries[${index}]`).grantId,
      `${label}.entries[${index}].grantId`,
    ));
  }
  if (Array.isArray(cohort.grantIds)) {
    return cohort.grantIds.map((grantId, index) => requiredGrantId(
      grantId,
      `${label}.grantIds[${index}]`,
    ));
  }
  throw new Error(`malformed ${label}`);
}

async function readJsonRecord(path: string, label: string): Promise<Record<string, unknown>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`cannot read ${label}`, { cause: error });
  }
  return parseJsonRecord(bytes, label);
}

function parseJsonRecord(bytes: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label}`, { cause: error });
  }
  return asRecord(parsed, label);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredGrantId(value: unknown, label: string): string {
  const grantId = requiredText(value, label);
  if (!UUID.test(grantId)) throw new Error(`${label} must be a UUID: ${grantId}`);
  return grantId.toLowerCase();
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredText(value, label);
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error(`${label} must be a SHA-256`);
  return sha;
}

async function readDirectoryOrEmpty(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readRequiredHistoryRoot(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`analysis lab history root not found: ${path}`, { cause: error });
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
