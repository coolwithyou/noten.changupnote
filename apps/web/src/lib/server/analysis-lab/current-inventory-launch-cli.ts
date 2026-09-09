import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { prepareCurrentInventoryLaunch } from "./current-inventory-launch-production";

export function parseCurrentInventoryLaunchArgs(argv: readonly string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== 2) throw new Error("--grant-ids=<uuid,...> --concurrency=<1..4>가 필요합니다.");
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(grant-ids|concurrency)=(.+)$/u.exec(arg);
    if (!match || values.has(match[1]!)) throw new Error("허용되지 않거나 중복된 current inventory 옵션입니다.");
    values.set(match[1]!, match[2]!);
  }
  const grantIds = values.get("grant-ids")?.split(",") ?? [];
  const concurrency = Number(values.get("concurrency"));
  if (grantIds.length < 1 || grantIds.length > 100 || new Set(grantIds).size !== grantIds.length
    || grantIds.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))
    || !/^[1-4]$/u.test(values.get("concurrency") ?? "")) throw new Error("current inventory exact 인자가 잘못됐습니다.");
  return { grantIds, concurrency };
}

async function main() {
  const input = parseCurrentInventoryLaunchArgs(process.argv.slice(2));
  loadAnalysisLabEnv();
  try {
    const result = await prepareCurrentInventoryLaunch(input);
    console.log(JSON.stringify({ ...result, manifest: undefined,
      targetCount: result.manifest.targets.length, sourceKind: result.manifest.source.kind,
      concurrency: result.manifest.execution.concurrency }, null, 2));
  } finally { await closeCunoteDb(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
