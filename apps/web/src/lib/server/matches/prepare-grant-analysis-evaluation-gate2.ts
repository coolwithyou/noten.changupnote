import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { hashGrantRawPayload } from "../ingestion/grantRawHash";
import {
  buildGrantAnalysisAttachmentSummary,
  buildGrantAnalysisSourceRevision,
  type GrantAnalysisEvaluationPublicManifest,
} from "../ingestion/grantAnalysisEvaluationCohort";
import { buildGrantAnalysisPilotInputs } from "../ingestion/grantAnalysisPilotInputs";
import {
  GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL,
  GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL,
} from "../ingestion/grantAnalysisEvaluationAnthropic";
import {
  buildGrantAnalysisEvaluationGate2Receipt,
  freezeGrantAnalysisEvaluationGate2Input,
  selectGrantAnalysisEvaluationGate2Entries,
  type GrantAnalysisEvaluationModelAccess,
} from "../ingestion/grantAnalysisEvaluationGate2";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";

const DEFAULT_MANIFEST = "tmp/grant-analysis-evaluation/2026-07-15/cohort/public-manifest.json";
const DEFAULT_OUTPUT_DIR = "tmp/grant-analysis-evaluation/2026-07-15/gate2";
const GATE2_ATTACHMENT_LIMITS = {
  maxAttachments: 3,
  maxCharsPerAttachment: 64_000,
  maxTotalChars: 96_000,
  maxDeclaredBytes: 2_000_000,
} as const;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      error: error instanceof Error ? error.message : "Gate 2 preparation failed.",
      externalMessagesCalls: 0,
      databaseWriteMode: false,
    }));
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  assertArguments(process.argv.slice(2));
  if ((readArg("mode") ?? "plan") !== "plan") {
    throw new Error("This preparation CLI is plan-only and cannot call Anthropic Messages.");
  }
  const manifestPath = resolve(readArg("manifest") ?? DEFAULT_MANIFEST);
  const outputDir = resolve(readArg("outputDir") ?? DEFAULT_OUTPUT_DIR);
  const overwrite = process.argv.includes("--overwrite");
  const checkModels = process.argv.includes("--checkModels");
  if (!checkModels) {
    throw new Error("Every new Gate 2 plan requires --checkModels; prior access receipts are never reused.");
  }
  loadMonorepoEnv();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GrantAnalysisEvaluationPublicManifest;
  const selected = selectGrantAnalysisEvaluationGate2Entries(manifest);
  const modelAccess = await checkAnthropicModels(process.env.ANTHROPIC_API_KEY);

  const [{ getCunoteDb, closeCunoteDb }, { createDrizzleRepositories }] = await Promise.all([
    import("../db/client"),
    import("../repositories/drizzle"),
  ]);
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  try {
    const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
    const frozen = [];
    for (const selection of selected) {
      const manifestEntry = selection.entry;
      const grantKey = `${manifestEntry.source}:${manifestEntry.sourceId}`;
      const entry = await repositories.grants.findGrantById(grantKey);
      if (!entry) throw new Error(`${grantKey}: public validation grant is unavailable.`);
      if (entry.grant.id !== manifestEntry.canonicalId || entry.grant.title !== manifestEntry.title) {
        throw new Error(`${grantKey}: canonical identity/title drifted from the public validation manifest.`);
      }
      const rawPayloadSha256 = hashGrantRawPayload(entry.raw.payload);
      const attachmentSummary = buildGrantAnalysisAttachmentSummary(entry.raw);
      const sourceRevision = buildGrantAnalysisSourceRevision({
        source: manifestEntry.source,
        sourceId: manifestEntry.sourceId,
        rawPayloadSha256,
        attachmentSummarySha256: attachmentSummary.attachmentSummarySha256,
      });
      if (sourceRevision !== manifestEntry.sourceRevision ||
          rawPayloadSha256 !== manifestEntry.rawPayloadSha256 ||
          attachmentSummary.attachmentSummarySha256 !== manifestEntry.attachmentSummary.attachmentSummarySha256) {
        throw new Error(`${grantKey}: source revision drifted from the public validation manifest.`);
      }
      const inputs = await buildGrantAnalysisPilotInputs({
        entry,
        storage,
        limits: GATE2_ATTACHMENT_LIMITS,
      });
      if (selection.role === "attachment_loadable" && (
        inputs.attachments.counts.included < 1 ||
        inputs.attachments.truncation.truncatedAttachmentCount !== 0 ||
        inputs.attachments.truncation.selectedButNotLoadedCount !== 0 ||
        inputs.attachments.truncation.excludedByAttachmentLimitCount !== 0
      )) {
        throw new Error(`${grantKey}: attachment-loadable smoke input is incomplete under evaluation-only limits.`);
      }
      frozen.push(freezeGrantAnalysisEvaluationGate2Input({
        selectionRole: selection.role,
        selectionRationale: selection.rationale,
        manifestEntry,
        inputs,
      }));
    }

    const receipt = buildGrantAnalysisEvaluationGate2Receipt({ manifest, frozen, modelAccess });
    const receiptPath = join(outputDir, "plan-receipt.json");
    await publishGrantAnalysisEvaluationGate2Plan({ outputDir, frozen, receipt, overwrite });
    console.log(JSON.stringify({
      status: "ok",
      paidReady: true,
      receiptPath,
      selected: receipt.selected.map((entry) => ({
        role: entry.role,
        grantKey: entry.grantKey,
        title: entry.title,
        cReusesB: entry.cReusesB,
      })),
      calls: receipt.calls,
      costs: {
        estimatedUsd: receipt.pricing.estimatedCostUsd,
        hardWorstUsd: receipt.pricing.hardWorstCostUsd,
      },
      modelAccess,
      externalMessagesCalls: 0,
      databaseWriteMode: false,
    }, null, 2));
  } finally {
    await closeCunoteDb();
  }
}

async function checkAnthropicModels(apiKeyValue: string | undefined): Promise<GrantAnalysisEvaluationModelAccess> {
  const apiKey = apiKeyValue?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for the single model-access GET.");
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
  } catch {
    throw new Error("Anthropic model-access GET failed before response.");
  }
  if (!response.ok) {
    throw new Error(`Anthropic model-access GET failed with status ${response.status}.`);
  }
  const payload = JSON.parse(await response.text()) as { data?: Array<{ id?: unknown }> };
  const allIds = (payload.data ?? []).flatMap((item) => typeof item.id === "string" ? [item.id] : []);
  const requested = [
    GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL,
    GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL,
  ] as const;
  const matchedModelIds = allIds.filter((id) => requested.some((model) =>
    id === model || id.startsWith(`${model}-`))).sort();
  return {
    requestedModelIds: requested,
    available: Object.fromEntries(requested.map((model) => [
      model,
      matchedModelIds.some((id) => id === model || id.startsWith(`${model}-`)),
    ])),
    matchedModelIds,
    authenticatedModelsGetCalls: 1,
  };
}

export async function publishGrantAnalysisEvaluationGate2Plan(options: {
  outputDir: string;
  frozen: readonly { grantKey: string }[];
  receipt: unknown;
  overwrite: boolean;
  writer?: typeof writeGrantAnalysisEvaluationGate2ArtifactAtomic;
}): Promise<void> {
  const writer = options.writer ?? writeGrantAnalysisEvaluationGate2ArtifactAtomic;
  const receiptPath = join(options.outputDir, "plan-receipt.json");
  try {
    await lstat(receiptPath);
    throw new Error(`${receiptPath}: finalized Gate 2 plan is immutable; create a new plan location.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const inputsDir = join(options.outputDir, "inputs");
  await mkdir(inputsDir, { recursive: true, mode: 0o700 });
  // Inputs are durable first; the receipt is the final atomic commit marker.
  for (const input of options.frozen) {
    const filename = `${input.grantKey.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
    await writer(join(inputsDir, filename), input, options.overwrite);
  }
  await writer(receiptPath, options.receipt, false);
}

export async function writeGrantAnalysisEvaluationGate2ArtifactAtomic(
  path: string,
  value: unknown,
  overwrite: boolean,
  testHooks: {
    beforeTempReadback?: (tempPath: string) => Promise<void>;
    beforeRename?: (tempPath: string) => Promise<void>;
  } = {},
): Promise<void> {
  await assertSafeTarget(path, overwrite);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const expectedHash = sha256(bytes);
  const tempPath = join(dirname(path), `.${randomBytes(16).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await testHooks.beforeTempReadback?.(tempPath);
    const tempInfo = await lstat(tempPath);
    if (!tempInfo.isFile() || tempInfo.isSymbolicLink() || (tempInfo.mode & 0o777) !== 0o600) {
      throw new Error(`${path}: temporary artifact must be a regular 0600 file.`);
    }
    if (sha256(await readFile(tempPath)) !== expectedHash) {
      throw new Error(`${path}: temporary artifact readback hash mismatch.`);
    }
    await testHooks.beforeRename?.(tempPath);
    await assertSafeTarget(path, overwrite);
    await rename(tempPath, path);
    await chmod(path, 0o600);
    const finalInfo = await stat(path);
    if (!finalInfo.isFile() || (finalInfo.mode & 0o777) !== 0o600) {
      throw new Error(`${path}: final artifact must be a regular 0600 file.`);
    }
    if (sha256(await readFile(path)) !== expectedHash) {
      throw new Error(`${path}: final artifact readback hash mismatch.`);
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
  }
}

async function assertSafeTarget(path: string, overwrite: boolean): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${path}: refusing a symlink or non-regular artifact target.`);
    }
    if (!overwrite) throw new Error(`${path}: artifact already exists; pass --overwrite explicitly.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertArguments(arguments_: string[]): void {
  for (const argument of arguments_) {
    if (argument === "--overwrite" || argument === "--checkModels" ||
        argument.startsWith("--mode=") || argument.startsWith("--manifest=") ||
        argument.startsWith("--outputDir=")) continue;
    throw new Error(`Unsupported Gate 2 preparation argument: ${argument}`);
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
