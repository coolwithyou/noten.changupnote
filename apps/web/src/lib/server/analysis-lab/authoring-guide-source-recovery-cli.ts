import { pathToFileURL } from "node:url";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import {
  prepareAuthoringGuideSourceRecovery,
  sourceRecoveryRuntimeReadiness,
  writeAuthoringGuideSourceRecoveryManifest,
} from "./authoring-guide-source-recovery-production";

const SHA256 = /^[a-f0-9]{64}$/u;
const USAGE = "pnpm lab:authoring-guide:recovery:prepare -- --adoption-manifest=<sha256>";

export function parseAuthoringGuideSourceRecoveryCliArgs(
  argv: readonly string[],
): { readonly adoptionManifestSha256: string } {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (args.length !== 1 || !args[0]?.startsWith("--adoption-manifest=")) {
    throw new Error(USAGE);
  }
  const adoptionManifestSha256 = args[0].slice("--adoption-manifest=".length);
  if (!SHA256.test(adoptionManifestSha256)) throw new Error(USAGE);
  return { adoptionManifestSha256 };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadMonorepoEnv();
  const args = parseAuthoringGuideSourceRecoveryCliArgs(argv);
  const runtimeReadiness = sourceRecoveryRuntimeReadiness();
  const manifest = await prepareAuthoringGuideSourceRecovery({
    adoptionManifestSha256: args.adoptionManifestSha256,
    runtimeReadiness,
  });
  const artifact = await writeAuthoringGuideSourceRecoveryManifest(manifest);
  process.stdout.write(`${JSON.stringify({
    schema: manifest.schema,
    source: manifest.source,
    summary: manifest.summary,
    runtimeReadiness: manifest.runtimeReadiness,
    safety: manifest.execution,
    recoveryGrantIds: manifest.targets.map((target) => target.grantId),
    artifact,
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
