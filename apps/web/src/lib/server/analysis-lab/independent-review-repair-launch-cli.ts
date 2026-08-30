import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "@/lib/server/db/client";
import { loadAnalysisLabEnv } from "@/lib/server/loadMonorepoEnv";
import { prepareIndependentReviewRepairLaunchManifest } from "./independent-review-repair-launch-production";

const USAGE = "pnpm lab:independent-review:repair:prepare -- --aggregate=<aggregate.json> [--original-sequences=3,14] [--include-non-publishable=true] [--concurrency=1-4]";

export function parseIndependentReviewRepairLaunchCliArgs(argv: readonly string[]): {
  readonly aggregatePath: string;
  readonly originalSequences?: readonly number[];
  readonly includeNonPublishable: boolean;
  readonly concurrency: number;
} {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const values = new Map<string, string>();
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator < 0) throw new Error(USAGE);
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1).trim();
    if (
      !new Set(["--aggregate", "--original-sequences", "--include-non-publishable", "--concurrency"]).has(key)
      || !value
      || values.has(key)
    ) {
      throw new Error(USAGE);
    }
    values.set(key, value);
  }
  const aggregatePath = values.get("--aggregate");
  const rawSequences = values.get("--original-sequences");
  const originalSequences = rawSequences?.split(",").map((value) => Number(value));
  const includeNonPublishable = values.get("--include-non-publishable") ?? "false";
  const concurrency = Number(values.get("--concurrency") ?? "2");
  if (
    !aggregatePath
    || !aggregatePath.endsWith(".aggregate.json")
    || (originalSequences !== undefined && (
      originalSequences.length === 0
      || new Set(originalSequences).size !== originalSequences.length
      || originalSequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)
    ))
    || !Number.isSafeInteger(concurrency)
    || concurrency < 1
    || concurrency > 4
    || (includeNonPublishable !== "true" && includeNonPublishable !== "false")
  ) {
    throw new Error(USAGE);
  }
  return {
    aggregatePath,
    ...(originalSequences ? { originalSequences } : {}),
    includeNonPublishable: includeNonPublishable === "true",
    concurrency,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadAnalysisLabEnv();
  const args = parseIndependentReviewRepairLaunchCliArgs(argv);
  try {
    const result = await prepareIndependentReviewRepairLaunchManifest(args);
    process.stdout.write(`${JSON.stringify({
      kind: "independent-review-repair-launch-manifest",
      liveExecutionAuthorized: false,
      aggregateSha256: result.aggregateSha256,
      originalSequences: result.originalSequences,
      source: result.manifest.source,
      execution: result.manifest.execution,
      targetCount: result.manifest.targets.length,
      changedSinceReviewedLaunch: result.manifest.targets.filter(
        (target) => target.changedSinceInventory,
      ).length,
      manifestSha256: result.manifestSha256,
      path: result.path,
    }, null, 2)}\n`);
  } finally {
    await closeCunoteDb();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
