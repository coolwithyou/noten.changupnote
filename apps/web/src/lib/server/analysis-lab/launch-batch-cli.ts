import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import {
  approveAnalysisLaunchManifest,
  prepareCompletedCurrentInventoryLaunchManifest,
  prepareAnalysisLaunchManifest,
  runApprovedAnalysisLaunchBatch,
} from "./launch-batch-production";
import { classifyApplicationFieldAnalysis } from "./application-precompute";
import {
  ACTIVE_DEEP_REPAIR_SERIES_ID,
  ACTIVE_DEEP_REPAIR_TARGET_COUNT,
} from "./deep-repair-formal-policy";

const SHA256 = /^[a-f0-9]{64}$/;
const USAGE = `pnpm lab:launch:prepare -- --series=${ACTIVE_DEEP_REPAIR_SERIES_ID} --sequences=0-${ACTIVE_DEEP_REPAIR_TARGET_COUNT - 1} --concurrency=2
pnpm lab:launch:prepare -- --reseal-current-inventory=<sha256> --source-manifest=<sha256> --source-grant=<sha256> --terminal-receipt=<sha256> --concurrency=1
pnpm lab:launch:grant -- --manifest=<sha256> --approved-by=<actor>
pnpm lab:launch -- --grant=<sha256> [--retry-errors [--retry-sequences=<n[,n-m...]>]]`;

type Command = "prepare" | "grant" | "run";

export type AnalysisLaunchCliArgs =
  | { readonly kind: "help" }
  | {
      readonly kind: "prepare";
      readonly seriesId: string;
      readonly sequenceFrom: number;
      readonly sequenceTo: number;
      readonly concurrency: number;
    }
  | {
      readonly kind: "prepare-current-inventory-reseal";
      readonly inventorySha256: string;
      readonly sourceManifestSha256: string;
      readonly sourceGrantSha256: string;
      readonly terminalReceiptSha256: string;
      readonly concurrency: number;
    }
  | { readonly kind: "grant"; readonly manifestSha256: string; readonly approvedBy: string }
  | {
      readonly kind: "run";
      readonly grantSha256: string;
      readonly retryErrors: boolean;
      readonly retrySequences: readonly number[] | null;
    };

function parseRetrySequences(value: string | undefined): readonly number[] | null {
  if (value === undefined) return null;
  const sequences: number[] = [];
  const seen = new Set<number>();
  for (const part of value.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) throw usageError();
    const from = Number(range[1]);
    const to = Number(range[2] ?? range[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) throw usageError();
    for (let sequence = from; sequence <= to; sequence += 1) {
      if (seen.has(sequence) || sequences.length >= 100) throw usageError();
      seen.add(sequence);
      sequences.push(sequence);
    }
  }
  if (sequences.length === 0) throw usageError();
  return sequences;
}

export function parseAnalysisLaunchCliArgs(
  command: Command,
  argv: readonly string[],
): AnalysisLaunchCliArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (args.length === 1 && args[0] === "--help") return { kind: "help" };
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) throw usageError();
    const separator = arg.indexOf("=");
    if (separator < 0) {
      if (flags.has(arg) || values.has(arg)) throw usageError();
      flags.add(arg);
      continue;
    }
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1).trim();
    if (value === "" || values.has(key) || flags.has(key)) throw usageError();
    values.set(key, value);
  }
  if (command === "prepare") {
    const resealInventorySha256 = values.get("--reseal-current-inventory");
    if (resealInventorySha256 !== undefined) {
      const allowedResealValues = new Set([
        "--reseal-current-inventory",
        "--source-manifest",
        "--source-grant",
        "--terminal-receipt",
        "--concurrency",
      ]);
      if (
        flags.size > 0
        || values.size !== allowedResealValues.size
        || [...values.keys()].some((key) => !allowedResealValues.has(key))
      ) throw usageError();
      const sourceManifestSha256 = values.get("--source-manifest");
      const sourceGrantSha256 = values.get("--source-grant");
      const terminalReceiptSha256 = values.get("--terminal-receipt");
      const concurrency = Number(values.get("--concurrency"));
      if (
        !SHA256.test(resealInventorySha256)
        || !sourceManifestSha256 || !SHA256.test(sourceManifestSha256)
        || !sourceGrantSha256 || !SHA256.test(sourceGrantSha256)
        || !terminalReceiptSha256 || !SHA256.test(terminalReceiptSha256)
        || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4
      ) throw usageError();
      return {
        kind: "prepare-current-inventory-reseal",
        inventorySha256: resealInventorySha256,
        sourceManifestSha256,
        sourceGrantSha256,
        terminalReceiptSha256,
        concurrency,
      };
    }
    const allowedValues = new Set(["--series", "--sequences", "--concurrency"]);
    if ([...values.keys()].some((key) => !allowedValues.has(key)) || flags.size > 0) {
      throw usageError();
    }
    const seriesId = values.get("--series");
    const range = values.get("--sequences")?.match(/^(\d+)-(\d+)$/);
    const concurrency = Number(values.get("--concurrency") ?? "2");
    if (
      !seriesId
      || !range
      || !Number.isInteger(concurrency)
      || concurrency < 1
      || concurrency > 4
    ) throw usageError();
    const sequenceFrom = Number(range[1]);
    const sequenceTo = Number(range[2]);
    if (sequenceTo < sequenceFrom) throw usageError();
    return {
      kind: "prepare",
      seriesId,
      sequenceFrom,
      sequenceTo,
      concurrency,
    };
  }
  if (command === "grant") {
    if (flags.size > 0 || values.size !== 2) throw usageError();
    const manifestSha256 = values.get("--manifest");
    const approvedBy = values.get("--approved-by");
    if (!manifestSha256 || !SHA256.test(manifestSha256) || !approvedBy) throw usageError();
    return { kind: "grant", manifestSha256, approvedBy };
  }
  if (
    [...values.keys()].some((key) => !["--grant", "--retry-sequences"].includes(key))
    || [...flags].some((key) => key !== "--retry-errors")
  ) throw usageError();
  const grantSha256 = values.get("--grant");
  if (!grantSha256 || !SHA256.test(grantSha256)) throw usageError();
  const retryErrors = flags.has("--retry-errors");
  const retrySequences = parseRetrySequences(values.get("--retry-sequences"));
  if (retrySequences && !retryErrors) throw usageError();
  return { kind: "run", grantSha256, retryErrors, retrySequences };
}

async function main(command: Command, argv: readonly string[]): Promise<void> {
  const parsed = parseAnalysisLaunchCliArgs(command, argv);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return;
  }
  loadAnalysisLabEnv();
  try {
    if (parsed.kind === "prepare-current-inventory-reseal") {
      const result = await prepareCompletedCurrentInventoryLaunchManifest({
        inventorySha256: parsed.inventorySha256,
        sourceManifestSha256: parsed.sourceManifestSha256,
        sourceGrantSha256: parsed.sourceGrantSha256,
        terminalReceiptSha256: parsed.terminalReceiptSha256,
        concurrency: parsed.concurrency,
      });
      console.log(JSON.stringify({
        kind: "launch-manifest",
        liveExecutionAuthorized: false,
        sourceKind: result.manifest.source.kind,
        existingRunPolicy: result.manifest.execution.existingRunPolicy,
        manifestSha256: result.manifestSha256,
        targetCount: result.manifest.targets.length,
        path: result.path,
      }, null, 2));
      return;
    }
    if (parsed.kind === "prepare") {
      const result = await prepareAnalysisLaunchManifest({
        seriesId: parsed.seriesId,
        sequenceFrom: parsed.sequenceFrom,
        sequenceTo: parsed.sequenceTo,
        concurrency: parsed.concurrency,
      });
      console.log(JSON.stringify({
        kind: "launch-manifest",
        liveExecutionAuthorized: false,
        manifestSha256: result.manifestSha256,
        targetCount: result.manifest.targets.length,
        changedSinceInventory: result.manifest.targets.filter((target) => target.changedSinceInventory).length,
        path: result.path,
      }, null, 2));
      return;
    }
    if (parsed.kind === "grant") {
      const result = await approveAnalysisLaunchManifest({
        manifestSha256: parsed.manifestSha256,
        approvedBy: parsed.approvedBy,
      });
      console.log(JSON.stringify({ kind: "launch-grant", ...result }, null, 2));
      return;
    }
    const abort = new AbortController();
    const onSignal = () => abort.abort(new Error("launch batch가 사용자 신호로 중단됐습니다."));
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const result = await runApprovedAnalysisLaunchBatch({
        grantSha256: parsed.grantSha256,
        retryErrors: parsed.retryErrors,
        retrySequences: parsed.retrySequences,
        signal: abort.signal,
        onEvent(event) {
          if (event.type === "target-started") {
            console.log(`[launch] ${event.index + 1}/${event.total} started ${event.grantId}`);
          } else if (event.type === "target-ok" || event.type === "target-held") {
            const primaryOutcome = event.type === "target-ok" ? "publishable" : "held";
            const fieldAnalysis = event.applicationRoundtrip
              ? classifyApplicationFieldAnalysis(event.applicationRoundtrip)
              : "not_observed";
            console.log(`[launch] ${event.index + 1}/${event.total} primary=${primaryOutcome} application=${fieldAnalysis} ${event.grantId}`);
          } else if (event.type === "target-error") {
            console.log(`[launch] ${event.index + 1}/${event.total} target=failed ${event.grantId}`);
          } else if (event.type === "guard-stop") {
            console.error(`[launch] shared guard stop: ${event.reason}`);
          }
        },
      });
      console.log(JSON.stringify({
        kind: "launch-receipt",
        receiptSha256: result.receiptSha256,
        receiptPath: result.receiptPath,
        stopReason: result.receipt.stopReason,
        systemicFailure: result.receipt.systemicFailure,
        summary: result.receipt.summary,
        gitChangedSincePreparation: result.gitChangedSincePreparation,
      }, null, 2));
      if (result.receipt.stopReason === "systemic-failure") process.exitCode = 2;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  } finally {
    await closeCunoteDb();
  }
}

function usageError(): Error {
  return new Error(`launch CLI 인자가 잘못됐습니다.\n${USAGE}`);
}

const argvEntry = process.argv[1];
if (argvEntry && import.meta.url === pathToFileURL(argvEntry).href) {
  const command = process.env.ANALYSIS_LAUNCH_COMMAND;
  if (command !== "prepare" && command !== "grant" && command !== "run") {
    console.error("ANALYSIS_LAUNCH_COMMAND가 prepare|grant|run 중 하나여야 합니다.");
    process.exitCode = 1;
  } else {
    main(command, process.argv.slice(2)).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
