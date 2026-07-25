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
import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import {
  parseGrantImageOcrProvider,
  resolveGrantImageOcrAdapter,
} from "@/lib/server/ingestion/grantImageOcrProviders";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
  verifyDeepAnalysisQualityManifestPair,
  type DeepAnalysisQualityPublicManifest,
  type DeepAnalysisQualitySecretManifest,
} from "./qualityCohort";
import {
  type DeepAnalysisInputPreparationTarget,
  resolveDeepAnalysisInputPreparationPolicy,
  runDeepAnalysisInputPreparation,
} from "./inputPreparation";
import {
  DEEP_ANALYSIS_QUALITY_INPUT_RECOVERY_CONFIRMATION,
  selectDeepAnalysisQualityInputRecoveryItems,
  selectDeepAnalysisQualityInputRecoveryRound,
} from "./qualityInputRecovery";
import {
  verifyDeepAnalysisQualityPreflightReceipt,
  type DeepAnalysisQualityPreflightReceipt,
} from "./qualityPreflight";
import { sha256Hex, stableJson } from "./sourceRevision";

const DEFAULT_COHORT_DIR = "tmp/deep-analysis-quality/2026-07-25/frozen-80";
const DEFAULT_PREFLIGHT_PATH =
  "tmp/deep-analysis-quality/2026-07-26/"
  + "frozen-80-preflight-v2-before-recovery/receipt.json";
const DEFAULT_OUTPUT_DIR =
  "tmp/deep-analysis-quality/2026-07-26/frozen-80-input-recovery";
const RECEIPT_FILENAME = "receipt.json";

interface RecoveryTarget extends DeepAnalysisInputPreparationTarget {
  opaqueCommitmentSha256: string;
}

loadMonorepoEnv();

async function main(): Promise<void> {
  assertSupportedArguments(process.argv.slice(2));
  const cohortDir = resolve(readArg("cohort-dir") ?? DEFAULT_COHORT_DIR);
  const preflightPath = resolve(readArg("preflight") ?? DEFAULT_PREFLIGHT_PATH);
  const outputDir = resolve(readArg("output-dir") ?? DEFAULT_OUTPUT_DIR);
  const execute = process.argv.includes("--execute");
  const confirmation = readArg("confirm");
  const rounds = numberArg("rounds", 3, 1, 3);
  const imageOcrProvider = parseGrantImageOcrProvider(readArg("image-ocr"));
  const imageOcr = resolveGrantImageOcrAdapter(imageOcrProvider);
  if (
    execute
    && confirmation !== DEEP_ANALYSIS_QUALITY_INPUT_RECOVERY_CONFIRMATION
  ) {
    throw new Error(
      `Quality input recovery execution requires --confirm=${
        DEEP_ANALYSIS_QUALITY_INPUT_RECOVERY_CONFIRMATION
      }.`,
    );
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
  const preflight = await readJson<DeepAnalysisQualityPreflightReceipt>(
    preflightPath,
  );
  verifyDeepAnalysisQualityPreflightReceipt({
    frozenPublicManifest,
    frozenSecretManifest,
    receipt: preflight,
  });
  const recoveryItems = selectDeepAnalysisQualityInputRecoveryItems(preflight);
  const frozenByCommitment = new Map(
    frozenSecretManifest.selected.map((entry) => [
      entry.opaqueCommitmentSha256,
      entry,
    ]),
  );
  const targets = recoveryItems.map((item): RecoveryTarget => {
    const frozen = frozenByCommitment.get(item.opaqueCommitmentSha256);
    if (!frozen || frozen.source !== item.source || frozen.split !== item.split) {
      throw new Error("Quality input recovery cannot resolve a frozen commitment.");
    }
    return {
      grantId: frozen.canonicalId,
      source: frozen.source,
      sourceId: frozen.sourceId,
      title: frozen.title,
      applyEnd: frozen.applyEnd ? new Date(frozen.applyEnd) : null,
      jobUpdatedAt: new Date(0),
      jobStatus: "quality_input_recovery",
      opaqueCommitmentSha256: frozen.opaqueCommitmentSha256,
    };
  });
  const preview = {
    status: execute ? "EXECUTION_REQUESTED" : "PREVIEW",
    frozenPublicManifestSha256: frozenPublicManifest.manifestSha256,
    preflightReceiptSha256: preflight.manifestSha256,
    targetCount: targets.length,
    targetsBySource: countSources(targets),
    blockerCounts: countStrings(
      recoveryItems.flatMap((item) => item.productionBlockerCodes),
    ),
    rounds,
    maxPerSourcePerRound: 20,
    imageOcrProvider,
    externalLlmCalls: 0,
    analysisJobsEnqueued: 0,
    databaseWriteMode: execute,
    objectStorageWriteMode: execute,
  };
  if (!execute) {
    console.log(JSON.stringify(preview));
    return;
  }
  if (await pathExists(join(outputDir, RECEIPT_FILENAME))) {
    throw new Error("Quality input recovery artifact already exists.");
  }
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 configuration is required for quality input recovery.");
  if (!process.env.CONVERSION_SERVER_URL?.trim()) {
    throw new Error("CONVERSION_SERVER_URL is required for quality input recovery.");
  }
  if (!process.env.CONVERSION_SHARED_SECRET?.trim()) {
    throw new Error("CONVERSION_SHARED_SECRET is required for quality input recovery.");
  }

  const db = getCunoteDb();
  const policy = resolveDeepAnalysisInputPreparationPolicy({
    ...process.env,
    DEEP_ANALYSIS_PREPARE_MAX_GRANTS_PER_SOURCE: "20",
    DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_GRANT: "10",
    DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_SOURCE: "200",
    DEEP_ANALYSIS_PREPARE_SCAN_LIMIT: "5000",
    DEEP_ANALYSIS_PREPARE_CONVERSION_LIMIT: "100",
    DEEP_ANALYSIS_PREPARE_DEADLINE_SECONDS: "900",
  });
  let remaining = [...targets];
  const roundReceipts = [];
  try {
    for (let round = 1; round <= rounds && remaining.length > 0; round += 1) {
      const selected = selectDeepAnalysisQualityInputRecoveryRound(remaining, 20);
      const selectedKeys = new Set(selected.map(targetKey));
      const unprocessed = remaining.filter((target) => !selectedKeys.has(targetKey(target)));
      const result = await runDeepAnalysisInputPreparation({
        db,
        storage,
        policy,
        enqueuePreparedJobs: false,
        archiveFetchTimeoutMs: 30_000,
        reprocessMissingMarkdown: true,
        archiveMaxEntries: 20,
        imageOcr,
        imageOcrName: imageOcrProvider,
        listTargets: async () => selected,
      });
      const sealedKeys = new Set(
        result.after.filter((item) => item.sealed).map(targetKey),
      );
      const unresolved = selected.filter((target) => !sealedKeys.has(targetKey(target)));
      remaining = [...unprocessed, ...unresolved];
      const roundReceipt = {
        round,
        targetCount: selected.length,
        targetsBySource: countSources(selected),
        archivedCandidateCount:
          (result.archive.kstartup?.batchCandidateCount ?? 0)
          + (result.archive.bizinfo?.batchCandidateCount ?? 0),
        selectedAttachmentCount:
          (result.archive.kstartup?.selectedAttachmentCount ?? 0)
          + (result.archive.bizinfo?.selectedAttachmentCount ?? 0),
        archiveSucceededCount:
          (result.archive.kstartup?.succeededCount ?? 0)
          + (result.archive.bizinfo?.succeededCount ?? 0),
        archiveFailedCount:
          (result.archive.kstartup?.failedCount ?? 0)
          + (result.archive.bizinfo?.failedCount ?? 0),
        conversionCandidateAttachmentCount:
          result.conversionRegistration.candidateAttachmentCount,
        conversionJobsEnqueued: result.conversionRegistration.jobsEnqueued,
        conversionCacheHits: result.conversionRegistration.cacheHits,
        conversionFailedCount: result.conversion.failed,
        conversionStillPendingCount: result.conversion.stillPending,
        sealedCount: result.sealedCount,
        unresolvedCount: result.unresolvedCount,
        remainingTargetCount: remaining.length,
        deadlineReached:
          Boolean(result.archive.kstartup?.deadlineReached)
          || Boolean(result.archive.bizinfo?.deadlineReached),
        budgetExhausted: result.conversion.budgetExhausted,
        elapsedMs: result.elapsedMs,
      };
      roundReceipts.push(roundReceipt);
      console.log(JSON.stringify({
        status: "ROUND_COMPLETE",
        ...roundReceipt,
        externalLlmCalls: 0,
        analysisJobsEnqueued: 0,
      }));
    }
  } finally {
    await closeCunoteDb();
  }

  const payload = {
    recordType: "deep_analysis_quality_input_recovery" as const,
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    frozenPublicManifestSha256: frozenPublicManifest.manifestSha256,
    frozenSecretManifestSha256: frozenSecretManifest.manifestSha256,
    preflightReceiptSha256: preflight.manifestSha256,
    confirmation: DEEP_ANALYSIS_QUALITY_INPUT_RECOVERY_CONFIRMATION,
    initialTargetCount: targets.length,
    initialTargetsBySource: countSources(targets),
    rounds: roundReceipts,
    recoveredTargetCount: targets.length - remaining.length,
    remainingTargetCount: remaining.length,
    remainingCommitments: remaining
      .map((target) => target.opaqueCommitmentSha256)
      .sort(),
    recoveryVerdict: remaining.length === 0 ? "COMPLETE" as const : "PARTIAL" as const,
    externalLlmCalls: 0 as const,
    analysisJobsEnqueued: 0 as const,
    databaseWriteMode: true as const,
    objectStorageWriteMode: true as const,
  };
  const receipt = {
    ...payload,
    receiptSha256: sha256Hex(stableJson(payload)),
  };
  await mkdir(outputDir, { recursive: true });
  await writeReceiptExclusive(join(outputDir, RECEIPT_FILENAME), receipt);
  console.log(JSON.stringify({
    status: receipt.recoveryVerdict,
    initialTargetCount: receipt.initialTargetCount,
    recoveredTargetCount: receipt.recoveredTargetCount,
    remainingTargetCount: receipt.remainingTargetCount,
    receiptSha256: receipt.receiptSha256,
    artifactWritten: RECEIPT_FILENAME,
    externalLlmCalls: receipt.externalLlmCalls,
    analysisJobsEnqueued: receipt.analysisJobsEnqueued,
    databaseWriteMode: receipt.databaseWriteMode,
    objectStorageWriteMode: receipt.objectStorageWriteMode,
  }));
  if (receipt.recoveryVerdict !== "COMPLETE") process.exitCode = 2;
}

function targetKey(target: {
  source: "kstartup" | "bizinfo";
  sourceId: string;
}): string {
  return `${target.source}:${target.sourceId}`;
}

function countSources(
  targets: readonly { source: "kstartup" | "bizinfo" }[],
): Record<"kstartup" | "bizinfo", number> {
  return {
    kstartup: targets.filter((target) => target.source === "kstartup").length,
    bizinfo: targets.filter((target) => target.source === "bizinfo").length,
  };
}

function countStrings(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
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
      argument === "--execute"
      || argument.startsWith("--confirm=")
      || argument.startsWith("--cohort-dir=")
      || argument.startsWith("--preflight=")
      || argument.startsWith("--output-dir=")
      || argument.startsWith("--rounds=")
      || argument.startsWith("--image-ocr=")
    ) continue;
    throw new Error("Unsupported deep analysis quality input recovery argument.");
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

main().catch((error) => {
  console.error(JSON.stringify({
    status: "FAIL",
    error: error instanceof Error ? error.message : String(error),
    externalLlmCalls: 0,
    analysisJobsEnqueued: 0,
  }));
  process.exitCode = 1;
});
