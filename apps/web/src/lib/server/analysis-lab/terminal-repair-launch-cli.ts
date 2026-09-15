import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { prepareTerminalRepairLaunch } from "./current-inventory-launch-production";

export function parseTerminalRepairLaunchArgs(argv: readonly string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(source-manifest|source-grant|concurrency)=(.+)$/u.exec(arg);
    if (!match || values.has(match[1]!)) throw new Error("terminal repair 옵션이 잘못됐습니다.");
    values.set(match[1]!, match[2]!);
  }
  const sourceManifestSha256 = values.get("source-manifest") ?? "";
  const sourceGrantSha256 = values.get("source-grant") ?? "";
  if (values.size !== 3 || !/^[a-f0-9]{64}$/u.test(sourceManifestSha256)
    || !/^[a-f0-9]{64}$/u.test(sourceGrantSha256) || !/^[1-4]$/u.test(values.get("concurrency") ?? "")) {
    throw new Error("--source-manifest=<sha256> --source-grant=<sha256> --concurrency=<1..4>가 필요합니다.");
  }
  return { sourceManifestSha256, sourceGrantSha256, concurrency: Number(values.get("concurrency")) };
}

async function main() {
  const input = parseTerminalRepairLaunchArgs(process.argv.slice(2));
  loadAnalysisLabEnv();
  try {
    const result = await prepareTerminalRepairLaunch(input);
    console.log(JSON.stringify({ ...result, manifest: undefined, targetCount: result.manifest.targets.length,
      execution: result.manifest.execution }, null, 2));
  } finally { await closeCunoteDb(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
