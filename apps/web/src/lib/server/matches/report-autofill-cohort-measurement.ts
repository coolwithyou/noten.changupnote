import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import {
  buildAutofillCohortReport,
  renderAutofillCohortMarkdown,
  type AutofillCohortSampleInput,
} from "@cunote/core/evaluation/autofill-cohort-measurement";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();
await main().catch(() => {
  // Do not echo filesystem paths, input values, or nested parser errors: any may contain a raw identifier.
  console.error(JSON.stringify({ status: "failed", error: "cohort measurement input or artifact operation failed" }));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const inputPath = resolve(requiredArg("input"));
  const secret = process.env.CUNOTE_COHORT_HMAC_SECRET;
  if (!secret) throw new Error("missing secret");
  const rawText = await readFile(inputPath, "utf8");
  const samples = extname(inputPath).toLowerCase() === ".csv" ? parseCsvSamples(rawText) : parseJsonSamples(rawText);
  const report = buildAutofillCohortReport({ samples, secret });
  const base = outputBase(readArg("output") ? resolve(readArg("output")!) : inputPath.replace(/\.(json|csv)$/i, ".report"));
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  await mkdir(dirname(base), { recursive: true });
  await atomicWritePair([[jsonPath, `${JSON.stringify(report, null, 2)}\n`], [markdownPath, renderAutofillCohortMarkdown(report)]]);
  console.log(JSON.stringify({ status: report.status, sampleCount: report.sampleCount, verifiedSampleCount: report.verifiedSampleCount, artifactsWritten: ["json", "markdown"] }));
}

function parseJsonSamples(text: string): AutofillCohortSampleInput[] {
  const parsed: unknown = JSON.parse(text);
  const samples = Array.isArray(parsed) ? parsed : isObject(parsed) ? parsed.samples : undefined;
  if (!Array.isArray(samples)) throw new Error("JSON input must be an array or { samples: [] }");
  return samples.map(validateSample);
}

function parseCsvSamples(text: string): AutofillCohortSampleInput[] {
  const rows = parseCsv(text);
  const [rawHeaders, ...records] = rows;
  const headers = rawHeaders?.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim());
  if (!headers) throw new Error("CSV input is empty");
  const required = ["businessNumber", "cohorts", "coverageRows", "questionCount", "unknownsResolved", "sourceCalls", "fields"];
  const allowed = new Set([...required, "grantWeights"]);
  if (new Set(headers).size !== headers.length || required.some((name) => !headers.includes(name)) || headers.some((name) => !allowed.has(name))) throw new Error("CSV headers are missing, duplicated, or unsupported");
  return records.filter((row) => row.some(Boolean)).map((row, rowIndex) => {
    if (row.length !== headers.length) throw new Error(`CSV row ${rowIndex + 2} has the wrong column count`);
    const value = Object.fromEntries(headers.map((header, index) => [header.trim(), row[index] ?? ""]));
    return validateSample({
      businessNumber: value.businessNumber,
      cohorts: value.cohorts?.split("|").filter(Boolean),
      coverageRows: jsonCell(value.coverageRows, "coverageRows", rowIndex),
      grantWeights: value.grantWeights ? jsonCell(value.grantWeights, "grantWeights", rowIndex) : undefined,
      questionCount: Number(value.questionCount), unknownsResolved: Number(value.unknownsResolved),
      sourceCalls: jsonCell(value.sourceCalls, "sourceCalls", rowIndex), fields: jsonCell(value.fields, "fields", rowIndex),
    });
  });
}

function validateSample(value: unknown): AutofillCohortSampleInput {
  if (!isObject(value) || typeof value.businessNumber !== "string" || !value.businessNumber.trim()) throw new Error("each sample requires businessNumber");
  if (!Array.isArray(value.cohorts) || !Array.isArray(value.coverageRows) || !Array.isArray(value.sourceCalls) || !Array.isArray(value.fields)) throw new Error("each sample requires cohorts, coverageRows, sourceCalls, and fields arrays");
  if (typeof value.questionCount !== "number" || typeof value.unknownsResolved !== "number") throw new Error("each sample requires numeric questionCount and unknownsResolved");
  return value as unknown as AutofillCohortSampleInput;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (quoted && char === '"') { quoted = false; closedQuote = true; }
    else if (!quoted && char === '"') { if (cell || closedQuote) throw new Error("quote must begin an empty CSV field"); quoted = true; }
    else if (!quoted && char === ",") { row.push(cell); cell = ""; closedQuote = false; }
    else if (!quoted && (char === "\n" || char === "\r")) { if (char === "\r" && text[index + 1] === "\n") index += 1; row.push(cell); rows.push(row); row = []; cell = ""; closedQuote = false; }
    else if (closedQuote) throw new Error("unexpected characters after quoted CSV field");
    else cell += char;
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function jsonCell(value: string | undefined, name: string, rowIndex: number): unknown { try { return JSON.parse(value ?? ""); } catch { throw new Error(`invalid ${name} JSON in CSV row ${rowIndex + 2}`); } }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function outputBase(path: string): string { return path.replace(/\.(json|md)$/i, ""); }
async function atomicWritePair(entries: Array<readonly [string, string]>): Promise<void> {
  const temporary = entries.map(([path, body]) => ({ path, body, temp: `${path}.${process.pid}.${randomUUID()}.tmp` }));
  try {
    await Promise.all(temporary.map((item) => writeFile(item.temp, item.body, { encoding: "utf8", mode: 0o600 })));
    await Promise.all(temporary.map((item) => rename(item.temp, item.path)));
  } catch (error) {
    await Promise.all(temporary.map((item) => rm(item.temp, { force: true }).catch(() => undefined)));
    throw error;
  }
}
function requiredArg(name: string): string { const value = readArg(name); if (!value) throw new Error(`--${name}=PATH is required`); return value; }
function readArg(name: string): string | undefined { const prefix = `--${name}=`; return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length); }
