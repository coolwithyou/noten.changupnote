import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createDrizzleRepositories } from "@/lib/server/repositories/drizzle";
import {
  DEEP_ANALYSIS_QUALITY_COHORT_AS_OF,
  DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS,
  FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
  selectDeepAnalysisQualityCohort,
  verifyDeepAnalysisQualityManifestPair,
  type DeepAnalysisQualityPublicManifest,
  type DeepAnalysisQualitySecretManifest,
} from "./qualityCohort";

const POPULATION_SENTINEL = 5_001;
const DEFAULT_OUTPUT_DIR =
  "tmp/deep-analysis-quality/2026-07-25/frozen-80";
const PUBLIC_FILENAME = "public-manifest.json";
const SECRET_FILENAME = "secret-manifest.json";

loadMonorepoEnv();

async function main(): Promise<void> {
  assertSupportedArguments(process.argv.slice(2));
  const seed = process.env.DEEP_ANALYSIS_QUALITY_COHORT_SEED?.trim()
    || randomBytes(32).toString("hex");
  if (!/^[0-9a-f]{64}$/i.test(seed)) {
    throw new Error(
      "DEEP_ANALYSIS_QUALITY_COHORT_SEED must be exactly 64 hexadecimal characters.",
    );
  }
  const outputDir = resolve(readArg("outputDir") ?? DEFAULT_OUTPUT_DIR);
  const publicPath = join(outputDir, PUBLIC_FILENAME);
  const secretPath = join(outputDir, SECRET_FILENAME);
  if (await pathExists(publicPath) || await pathExists(secretPath)) {
    throw new Error("Deep analysis quality cohort artifact already exists.");
  }

  const db = getCunoteDb();
  try {
    const repositories = createDrizzleRepositories<unknown>({
      dialect: "drizzle",
      client: db,
    });
    const asOf = new Date(DEEP_ANALYSIS_QUALITY_COHORT_AS_OF);
    const [activeEntries, duplicateInclusiveEntries, ...requiredRecoveryEntries] =
      await Promise.all([
        repositories.grants.listActiveGrants({
          asOf,
          limit: POPULATION_SENTINEL,
          includeConfirmedDuplicates: false,
        }),
        repositories.grants.listActiveGrants({
          asOf,
          limit: POPULATION_SENTINEL,
          includeConfirmedDuplicates: true,
        }),
        ...DEEP_ANALYSIS_QUALITY_REQUIRED_RECOVERY_KEYS.map(
          (key) => repositories.grants.findGrantById(key),
        ),
      ]);
    if (
      activeEntries.length >= POPULATION_SENTINEL
      || duplicateInclusiveEntries.length >= POPULATION_SENTINEL
    ) {
      throw new Error("Deep analysis quality population exceeded the freeze boundary.");
    }
    if (requiredRecoveryEntries.some((entry) => entry === null)) {
      throw new Error("One or more required deep analysis recovery fixtures are missing.");
    }

    const selection = selectDeepAnalysisQualityCohort({
      activeEntries,
      duplicateInclusiveEntries,
      requiredRecoveryEntries: requiredRecoveryEntries.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      ),
      expectedReceipt: FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
      seed,
    });
    verifyDeepAnalysisQualityManifestPair(
      selection.publicManifest,
      selection.secretManifest,
      FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
    );

    await mkdir(outputDir, { recursive: true });
    await writeManifestExclusive(publicPath, selection.publicManifest, 0o644);
    await writeManifestExclusive(secretPath, selection.secretManifest, 0o600);
    const [writtenPublic, writtenSecret] = await Promise.all([
      readManifest<DeepAnalysisQualityPublicManifest>(publicPath),
      readManifest<DeepAnalysisQualitySecretManifest>(secretPath),
    ]);
    verifyDeepAnalysisQualityManifestPair(
      writtenPublic,
      writtenSecret,
      FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
    );
    console.log(JSON.stringify({
      status: "PASS",
      asOf: writtenPublic.asOf,
      activeCanonicalCount: writtenPublic.population.activeCanonicalCount,
      activeDuplicateInclusiveCount: (
        writtenPublic.population.activeDuplicateInclusiveCount
      ),
      validationCount: writtenPublic.validationCount,
      sealedCount: writtenPublic.sealedCount,
      coverageCounts: writtenPublic.coverageCounts,
      manifestSha256: writtenPublic.manifestSha256,
      selectionCommitmentSha256: writtenPublic.selectionCommitmentSha256,
      artifactsWritten: [PUBLIC_FILENAME, SECRET_FILENAME],
      secretFileMode: "0600",
      externalLlmCalls: 0,
      databaseWriteMode: false,
    }));
  } finally {
    await closeCunoteDb();
  }
}

async function readManifest<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeManifestExclusive(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode,
      flag: "wx",
    });
    await link(temporary, path);
    await unlink(temporary);
    await chmod(path, mode);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSupportedArguments(arguments_: string[]): void {
  for (const argument of arguments_) {
    if (argument.startsWith("--outputDir=")) continue;
    throw new Error("Unsupported deep analysis quality cohort freeze argument.");
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
    externalLlmCalls: 0,
    databaseWriteMode: false,
  }));
  process.exitCode = 1;
});
