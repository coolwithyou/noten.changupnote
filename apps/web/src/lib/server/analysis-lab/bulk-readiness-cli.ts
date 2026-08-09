import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LabBatchJobSnapshot } from "@/features/dev/analysis-lab/contract";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/features/dev/analysis-lab/contract";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import {
  evaluateAnalysisBulkReadiness,
  writeAnalysisBulkReadinessArtifact,
  type AnalysisBulkReadinessStage,
} from "./bulk-readiness";
import { loadAnalysisQualityGraphForRun } from "./quality-report";
import { analysisLabDir, readLatestLabRunIndexForPrompt } from "./run-store";

loadAnalysisLabEnv();

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const snapshot = JSON.parse(await readFile(options.batchJobPath, "utf8")) as LabBatchJobSnapshot;
  if (!snapshot || !Array.isArray(snapshot.events)) throw new Error("batch job snapshot 형식이 아닙니다.");
  const targetIds = [...new Set(snapshot.events
    .filter((event) => event.type === "target-started")
    .sort((left, right) => left.index - right.index)
    .map((event) => event.grantId))];
  const index = await readLatestLabRunIndexForPrompt(ANALYSIS_LAB_PROMPT_VERSION);
  const runs = new Map(targetIds.flatMap((grantId) => {
    const run = index.get(grantId);
    return run ? [[grantId, run] as const] : [];
  }));
  const graphEntries = await Promise.all([...runs].map(async ([grantId, run]) =>
    [grantId, await loadAnalysisQualityGraphForRun(run)] as const));
  const artifact = evaluateAnalysisBulkReadiness({
    stage: options.stage,
    snapshot,
    runs,
    graphs: new Map(graphEntries),
  });
  console.log(`대량 분석 준비 ${artifact.stage}: ${artifact.verdict}`);
  for (const gate of artifact.gates) console.log(`- ${gate.status}: ${gate.label} · ${gate.summary}`);
  if (artifact.nextActions.length > 0) {
    console.log("다음 조치:");
    for (const action of artifact.nextActions) console.log(`- ${action}`);
  }
  if (options.write && artifact.verdict !== "WAIT") {
    console.log(`증거 저장: ${await writeAnalysisBulkReadinessArtifact(artifact)}`);
  }
  return artifact.verdict === "GO" ? 0 : artifact.verdict === "WAIT" ? 3 : 2;
}

function parseOptions(args: string[]): {
  stage: AnalysisBulkReadinessStage;
  batchJobPath: string;
  write: boolean;
} {
  let stage: AnalysisBulkReadinessStage | null = null;
  let batchJobPath = join(analysisLabDir(), "batch-job.json");
  let write = false;
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--write") write = true;
    else if (arg.startsWith("--stage=")) {
      const value = arg.slice("--stage=".length);
      if (value !== "pilot5" && value !== "batch30") throw new Error("--stage는 pilot5 또는 batch30이어야 합니다.");
      stage = value;
    } else if (arg.startsWith("--batch-job=")) {
      batchJobPath = resolve(arg.slice("--batch-job=".length));
    } else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (!stage) throw new Error("--stage=pilot5|batch30이 필요합니다.");
  return { stage, batchJobPath, write };
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error("[bulk-readiness] 실패:", error instanceof Error ? error.message : error);
  process.exit(1);
});
