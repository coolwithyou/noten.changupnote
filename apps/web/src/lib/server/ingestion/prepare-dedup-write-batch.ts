import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildDedupWriteBatchManifest,
  type DedupAuditEvidence,
  type DedupPublishEvidence,
} from "./dedupWriteBatchEvidence";

const auditPath = requiredPath("audit");
const dryRunPath = requiredPath("dryRun");
const outputPath = readArg("output") ? resolve(readArg("output")!) : null;
const manifest = buildDedupWriteBatchManifest({
  audit: readJson<DedupAuditEvidence>(auditPath),
  dryRun: readJson<DedupPublishEvidence>(dryRunPath),
});
writeResult(manifest, outputPath);

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`failed to read JSON evidence ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function requiredPath(name: string): string {
  const value = readArg(name);
  if (!value) throw new Error(`--${name}=<json> is required`);
  return resolve(value);
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function writeResult(value: unknown, outputPath: string | null): void {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(json);
    return;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, json, "utf8");
  const manifest = value as { batchId: string; pairs: unknown[] };
  console.log(JSON.stringify({
    ok: true,
    writeMode: false,
    outputPath,
    batchId: manifest.batchId,
    pairCount: manifest.pairs.length,
    approvalGranted: false,
  }, null, 2));
}
