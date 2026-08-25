import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "@/lib/server/db/client";
import { loadAnalysisLabEnv } from "@/lib/server/loadMonorepoEnv";
import { prepareAuthoringGuideRerunLaunchManifest } from "./authoring-guide-rerun-launch-production";

const SHA256 = /^[a-f0-9]{64}$/u;
const USAGE = "pnpm lab:authoring-guide:rerun:prepare -- --adoption-manifest=<sha256> [--concurrency=1-4]";

export function parseAuthoringGuideRerunLaunchCliArgs(argv: readonly string[]): {
  readonly adoptionManifestSha256: string;
  readonly concurrency: number;
} {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const values = new Map<string, string>();
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (separator < 0) throw new Error(USAGE);
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    if (!["--adoption-manifest", "--concurrency"].includes(key) || !value || values.has(key)) {
      throw new Error(USAGE);
    }
    values.set(key, value);
  }
  const adoptionManifestSha256 = values.get("--adoption-manifest");
  const concurrency = Number(values.get("--concurrency") ?? "2");
  if (
    !adoptionManifestSha256
    || !SHA256.test(adoptionManifestSha256)
    || !Number.isSafeInteger(concurrency)
    || concurrency < 1
    || concurrency > 4
  ) {
    throw new Error(USAGE);
  }
  return { adoptionManifestSha256, concurrency };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadAnalysisLabEnv();
  const args = parseAuthoringGuideRerunLaunchCliArgs(argv);
  try {
    const result = await prepareAuthoringGuideRerunLaunchManifest(args);
    process.stdout.write(`${JSON.stringify({
      kind: "authoring-guide-rerun-launch-manifest",
      liveExecutionAuthorized: false,
      source: result.manifest.source,
      execution: result.manifest.execution,
      targetCount: result.manifest.targets.length,
      changedSinceAdoption: result.manifest.targets.filter(
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
