import { extname } from "node:path";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { downloadAttachmentWithLimit } from "./attachmentDownload";
import { parseGrantImageOcrProvider, resolveGrantImageOcrAdapter } from "./grantImageOcrProviders";

loadMonorepoEnv();

const source = readEnum(readArg("source"), ["bizinfo", "kstartup"], "bizinfo");
const sourceIds = csvArg(readArg("sourceIds"), 100);
const limit = boundedInteger(readArg("limit"), 5, 1, 30);
const scanLimit = boundedInteger(readArg("scanLimit"), 2_000, limit, 5_000);
const maxBytes = boundedInteger(readArg("maxBytes"), 20 * 1024 * 1024, 1_024, 20 * 1024 * 1024);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const provider = parseGrantImageOcrProvider(readArg("provider") ?? "macos_vision");
const imageOcr = resolveGrantImageOcrAdapter(provider);
if (!imageOcr) throw new Error("OCR probe requires --provider=macos_vision|paddleocr");

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ limit: scanLimit, asOf });
  const filter = new Set(sourceIds);
  const targets = grants
    .filter((entry) => entry.grant.source === source)
    .filter((entry) => filter.size === 0 || filter.has(entry.grant.source_id))
    .flatMap((entry) => (entry.raw.attachments ?? [])
      .filter((attachment) => !attachment.storage_key || !attachment.sha256)
      .filter((attachment) => /\.(?:png|jpe?g)$/i.test(attachment.filename))
      .map((attachment) => ({
        sourceId: entry.grant.source_id,
        title: entry.grant.title,
        filename: attachment.filename,
        url: attachment.source_uri ?? attachment.url ?? null,
      })))
    .slice(0, limit);
  const results: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    if (!target.url) {
      results.push({ ...target, error: "attachment_url_missing" });
      continue;
    }
    try {
      const downloaded = await downloadAttachmentWithLimit(target.url, maxBytes);
      const ocr = await imageOcr({
        filename: target.filename,
        body: downloaded.body,
        contentType: downloaded.contentType,
      });
      results.push({
        sourceId: target.sourceId,
        title: target.title,
        filename: target.filename,
        extension: extname(target.filename).toLowerCase(),
        bytes: downloaded.body.length,
        lineCount: ocr.markdown.split(/\r?\n/).filter((line) => line.trim()).length,
        characterCount: ocr.markdown.length,
        averageConfidence: ocr.confidence,
        converter: ocr.converter,
        preview: ocr.markdown.slice(0, 300),
      });
    } catch (error) {
      results.push({
        sourceId: target.sourceId,
        title: target.title,
        filename: target.filename,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }
  const recognized = results.filter((result) =>
    typeof result.averageConfidence === "number" && typeof result.characterCount === "number");
  const confidences = recognized.map((result) => result.averageConfidence as number);
  const characterCounts = recognized.map((result) => result.characterCount as number);
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    provider,
    source,
    requestedSourceIds: sourceIds,
    targetCount: targets.length,
    recognizedCount: recognized.length,
    passingArchiveGateCount: recognized.filter((result) =>
      (result.averageConfidence as number) >= 0.6 && (result.characterCount as number) >= 20).length,
    failureCount: results.filter((result) => "error" in result).length,
    quality: {
      confidenceMin: min(confidences),
      confidenceP50: percentile(confidences, 0.5),
      confidenceMax: max(confidences),
      characterCountMin: min(characterCounts),
      characterCountP50: percentile(characterCounts, 0.5),
      characterCountMax: max(characterCounts),
    },
    results,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function readEnum<T extends string>(value: string | undefined, values: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid value: ${value}. Use ${values.join("|")}.`);
}
function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`sourceIds supports at most ${max} values`);
  return values;
}
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${min}..${max}: ${value}`);
  return parsed;
}
function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? null;
}
function min(values: number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}
function max(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}
