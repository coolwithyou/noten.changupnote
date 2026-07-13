import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  compareExtractionWriteBatch,
  type BusinessNumberEvidence,
  type ArchiveWriteReceiptEvidence,
  type ExtractionPriorityEvidence,
  type ExtractionWriteBatchManifest,
} from "./extractionWriteBatchEvidence";

const manifestPath = requiredPath("manifest");
const priorityPath = requiredPath("priority");
const businessPath = requiredPath("business");
const outputPath = readArg("output") ? resolve(readArg("output")!) : null;
const writeReceiptPath = readArg("writeReceipt") ? resolve(readArg("writeReceipt")!) : null;

const comparison = compareExtractionWriteBatch({
  manifest: readJson<ExtractionWriteBatchManifest>(manifestPath),
  priority: readJson<ExtractionPriorityEvidence>(priorityPath),
  business: readJson<BusinessNumberEvidence>(businessPath),
  ...(writeReceiptPath ? { writeReceipt: readJson<ArchiveWriteReceiptEvidence>(writeReceiptPath) } : {}),
});
const json = `${JSON.stringify(comparison, null, 2)}\n`;
if (!outputPath) {
  process.stdout.write(json);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, json, "utf8");
  console.log(JSON.stringify({
    ok: comparison.gates.writeOutcomeVerified,
    writeMode: false,
    outputPath,
    batchId: comparison.batchId,
    contaminated: comparison.contaminated,
    comparable: comparison.gates.comparable,
    gates: comparison.gates,
  }, null, 2));
}
if (process.argv.includes("--require-verified") && !comparison.gates.writeOutcomeVerified) {
  process.exitCode = 1;
}

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
