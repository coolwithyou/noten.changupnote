import { randomUUID } from "node:crypto";
import { AI_REVIEW_ADOPTED } from "@/features/dev/analysis-lab/contract";
import { getLabBatchJobSnapshot } from "./batch-job";
import { loadAuditedConfirmedReviews } from "./audited-reviews";
import { runLabAnalysis } from "./analyze";
import { AI_ADJUDICATION_DEFAULT_MODEL } from "./ai-adjudication";
import { buildHeldReviewRepairPlan } from "./held-review-repair";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";

loadAnalysisLabEnv();

async function main(): Promise<number> {
  const grantIds = readCsvArg("grant-ids");
  const dryRun = process.argv.includes("--dry-run");
  if (!grantIds || grantIds.size === 0) {
    console.error("[repair-held] 안전을 위해 정확한 --grant-ids=<uuid,...>가 필수입니다.");
    return 1;
  }
  const batch = getLabBatchJobSnapshot();
  if (batch.state === "running") {
    console.error(`[repair-held] 배치 ${batch.jobId}가 실행 중이므로 동시 모델 실행을 거부합니다.`);
    return 1;
  }
  const selection = await loadAuditedConfirmedReviews({ model: AI_REVIEW_ADOPTED.model, scanAll: true });
  const confirmedByGrant = new Map(selection.confirmed.map((item) => [item.run.grantId, item]));
  const plans = [...grantIds].map((grantId) => {
    const source = confirmedByGrant.get(grantId);
    if (!source) throw new Error(`완료된 현행 독립 검수를 찾지 못했습니다: ${grantId}`);
    const plan = buildHeldReviewRepairPlan({ run: source.run, review: source.review });
    if (!plan) throw new Error(`신청자격 blocker가 없는 공고는 재분석하지 않습니다: ${grantId}`);
    return { source, plan };
  });
  console.log(`[repair-held] 정확한 대상 ${plans.length}건 · blocker ${plans.reduce((sum, item) => sum + item.plan.blockingCount, 0)}건 · ${AI_ADJUDICATION_DEFAULT_MODEL}/claude-cli`);
  for (const item of plans) {
    console.log(`  - ${item.source.run.grantId} · ${item.source.run.runId} · ${item.plan.blockingCount} blocker`);
  }
  if (dryRun) return 0;
  if ((process.env.ANALYSIS_LAB_TRANSPORT ?? "").trim() !== "claude-cli") {
    throw new Error("held 재분석은 ANALYSIS_LAB_TRANSPORT=claude-cli에서만 실행합니다.");
  }

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
    changedBy: `local-review-repair:${process.pid}`,
    reason: "독립 검수 blocker 구독 모델 재분석",
  });
  const renewal = setInterval(() => {
    void renewLocalSubscriptionLease({ db, ownerId }).catch(() => undefined);
  }, 45_000);
  try {
    for (const item of plans) {
      const result = await runLabAnalysis(item.source.run.grantId, {
        transport: "claude-cli",
        model: AI_ADJUDICATION_DEFAULT_MODEL,
        withApplicationRoundtrip: true,
        roundtripModel: AI_ADJUDICATION_DEFAULT_MODEL,
        taskInstruction: item.plan.taskInstruction,
        reviewRepair: {
          sourceRunId: item.source.run.runId,
          reviewModel: item.source.provenance.model,
          auditModel: item.source.provenance.aiAuditModel,
          adjudicationModel: item.source.provenance.aiAdjudicationModel,
          blockingCount: item.plan.blockingCount,
        },
      });
      if (result.error) throw new Error(`${result.grantId}: 재분석 실패: ${result.error}`);
      console.log(`[repair-held] 완료 ${result.grantId} · ${result.runId} · criteria ${result.criteria.length} · Kordoc ${result.applicationRoundtrip?.status ?? "미실행"}`);
    }
  } finally {
    clearInterval(renewal);
    await releaseLocalSubscriptionLease({
      db,
      ownerId,
      changedBy: `local-review-repair:${process.pid}`,
    }).catch(() => undefined);
  }
  return 0;
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
  console.error("[repair-held] 실패:", error instanceof Error ? error.message : error);
  await closeDbIfLoaded();
  process.exit(1);
});
