// 반복형 구독 분석 에이전트가 새 모집 공고를 안전 후보 안에서 추가 선정하는 CLI.
// 분석 실행과 분리하며, 선정 결과는 cohort.json과 불변 evidence에만 기록한다.
import { randomUUID } from "node:crypto";
import { getLabBatchJobSnapshot } from "./batch-job";
import { resolveLabLlmBinding, resolveLabTransport } from "./claude-cli-transport";
import {
  AUTOMATIC_TARGET_SELECTION_MAX_COUNT,
  selectAutomaticAnalysisTargets,
} from "./target-selection";
import { SUBSCRIPTION_ANALYSIS_AGENT_MODELS } from "./subscription-analysis-agent-core";
import { assertAnalysisLabLiveExecutionAdmitted } from "./analysis-execution-admission";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";

loadAnalysisLabEnv();

async function main(): Promise<number> {
  const count = Number(readArg("count") ?? "30");
  const model = readArg("model")?.trim() || SUBSCRIPTION_ANALYSIS_AGENT_MODELS.selection;
  if (!Number.isInteger(count) || count < 1 || count > AUTOMATIC_TARGET_SELECTION_MAX_COUNT) {
    throw new Error(`--count는 1~${AUTOMATIC_TARGET_SELECTION_MAX_COUNT} 정수여야 합니다.`);
  }
  if (resolveLabTransport() !== "claude-cli") {
    throw new Error("신규 대상 선정은 ANALYSIS_LAB_TRANSPORT=claude-cli에서만 실행합니다.");
  }
  assertAnalysisLabLiveExecutionAdmitted();
  if (getLabBatchJobSnapshot().state === "running") {
    throw new Error("다른 분석 배치가 실행 중이므로 신규 대상을 선정할 수 없습니다.");
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
    changedBy: `local-target-selection:${process.pid}`,
    reason: "반복형 구독 분석 신규 공고 선정",
  });
  const timer = setInterval(() => {
    void renewLocalSubscriptionLease({ db, ownerId }).catch(() => undefined);
  }, 45_000);
  try {
    const binding = await resolveLabLlmBinding();
    if (binding.transport !== "claude-cli" || !binding.fetchImpl) {
      throw new Error("Claude 구독 transport 바인딩을 만들지 못했습니다.");
    }
    const result = await selectAutomaticAnalysisTargets({
      count,
      transport: binding.transport,
      apiKey: binding.apiKey,
      fetchImpl: binding.fetchImpl,
      model,
      allowFewer: process.argv.includes("--up-to"),
    });
    console.log(
      `[target-selection] 신규 ${result.selected.length}건 · 안전 후보 ${result.eligibleCandidateCount}건 · `
      + `${result.model}/claude-cli · API 비용 $0`,
    );
    for (const item of result.selected) {
      console.log(`  - [${item.stratum}] ${item.title} · ${item.grantId} · ${item.reason}`);
    }
    console.log(`[target-selection] 근거 저장: ${result.evidencePath}`);
    return 0;
  } finally {
    clearInterval(timer);
    await releaseLocalSubscriptionLease({
      db,
      ownerId,
      changedBy: `local-target-selection:${process.pid}`,
    }).catch(() => undefined);
  }
}

function readArg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
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
  console.error("[target-selection] 실패:", error instanceof Error ? error.message : error);
  await closeDbIfLoaded();
  process.exit(1);
});
