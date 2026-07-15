import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  GRANT_ANALYSIS_EVALUATION_AS_OF,
  selectGrantAnalysisEvaluationCohort,
  verifyGrantAnalysisEvaluationManifestPair,
  type GrantAnalysisEvaluationExpectedReceipt,
  type GrantAnalysisEvaluationPublicManifest,
  type GrantAnalysisEvaluationSecretManifest,
} from "../ingestion/grantAnalysisEvaluationCohort";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

const POPULATION_SENTINEL = 5_001;
const DEFAULT_OUTPUT_DIR = "tmp/grant-analysis-evaluation/2026-07-15/cohort";
const PUBLIC_FILENAME = "public-manifest.json";
const SECRET_FILENAME = "secret-manifest.json";
const FROZEN_EXPECTED_RECEIPT = {
  canonicalCount: 1_720,
  duplicateInclusiveCount: 1_720,
  configuredLegacyKeyCount: 12,
  excludedCanonicalCount: 12,
} as const satisfies GrantAnalysisEvaluationExpectedReceipt;

loadMonorepoEnv();

await main().catch(() => {
  console.error(JSON.stringify({
    status: "failed",
    error: "evaluation cohort freeze failed",
    externalLlmCalls: 0,
    databaseWriteMode: false,
  }));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  assertSupportedArguments(process.argv.slice(2));
  const configuredSeed = process.env.GRANT_ANALYSIS_EVALUATION_COHORT_SEED;
  const seed = configuredSeed === undefined
    ? randomBytes(32).toString("hex")
    : configuredSeed;
  if (!/^[a-f0-9]{64}$/i.test(seed)) {
    throw new Error(
      "GRANT_ANALYSIS_EVALUATION_COHORT_SEED must be exactly 64 hexadecimal characters.",
    );
  }
  const outputDir = resolve(readArg("outputDir") ?? DEFAULT_OUTPUT_DIR);
  const overwrite = process.argv.includes("--overwrite");
  const publicPath = join(outputDir, PUBLIC_FILENAME);
  const secretPath = join(outputDir, SECRET_FILENAME);
  if (!overwrite && (await pathExists(publicPath) || await pathExists(secretPath))) {
    throw new Error("Evaluation cohort artifact already exists; pass --overwrite to replace it.");
  }

  const [{ getCunoteDb, closeCunoteDb }, { createDrizzleRepositories }] = await Promise.all([
    import("../db/client"),
    import("../repositories/drizzle"),
  ]);
  const db = getCunoteDb();
  try {
    const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
    const asOf = new Date(GRANT_ANALYSIS_EVALUATION_AS_OF);
    const canonicalEntries = await repositories.grants.listActiveGrants({
      asOf,
      limit: POPULATION_SENTINEL,
      includeConfirmedDuplicates: false,
    });
    const duplicateInclusiveEntries = await repositories.grants.listActiveGrants({
      asOf,
      limit: POPULATION_SENTINEL,
      includeConfirmedDuplicates: true,
    });
    if (canonicalEntries.length >= POPULATION_SENTINEL ||
      duplicateInclusiveEntries.length >= POPULATION_SENTINEL) {
      throw new Error("Evaluation population exceeded the 5000-record freeze boundary.");
    }

    const selection = selectGrantAnalysisEvaluationCohort({
      entries: canonicalEntries,
      duplicateInclusiveEntries,
      expectedReceipt: FROZEN_EXPECTED_RECEIPT,
      seed,
    });
    verifyGrantAnalysisEvaluationManifestPair(
      selection.publicManifest,
      selection.secretManifest,
      FROZEN_EXPECTED_RECEIPT,
    );
    await mkdir(outputDir, { recursive: true });
    await writeManifestAtomic(publicPath, selection.publicManifest, 0o644, overwrite);
    await writeManifestAtomic(secretPath, selection.secretManifest, 0o600, overwrite);
    const [writtenPublic, writtenSecret] = await Promise.all([
      readManifest<GrantAnalysisEvaluationPublicManifest>(publicPath),
      readManifest<GrantAnalysisEvaluationSecretManifest>(secretPath),
    ]);
    verifyGrantAnalysisEvaluationManifestPair(
      writtenPublic,
      writtenSecret,
      FROZEN_EXPECTED_RECEIPT,
    );
    console.log(JSON.stringify({
      status: "ok",
      asOf: GRANT_ANALYSIS_EVALUATION_AS_OF,
      canonicalPopulationCount: selection.publicManifest.population.canonicalCount,
      duplicateInclusivePopulationCount: selection.publicManifest.population.duplicateInclusiveCount,
      excludedLegacyCount: selection.publicManifest.exclusions.excludedCanonicalCount,
      validationCount: selection.publicManifest.validationCount,
      sealedCount: selection.publicManifest.sealedCount,
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

async function writeManifestAtomic(
  path: string,
  value: unknown,
  mode: number,
  overwrite: boolean,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode,
      flag: "wx",
    });
    if (overwrite) {
      await rename(temporary, path);
    } else {
      await link(temporary, path);
      await unlink(temporary);
    }
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
    if (argument === "--overwrite" || argument.startsWith("--outputDir=")) continue;
    throw new Error("Unsupported evaluation cohort freeze argument.");
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
