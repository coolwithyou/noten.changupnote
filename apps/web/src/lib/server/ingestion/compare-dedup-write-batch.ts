import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  compareDedupWriteBatch,
  type DedupAuditEvidence,
  type DedupPublishEvidence,
  type DedupWriteBatchManifest,
} from "./dedupWriteBatchEvidence";

const manifestPath = requiredPath("manifest");
const auditPath = requiredPath("audit");
const receiptPath = readArg("writeReceipt") ? resolve(readArg("writeReceipt")!) : null;
const outputPath = readArg("output") ? resolve(readArg("output")!) : null;
const comparison = compareDedupWriteBatch({
  manifest: readJson<DedupWriteBatchManifest>(manifestPath),
  audit: readJson<DedupAuditEvidence>(auditPath),
  ...(receiptPath ? { writeReceipt: readJson<DedupPublishEvidence>(receiptPath) } : {}),
});
const json = `${JSON.stringify(comparison, null, 2)}\n`;
if (!outputPath) process.stdout.write(json);
else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, json, "utf8");
  console.log(JSON.stringify({
    ok: comparison.gates.writeOutcomeVerified,
    writeMode: false,
    outputPath,
    batchId: comparison.batchId,
    contaminated: comparison.contaminated,
    gates: comparison.gates,
  }, null, 2));
}
if (process.argv.includes("--require-verified") && !comparison.gates.writeOutcomeVerified) process.exitCode = 1;

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
