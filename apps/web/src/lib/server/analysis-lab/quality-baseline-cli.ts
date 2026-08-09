import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnalysisQualityReport } from "@/features/dev/analysis-lab/quality-contract";
import {
  compareAnalysisQualityBaselines,
  formatAnalysisQualityComparison,
  formatAnalysisQualityReport,
} from "./quality-baseline";
import { loadAnalysisQualityReport } from "./quality-report";
import { analysisLabDir } from "./run-store";

interface CliOptions {
  limit: number;
  write: boolean;
  json: boolean;
  comparePath: string | null;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const report = await loadAnalysisQualityReport({ limit: options.limit });
  const comparison = options.comparePath
    ? compareAnalysisQualityBaselines(await readBaseline(options.comparePath), report)
    : null;

  if (options.json) {
    console.log(JSON.stringify({ report, comparison }, null, 2));
  } else {
    console.log(formatAnalysisQualityReport(report));
    if (comparison) console.log(`\n${formatAnalysisQualityComparison(comparison)}`);
  }

  if (options.write) {
    const path = await writeBaseline(report);
    console.log(`\n기준선 저장: ${path}`);
  }
}

function parseOptions(args: string[]): CliOptions {
  let limit = 30;
  let write = false;
  let json = false;
  let comparePath: string | null = null;
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--write") write = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--limit=")) limit = Number.parseInt(arg.slice("--limit=".length), 10);
    else if (arg.startsWith("--compare=")) comparePath = arg.slice("--compare=".length).trim() || null;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit은 1~100 정수여야 합니다.");
  return { limit, write, json, comparePath };
}

async function readBaseline(path: string): Promise<AnalysisQualityReport> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as AnalysisQualityReport;
  if (!parsed || !Array.isArray(parsed.graphs) || typeof parsed.generatedAt !== "string") {
    throw new Error(`품질 기준선 파일 형식이 아닙니다: ${path}`);
  }
  return parsed;
}

async function writeBaseline(report: AnalysisQualityReport): Promise<string> {
  const dir = join(analysisLabDir(), "quality-baselines");
  const timestamp = report.generatedAt.replace(/[:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const path = join(dir, `quality-${timestamp}-${report.policyVersion}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

await main();
