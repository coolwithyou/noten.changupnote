import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { parseCurrentInventoryLaunchArgs } from "./current-inventory-launch-cli";
import { prepareMissingWorkspaceFieldsLaunch } from "./current-inventory-launch-production";

async function main() {
  const input = parseCurrentInventoryLaunchArgs(process.argv.slice(2));
  loadAnalysisLabEnv();
  try {
    const result = await prepareMissingWorkspaceFieldsLaunch(input);
    console.log(JSON.stringify({ ...result, manifest: undefined,
      targetCount: result.manifest.targets.length, execution: result.manifest.execution }, null, 2));
  } finally { await closeCunoteDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
