import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "@/lib/server/db/client";
import { loadAnalysisLabEnv } from "@/lib/server/loadMonorepoEnv";
import { prepareIndependentReviewRepairLaunchManifest } from "./independent-review-repair-launch-production";

const USAGE = "pnpm lab:independent-review:repair:prepare -- --aggregate=<aggregate.json> [--concurrency=1-4]";

export function parseIndependentReviewRepairLaunchCliArgs(argv: readonly string[]): {
  readonly aggregatePath: string;
  readonly concurrency: number;
} {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const values = new Map<string, string>();
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator < 0) throw new Error(USAGE);
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1).trim();
    if (!new Set(["--aggregate", "--concurrency"]).has(key) || !value || values.has(key)) {
      throw new Error(USAGE);
    }
    values.set(key, value);
  }
  const aggregatePath = values.get("--aggregate");
  const concurrency = Number(values.get("--concurrency") ?? "2");
  if (
    !aggregatePath
    || !aggregatePath.endsWith(".aggregate.json")
    || !Number.isSafeInteger(concurrency)
    || concurrency < 1
    || concurrency > 4
  ) {
    throw new Error(USAGE);
  }
  return { aggregatePath, concurrency };
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
