import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "@/lib/server/db/client";
import { loadAnalysisLabEnv } from "@/lib/server/loadMonorepoEnv";
import {
  prepareCurrentAuthoringGuideAdoption,
  writeAuthoringGuideAdoptionManifest,
} from "./authoring-guide-adoption-production";

const USAGE = "pnpm lab:authoring-guide:adopt -- [--as-of=YYYY-MM-DD] [--prepare] [--concurrency=1-4]";

interface CliArgs {
  readonly asOf: Date;
  readonly prepare: boolean;
  readonly concurrency: number;
}

export function parseAuthoringGuideAdoptionCliArgs(argv: readonly string[]): CliArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const allowedFlags = new Set(["--prepare"]);
  const flags = new Set(args.filter((arg) => !arg.includes("=")));
  if ([...flags].some((flag) => !allowedFlags.has(flag))) throw new Error(USAGE);
  const values = new Map<string, string>();
  for (const arg of args.filter((entry) => entry.includes("="))) {
    const separator = arg.indexOf("=");
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    if (!["--as-of", "--concurrency"].includes(key) || !value || values.has(key)) {
      throw new Error(USAGE);
    }
    values.set(key, value);
  }
  const asOfKey = values.get("--as-of") ?? koreaDateKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOfKey)) throw new Error(USAGE);
  const asOf = new Date(`${asOfKey}T12:00:00+09:00`);
  if (!Number.isFinite(asOf.getTime()) || koreaDateKey(asOf) !== asOfKey) throw new Error(USAGE);
  const concurrency = Number(values.get("--concurrency") ?? "4");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error(USAGE);
  }
  return { asOf, prepare: flags.has("--prepare"), concurrency };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadAnalysisLabEnv();
  const args = parseAuthoringGuideAdoptionCliArgs(argv);
  try {
    const manifest = await prepareCurrentAuthoringGuideAdoption({
      asOf: args.asOf,
      concurrency: args.concurrency,
    });
    const artifact = args.prepare
      ? await writeAuthoringGuideAdoptionManifest(manifest)
      : null;
    process.stdout.write(`${JSON.stringify({
      schema: manifest.schema,
      mode: args.prepare ? "prepared" : "report_only",
      asOfKst: manifest.asOfKst,
      population: manifest.population,
      summary: manifest.summary,
      reasonCounts: Object.fromEntries([
        ...new Set(manifest.items.flatMap((item) => item.reasons)),
      ].sort().map((reason) => [
        reason,
        manifest.items.filter((item) => item.reasons.includes(reason)).length,
      ])),
      rerunGrantIds: manifest.items
        .filter((item) => item.disposition === "rerun_required")
        .map((item) => item.grantId),
      reviewGrantIds: manifest.items
        .filter((item) => item.disposition === "review_required")
        .map((item) => item.grantId),
      sourceRecoveryGrantIds: manifest.items
        .filter((item) => item.disposition === "source_recovery_required")
        .map((item) => item.grantId),
      sourceBlockedGrantIds: manifest.items
        .filter((item) => item.reasons.includes("current_source_unsealed"))
        .map((item) => item.grantId),
      artifact,
      safety: manifest.execution,
    }, null, 2)}\n`);
  } finally {
    await closeCunoteDb();
  }
}

function koreaDateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
