import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import {
  buildAutofillCohortReport,
  renderAutofillCohortMarkdown,
  type AutofillCohortSampleInput,
} from "../../../../../../packages/core/src/evaluation/autofill-cohort-measurement";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();
const inputPath = resolve(requiredArg("input"));
const secret = process.env.CUNOTE_COHORT_HMAC_SECRET;
if (!secret) throw new Error("CUNOTE_COHORT_HMAC_SECRET is required");
const rawText = await readFile(inputPath, "utf8");
const samples = extname(inputPath).toLowerCase() === ".csv" ? parseCsvSamples(rawText) : parseJsonSamples(rawText);
// The raw input is not logged or copied. The builder immediately replaces each identifier with its HMAC ID.
const report = buildAutofillCohortReport({ samples, secret });
const base = outputBase(readArg("output") ? resolve(readArg("output")!) : inputPath.replace(/\.(json|csv)$/i, ".report"));
const jsonPath = `${base}.json`;
const markdownPath = `${base}.md`;
await mkdir(dirname(base), { recursive: true });
await Promise.all([
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
  atomicWrite(markdownPath, renderAutofillCohortMarkdown(report)),
]);
console.log(JSON.stringify({ status: report.status, sampleCount: report.sampleCount, verifiedSampleCount: report.verifiedSampleCount, artifactsWritten: ["json", "markdown"] }));

function parseJsonSamples(text: string): AutofillCohortSampleInput[] {
  const parsed: unknown = JSON.parse(text);
  const samples = Array.isArray(parsed) ? parsed : isObject(parsed) ? parsed.samples : undefined;
  if (!Array.isArray(samples)) throw new Error("JSON input must be an array or { samples: [] }");
  return samples.map(validateSample);
}

function parseCsvSamples(text: string): AutofillCohortSampleInput[] {
  const rows = parseCsv(text);
  const [headers, ...records] = rows;
  if (!headers) throw new Error("CSV input is empty");
  return records.filter((row) => row.some(Boolean)).map((row, rowIndex) => {
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
  return value as unknown as AutofillCohortSampleInput;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (char === "\n" || char === "\r")) { if (char === "\r" && text[index + 1] === "\n") index += 1; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function jsonCell(value: string | undefined, name: string, rowIndex: number): unknown { try { return JSON.parse(value ?? ""); } catch { throw new Error(`invalid ${name} JSON in CSV row ${rowIndex + 2}`); } }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function outputBase(path: string): string { return path.replace(/\.(json|md)$/i, ""); }
async function atomicWrite(path: string, body: string): Promise<void> { const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
function requiredArg(name: string): string { const value = readArg(name); if (!value) throw new Error(`--${name}=PATH is required`); return value; }
function readArg(name: string): string | undefined { const prefix = `--${name}=`; return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length); }
