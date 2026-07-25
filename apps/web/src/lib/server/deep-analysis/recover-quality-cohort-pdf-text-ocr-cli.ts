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
  listPdfTextOcrRecoveryCandidates,
  recoverPdfTextOcrCandidates,
  type PdfTextOcrRecoveryTarget,
} from "./pdfTextOcrRecovery";
import {
  FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
  verifyDeepAnalysisQualityManifestPair,
  type DeepAnalysisQualityPublicManifest,
  type DeepAnalysisQualitySecretManifest,
} from "./qualityCohort";
import {
  selectDeepAnalysisQualityInputRecoveryItems,
} from "./qualityInputRecovery";
import {
  verifyDeepAnalysisQualityPreflightReceipt,
  type DeepAnalysisQualityPreflightReceipt,
} from "./qualityPreflight";
import { sha256Hex, stableJson } from "./sourceRevision";

const DEFAULT_COHORT_DIR = "tmp/deep-analysis-quality/2026-07-25/frozen-80";
const DEFAULT_PREFLIGHT_PATH =
  "tmp/deep-analysis-quality/2026-07-26/"
  + "frozen-80-preflight-after-container-identity-fix/receipt.json";
const DEFAULT_OUTPUT_DIR =
  "tmp/deep-analysis-quality/2026-07-26/frozen-80-pdf-text-ocr-recovery";
const RECEIPT_FILENAME = "receipt.json";
const CONFIRMATION = "RECOVER_DEEP_ANALYSIS_QUALITY_PDF_TEXT_OCR";

loadMonorepoEnv();

async function main(): Promise<void> {
  assertSupportedArguments(process.argv.slice(2));
  const cohortDir = resolve(readArg("cohort-dir") ?? DEFAULT_COHORT_DIR);
  const preflightPath = resolve(readArg("preflight") ?? DEFAULT_PREFLIGHT_PATH);
  const outputDir = resolve(readArg("output-dir") ?? DEFAULT_OUTPUT_DIR);
  const execute = process.argv.includes("--execute");
  const imageOcrProvider = parseGrantImageOcrProvider(readArg("image-ocr"));
  if (execute && readArg("confirm") !== CONFIRMATION) {
    throw new Error(`PDF recovery execution requires --confirm=${CONFIRMATION}.`);
  }
  if (execute && imageOcrProvider === "none") {
    throw new Error("PDF recovery execution requires --image-ocr.");
  }

  const publicManifest = await readJson<DeepAnalysisQualityPublicManifest>(
    join(cohortDir, "public-manifest.json"),
  );
  const secretPath = join(cohortDir, "secret-manifest.json");
  const secretManifest = await readJson<DeepAnalysisQualitySecretManifest>(
    secretPath,
  );
  if (((await stat(secretPath)).mode & 0o777) !== 0o600) {
    throw new Error("Frozen deep analysis quality secret manifest must use mode 0600.");
  }
  verifyDeepAnalysisQualityManifestPair(
    publicManifest,
    secretManifest,
    FROZEN_DEEP_ANALYSIS_QUALITY_EXPECTED_RECEIPT,
  );
  const preflight = await readJson<DeepAnalysisQualityPreflightReceipt>(
    preflightPath,
  );
  verifyDeepAnalysisQualityPreflightReceipt({
    frozenPublicManifest: publicManifest,
    frozenSecretManifest: secretManifest,
    receipt: preflight,
  });
  const recoveryItems = selectDeepAnalysisQualityInputRecoveryItems(preflight);
  if (
    recoveryItems.some((item) => (
      item.productionBlockerCodes.length !== 1
      || item.productionBlockerCodes[0] !== "blocked_conversion"
    ))
  ) {
    throw new Error("PDF recovery refuses non-conversion blockers.");
  }
  const frozenByCommitment = new Map(
    secretManifest.selected.map((entry) => [
      entry.opaqueCommitmentSha256,
      entry,
    ]),
  );
  const targets = recoveryItems.map((item): PdfTextOcrRecoveryTarget => {
    const frozen = frozenByCommitment.get(item.opaqueCommitmentSha256);
    if (!frozen || frozen.source !== item.source || frozen.split !== item.split) {
      throw new Error("PDF recovery cannot resolve a frozen commitment.");
    }
    return {
      grantId: frozen.canonicalId,
      source: frozen.source,
      sourceId: frozen.sourceId,
      opaqueCommitmentSha256: frozen.opaqueCommitmentSha256,
    };
  });

  const db = getCunoteDb();
  try {
    const candidates = await listPdfTextOcrRecoveryCandidates({ db, targets });
    const candidateCommitments = new Set(
      candidates.map((candidate) => candidate.target.opaqueCommitmentSha256),
    );
    if (
      candidates.length !== targets.length
      || candidateCommitments.size !== targets.length
    ) {
      throw new Error(
        "PDF recovery requires exactly one unconverted PDF surface per target.",
      );
    }
    const preview = {
      status: execute ? "EXECUTION_REQUESTED" : "PREVIEW",
      frozenPublicManifestSha256: publicManifest.manifestSha256,
      preflightReceiptSha256: preflight.manifestSha256,
      targetCount: targets.length,
      candidateCount: candidates.length,
      candidatesBySource: countSources(candidates.map(
        (candidate) => candidate.target,
      )),
      candidatesWithPageImages: candidates.filter(
        (candidate) => candidate.pageImages.length > 0,
      ).length,
      candidatesWithoutPageImages: candidates.filter(
        (candidate) => candidate.pageImages.length === 0,
      ).length,
      totalExistingPageImages: candidates.reduce(
        (sum, candidate) => sum + candidate.pageImages.length,
        0,
      ),
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
      throw new Error("PDF recovery artifact already exists.");
    }
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("R2 configuration is required for PDF recovery.");
    const imageOcr = resolveGrantImageOcrAdapter(imageOcrProvider);
    if (!imageOcr) throw new Error("PDF recovery image OCR adapter is unavailable.");
    const result = await recoverPdfTextOcrCandidates({
      db,
      storage,
      candidates,
      imageOcr,
    });
    const payload = {
      recordType: "deep_analysis_quality_pdf_text_ocr_recovery" as const,
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      frozenPublicManifestSha256: publicManifest.manifestSha256,
      frozenSecretManifestSha256: secretManifest.manifestSha256,
      preflightReceiptSha256: preflight.manifestSha256,
      confirmation: CONFIRMATION,
      targetCount: targets.length,
      candidateCount: result.candidateCount,
      candidatesBySource: result.candidatesBySource,
      succeededCount: result.succeededCount,
      failedCount: result.failedCount,
      recoveredCommitments: result.recoveredCommitments,
      failures: result.failures,
      results: result.results,
      recoveryVerdict: result.failedCount === 0
        ? "COMPLETE" as const
        : "PARTIAL" as const,
      imageOcrProvider,
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
    const written = await readJson<typeof receipt>(
      join(outputDir, RECEIPT_FILENAME),
    );
    const { receiptSha256: writtenSha256, ...writtenPayload } = written;
    if (
      writtenSha256 !== sha256Hex(stableJson(writtenPayload))
      || writtenSha256 !== receipt.receiptSha256
    ) {
      throw new Error("PDF recovery receipt failed immutable readback verification.");
    }
    console.log(JSON.stringify({
      status: written.recoveryVerdict,
      targetCount: written.targetCount,
      candidateCount: written.candidateCount,
      succeededCount: written.succeededCount,
      failedCount: written.failedCount,
      receiptSha256: written.receiptSha256,
      artifactWritten: RECEIPT_FILENAME,
      externalLlmCalls: written.externalLlmCalls,
      analysisJobsEnqueued: written.analysisJobsEnqueued,
      databaseWriteMode: written.databaseWriteMode,
      objectStorageWriteMode: written.objectStorageWriteMode,
    }));
    if (written.recoveryVerdict !== "COMPLETE") process.exitCode = 2;
  } finally {
    await closeCunoteDb();
  }
}

function countSources(
  targets: readonly { source: "kstartup" | "bizinfo" }[],
): Record<"kstartup" | "bizinfo", number> {
  return {
    kstartup: targets.filter((target) => target.source === "kstartup").length,
    bizinfo: targets.filter((target) => target.source === "bizinfo").length,
  };
}

async function writeReceiptExclusive(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("PDF recovery artifact already exists.");
      }
      throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
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

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function assertSupportedArguments(args: string[]): void {
  for (const arg of args) {
    if (
      arg === "--execute"
      || arg.startsWith("--cohort-dir=")
      || arg.startsWith("--preflight=")
      || arg.startsWith("--output-dir=")
      || arg.startsWith("--confirm=")
      || arg.startsWith("--image-ocr=")
    ) {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
