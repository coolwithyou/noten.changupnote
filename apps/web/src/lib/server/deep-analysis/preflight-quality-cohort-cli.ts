import { randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildGrantAnalysisAttachmentSummary,
  buildGrantAnalysisSourceRevision,
} from "@/lib/server/ingestion/grantAnalysisEvaluationCohort";
import { hashGrantRawPayload } from "@/lib/server/ingestion/grantRawHash";
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createDrizzleRepositories } from "@/lib/server/repositories/drizzle";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { renderDeepAnalysisChunks } from "./analyzer";
import { prepareDeepAnalysisInput } from "./prepareInput";
import {
  FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
  buildDeepAnalysisQualitySourceContentSha256,
  verifyDeepAnalysisQualityManifestPair,
  type DeepAnalysisQualityCohortEntry,
  type DeepAnalysisQualityPublicManifest,
  type DeepAnalysisQualitySecretManifest,
} from "./qualityCohort";
import {
  buildDeepAnalysisQualityPreflightReceipt,
  verifyDeepAnalysisQualityPreflightReceipt,
  type DeepAnalysisQualityPreflightBlockerCode,
  type DeepAnalysisQualityPreflightObservation,
  type DeepAnalysisQualityPreflightReceipt,
  type DeepAnalysisQualityPreflightSnapshotDriftCode,
} from "./qualityPreflight";
import { resolveDeepAnalysisWorkerPolicy } from "./workerPolicy";

const DEFAULT_COHORT_DIR = "tmp/deep-analysis-quality/2026-07-25/frozen-80";
const DEFAULT_OUTPUT_DIR =
  "tmp/deep-analysis-quality/2026-07-25/frozen-80-preflight";
const RECEIPT_FILENAME = "receipt.json";

loadMonorepoEnv();

async function main(): Promise<void> {
  assertSupportedArguments(process.argv.slice(2));
  const cohortDir = resolve(readArg("cohort-dir") ?? DEFAULT_COHORT_DIR);
  const outputDir = resolve(readArg("output-dir") ?? DEFAULT_OUTPUT_DIR);
  const receiptPath = join(outputDir, RECEIPT_FILENAME);
  if (await pathExists(receiptPath)) {
    throw new Error("Deep analysis quality preflight artifact already exists.");
  }
  const frozenPublicManifest = await readJson<DeepAnalysisQualityPublicManifest>(
    join(cohortDir, "public-manifest.json"),
  );
  const frozenSecretPath = join(cohortDir, "secret-manifest.json");
  const frozenSecretManifest = await readJson<DeepAnalysisQualitySecretManifest>(
    frozenSecretPath,
  );
  if (((await stat(frozenSecretPath)).mode & 0o777) !== 0o600) {
    throw new Error("Frozen deep analysis quality secret manifest must use mode 0600.");
  }
  verifyDeepAnalysisQualityManifestPair(
    frozenPublicManifest,
    frozenSecretManifest,
    FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
  );

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 configuration is required for quality preflight.");
  const db = getCunoteDb();
  const repositories = createDrizzleRepositories<unknown>({
    dialect: "drizzle",
    client: db,
  });
  const policy = resolveDeepAnalysisWorkerPolicy({
    ...process.env,
    DEEP_ANALYSIS_WORKER_MODE: "observe_only",
  });
  try {
    const observations = await mapWithConcurrency(
      frozenSecretManifest.selected,
      numberArg("concurrency", 4, 1, 8),
      async (frozen) => inspectFrozenItem({
        frozen,
        repositories,
        db,
        storage,
        maxTotalInputChars: policy.maxTotalInputChars,
      }),
    );
    const receipt = buildDeepAnalysisQualityPreflightReceipt({
      generatedAt: new Date().toISOString(),
      frozenPublicManifest,
      frozenSecretManifest,
      primaryModel: policy.primaryModel,
      auditModel: policy.auditModel,
      maxTotalInputChars: policy.maxTotalInputChars,
      perNoticeCostCapUsd: policy.perNoticeCostCapUsd,
      dailyCostCapUsd: policy.dailyCostCapUsd,
      observations,
    });
    verifyDeepAnalysisQualityPreflightReceipt({
      frozenPublicManifest,
      frozenSecretManifest,
      receipt,
    });
    await mkdir(outputDir, { recursive: true });
    await writeReceiptExclusive(receiptPath, receipt);
    const written = await readJson<DeepAnalysisQualityPreflightReceipt>(receiptPath);
    verifyDeepAnalysisQualityPreflightReceipt({
      frozenPublicManifest,
      frozenSecretManifest,
      receipt: written,
    });
    console.log(JSON.stringify({
      status: written.inputReadinessVerdict,
      qualityVerdict: written.qualityVerdict,
      ...written.summary,
      primaryModel: written.policy.primaryModel,
      auditModel: written.policy.auditModel,
      receiptSha256: written.manifestSha256,
      artifactWritten: RECEIPT_FILENAME,
      executionAuthorized: written.executionAuthorized,
      externalLlmCalls: written.externalLlmCalls,
      databaseWriteMode: written.databaseWriteMode,
      objectStorageWriteMode: written.objectStorageWriteMode,
    }));
    if (written.inputReadinessVerdict !== "PASS") process.exitCode = 2;
  } finally {
    await closeCunoteDb();
  }
}

async function inspectFrozenItem(input: {
  frozen: DeepAnalysisQualityCohortEntry;
  repositories: ReturnType<typeof createDrizzleRepositories<unknown>>;
  db: ReturnType<typeof getCunoteDb>;
  storage: NonNullable<ReturnType<typeof createR2ObjectStorageFromEnv>>;
  maxTotalInputChars: number;
}): Promise<DeepAnalysisQualityPreflightObservation> {
  const base = emptyObservation(input.frozen);
  try {
    const current = await input.repositories.grants.findGrantById(
      `${input.frozen.source}:${input.frozen.sourceId}`,
    );
    if (!current) return { ...base, blockerCodes: ["frozen_grant_missing"] };
    const blockerCodes: DeepAnalysisQualityPreflightBlockerCode[] = [];
    const snapshotDriftCodes: DeepAnalysisQualityPreflightSnapshotDriftCode[] = [];
    if (
      current.grant.source !== input.frozen.source
      || current.grant.source_id !== input.frozen.sourceId
    ) {
      blockerCodes.push("frozen_identity_mismatch");
    }
    if (current.grant.id !== input.frozen.canonicalId) {
      blockerCodes.push("frozen_canonical_id_mismatch");
    }
    const rawPayloadSha256 = hashGrantRawPayload(current.raw.payload);
    if (rawPayloadSha256 !== input.frozen.rawPayloadSha256) {
      blockerCodes.push("frozen_raw_payload_changed");
    }
    const attachmentSummary = buildGrantAnalysisAttachmentSummary(current.raw);
    const frozenSourceContentSha256 = buildDeepAnalysisQualitySourceContentSha256({
      rawPayloadSha256: input.frozen.rawPayloadSha256,
      attachmentSummary: input.frozen.attachmentSummary,
    });
    const observedSourceContentSha256 = buildDeepAnalysisQualitySourceContentSha256({
      rawPayloadSha256,
      attachmentSummary,
    });
    const sourceContentMatched =
      observedSourceContentSha256 === frozenSourceContentSha256;
    if (!sourceContentMatched) {
      blockerCodes.push("frozen_source_content_changed");
    }
    if (
      attachmentSummary.attachmentSummarySha256
      !== input.frozen.attachmentSummary.attachmentSummarySha256
    ) {
      snapshotDriftCodes.push("frozen_attachment_summary_changed");
    }
    const selectorRevisionSha256 = buildGrantAnalysisSourceRevision({
      source: input.frozen.source,
      sourceId: input.frozen.sourceId,
      rawPayloadSha256,
      attachmentSummarySha256: attachmentSummary.attachmentSummarySha256,
    });
    if (selectorRevisionSha256 !== input.frozen.sourceRevisionSha256) {
      snapshotDriftCodes.push("frozen_selector_revision_changed");
    }
    if (!current.grant.id) {
      return {
        ...base,
        sourceContentMatched,
        observedSourceContentSha256,
        observedSelectorRevisionSha256: selectorRevisionSha256,
        snapshotDriftCodes: unique(snapshotDriftCodes),
        blockerCodes: unique(blockerCodes.concat("frozen_canonical_id_mismatch")),
      };
    }
    const seal = await prepareDeepAnalysisInput({
      db: input.db,
      storage: input.storage,
      grantId: current.grant.id,
      maxTotalChars: input.maxTotalInputChars,
    });
    if (!seal.sealed) blockerCodes.push("production_input_not_sealed");
    return {
      ...base,
      frozenSnapshotMatched:
        sourceContentMatched && snapshotDriftCodes.length === 0,
      sourceContentMatched,
      observedSourceContentSha256,
      observedSelectorRevisionSha256: selectorRevisionSha256,
      productionSourceRevisionSha256: seal.sourceRevisionSha256,
      attachmentManifestSha256: seal.attachmentManifestSha256,
      inputSha256: seal.inputSha256,
      currentInputSealed: seal.sealed,
      totalChars: seal.totalChars,
      evidenceChars: renderDeepAnalysisChunks(seal.chunks).length,
      attachmentCount: seal.attachments.length,
      includedAttachmentCount: seal.attachments.filter(
        (attachment) => attachment.disposition === "included",
      ).length,
      chunkCount: seal.chunks.length,
      dispositionCounts: countValues(
        seal.attachments.map((attachment) => attachment.disposition),
      ),
      snapshotDriftCodes: unique(snapshotDriftCodes),
      blockerCodes: unique(blockerCodes),
      productionBlockerCodes: unique(seal.blockers.map((blocker) => blocker.code)),
    };
  } catch {
    return { ...base, blockerCodes: ["preflight_error"] };
  }
}

function emptyObservation(
  frozen: DeepAnalysisQualityCohortEntry,
): DeepAnalysisQualityPreflightObservation {
  return {
    source: frozen.source,
    sourceId: frozen.sourceId,
    canonicalId: frozen.canonicalId,
    opaqueCommitmentSha256: frozen.opaqueCommitmentSha256,
    split: frozen.split,
    frozenSnapshotMatched: false,
    sourceContentMatched: false,
    frozenSourceContentSha256: buildDeepAnalysisQualitySourceContentSha256({
      rawPayloadSha256: frozen.rawPayloadSha256,
      attachmentSummary: frozen.attachmentSummary,
    }),
    observedSourceContentSha256: null,
    observedSelectorRevisionSha256: null,
    productionSourceRevisionSha256: null,
    attachmentManifestSha256: null,
    inputSha256: null,
    currentInputSealed: false,
    totalChars: 0,
    evidenceChars: 0,
    attachmentCount: 0,
    includedAttachmentCount: 0,
    chunkCount: 0,
    dispositionCounts: {},
    snapshotDriftCodes: [],
    blockerCodes: [],
    productionBlockerCodes: [],
  };
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await run(values[index]!);
      }
    },
  ));
  return results;
}

async function writeReceiptExclusive(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
    await link(temporary, path);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
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
    if (
      argument.startsWith("--cohort-dir=")
      || argument.startsWith("--output-dir=")
      || argument.startsWith("--concurrency=")
    ) continue;
    throw new Error("Unsupported deep analysis quality preflight argument.");
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function numberArg(name: string, fallback: number, min: number, max: number): number {
  const raw = readArg(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function countValues(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
    executionAuthorized: false,
    externalLlmCalls: 0,
    databaseWriteMode: false,
    objectStorageWriteMode: false,
  }));
  process.exitCode = 1;
});
