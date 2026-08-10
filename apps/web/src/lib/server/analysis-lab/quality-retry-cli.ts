// 품질 그래프에서 원인이 확정된 공고만 현행 Opus/Kordoc 계약으로 다시 분석한다.
// 일반 배치의 current-ok 멱등 가드는 유지하고, 이 CLI는 정확한 grantIds + reason을
// 필수로 요구하는 제한된 탈출구다.
import { randomUUID } from "node:crypto";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/features/dev/analysis-lab/contract";
import type { AnalysisQualityNodeId } from "@/features/dev/analysis-lab/quality-contract";
import { getLabBatchJobSnapshot } from "./batch-job";
import { loadAnalysisQualityGraphForRun } from "./quality-report";
import { readLatestLabRunIndexForPrompt } from "./run-store";
import { runLabAnalysis } from "./analyze";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";

loadAnalysisLabEnv();

type RetryReason = "application" | "deep_contract";

async function main(): Promise<number> {
  const grantIds = readCsvArg("grant-ids");
  const reason = readReason();
  const dryRun = process.argv.includes("--dry-run");
  if (!grantIds || grantIds.size === 0) {
    throw new Error("안전을 위해 정확한 --grant-ids=<uuid,...>가 필요합니다.");
  }
  if ((process.env.ANALYSIS_LAB_TRANSPORT ?? "").trim() !== "claude-cli") {
    throw new Error("품질 재분석은 ANALYSIS_LAB_TRANSPORT=claude-cli에서만 실행합니다.");
  }
  if (getLabBatchJobSnapshot().state === "running") {
    throw new Error("다른 분석 배치가 실행 중이므로 품질 재분석을 시작할 수 없습니다.");
  }

  const index = await readLatestLabRunIndexForPrompt(ANALYSIS_LAB_PROMPT_VERSION);
  const targets = await Promise.all([...grantIds].map(async (grantId) => {
    const run = index.get(grantId);
    if (!run || run.error !== null) throw new Error(`현행 성공 런을 찾지 못했습니다: ${grantId}`);
    const graph = await loadAnalysisQualityGraphForRun(run);
    const retryNodes = retryNodeIds(reason);
    const issues = graph.nodes.filter((node) =>
      retryNodes.has(node.id) && (node.status === "held" || node.status === "failed"));
    if (issues.length === 0) {
      throw new Error(`${reason} 재분석 근거가 품질 그래프에 없습니다: ${grantId}`);
    }
    return { run, issues };
  }));

  console.log(`[repair-quality] ${reason} · 정확한 대상 ${targets.length}건 · claude-opus-5/claude-cli`);
  for (const target of targets) {
    console.log(`  - ${target.run.grantId} · ${target.run.runId} · ${target.issues.map((node) => node.label).join(", ")}`);
  }
  if (dryRun) return 0;

  const { getCunoteDb } = await import("../db/client");
  const {
    acquireLocalSubscriptionLease,
    releaseLocalSubscriptionLease,
    renewLocalSubscriptionLease,
  } = await import("../deep-analysis/runtimeControl");
  const db = getCunoteDb();
  const ownerId = randomUUID();
  await acquireLocalSubscriptionLease({
    db,
    ownerId,
    changedBy: `local-quality-retry:${process.pid}`,
    reason: `품질 그래프 제한 재분석: ${reason}`,
  });
  const timer = setInterval(() => {
    void renewLocalSubscriptionLease({ db, ownerId }).catch(() => undefined);
  }, 45_000);
  try {
    for (const target of targets) {
      const result = await runLabAnalysis(target.run.grantId, {
        transport: "claude-cli",
        model: "claude-opus-5",
        withApplicationRoundtrip: true,
        roundtripModel: "claude-opus-5",
      });
      if (result.error) throw new Error(`${result.grantId}: 재분석 실패: ${result.error}`);
      console.log(
        `[repair-quality] 완료 ${result.grantId} · ${result.runId} · `
        + `criteria ${result.criteria.length} · Kordoc ${result.applicationRoundtrip?.status ?? "미실행"}`,
      );
    }
  } finally {
    clearInterval(timer);
    await releaseLocalSubscriptionLease({
      db,
      ownerId,
      changedBy: `local-quality-retry:${process.pid}`,
    }).catch(() => undefined);
  }
  return 0;
}

function retryNodeIds(reason: RetryReason): ReadonlySet<AnalysisQualityNodeId> {
  return reason === "application"
    ? new Set(["application_source", "field_adjudication"])
    : new Set(["input_sealed", "deep_contract"]);
}

function readReason(): RetryReason {
  const value = readArg("reason");
  if (value === "application" || value === "deep_contract") return value;
  throw new Error("--reason은 application 또는 deep_contract여야 합니다.");
}

function readArg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function readCsvArg(name: string): Set<string> | null {
  const raw = readArg(name);
  if (raw === undefined) return null;
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // no-op
  }
}

main().then(async (code) => {
  await closeDbIfLoaded();
  process.exit(code);
}).catch(async (error) => {
  console.error("[repair-quality] 실패:", error instanceof Error ? error.message : error);
  await closeDbIfLoaded();
  process.exit(1);
});
