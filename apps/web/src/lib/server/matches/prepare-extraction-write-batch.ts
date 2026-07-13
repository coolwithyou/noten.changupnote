import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildExtractionWriteBatchManifest,
  type ArchiveDryRunEvidence,
  type BusinessNumberEvidence,
  type ImageOcrProbeEvidence,
  type ExtractionPriorityEvidence,
  type ExtractionWriteBatchAction,
  type ExtractionWriteBatchSource,
} from "./extractionWriteBatchEvidence";

const priorityPath = requiredPath("priority");
const businessPath = requiredPath("business");
const dryRunPath = requiredPath("dryRun");
const source = enumArg(readArg("source"), ["bizinfo", "kstartup"] as const, "source");
const action = enumArg(
  readArg("action") ?? "archive_attachments",
  ["archive_attachments", "ocr_images"] as const,
  "action",
);
const ocrProbePath = readArg("ocrProbe") ? resolve(readArg("ocrProbe")!) : null;
const outputPath = readArg("output") ? resolve(readArg("output")!) : null;

const manifest = buildExtractionWriteBatchManifest({
  priority: readJson<ExtractionPriorityEvidence>(priorityPath),
  business: readJson<BusinessNumberEvidence>(businessPath),
  dryRun: readJson<ArchiveDryRunEvidence>(dryRunPath),
  source: source as ExtractionWriteBatchSource,
  action: action as ExtractionWriteBatchAction,
  ...(ocrProbePath ? { ocrProbe: readJson<ImageOcrProbeEvidence>(ocrProbePath) } : {}),
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

function enumArg<T extends string>(value: string | undefined, values: readonly T[], name: string): T {
  if (value && (values as readonly string[]).includes(value)) return value as T;
  throw new Error(`--${name} must be one of ${values.join("|")}`);
}

function writeResult(value: unknown, outputPath: string | null): void {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(json);
    return;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, json, "utf8");
  const manifest = value as { batchId: string; sourceIds: string[] };
  console.log(JSON.stringify({
    ok: true,
    writeMode: false,
    outputPath,
    batchId: manifest.batchId,
    sourceIdCount: manifest.sourceIds.length,
    approvalGranted: false,
  }, null, 2));
}
