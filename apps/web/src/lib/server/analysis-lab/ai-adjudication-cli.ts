// 정확한 run ID로 좁힌 충돌 항목만 Opus 구독 모델이 최종 판정한다.
import { join } from "node:path";
import { AI_REVIEW_ADOPTED, type LabAudit, type LabRun } from "@/features/dev/analysis-lab/contract";
import {
  AI_ADJUDICATION_DEFAULT_MODEL,
  AI_ADJUDICATION_PROMPT_VERSION,
  runAiAdjudication,
  selectPendingAdjudicationItems,
} from "./ai-adjudication";
import { collectAiReviewsForAudit, readLabAuditFileAt } from "./audit-store";
import { resolveLabLlmBinding } from "./claude-cli-transport";
import { modelSlug } from "./run-store";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";

loadAnalysisLabEnv();

async function main(): Promise<number> {
  const runIds = readCsvArg("run-ids");
  const dryRun = process.argv.includes("--dry-run");
  const model = readArg("model")?.trim() || AI_ADJUDICATION_DEFAULT_MODEL;
  const maxCost = Number(readArg("max-cost-usd") ?? "10");
  if (!runIds || runIds.size === 0) {
    console.error("[ai-adjudicate] 안전을 위해 정확한 --run-ids=<id,...>가 필수입니다.");
    return 1;
  }
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    console.error("[ai-adjudicate] --max-cost-usd는 0보다 큰 숫자여야 합니다.");
    return 1;
  }
  const collected = await collectAiReviewsForAudit(AI_REVIEW_ADOPTED.model, { quiet: true });
  const targets: Array<{ run: LabRun; audit: LabAudit; pending: number }> = [];
  const found = new Set<string>();
  const slug = modelSlug(AI_REVIEW_ADOPTED.model);
  for (const item of collected) {
    if (!runIds.has(item.review.runId) || !item.run || item.run.error !== null) continue;
    found.add(item.review.runId);
    const audit = await readLabAuditFileAt(join(item.dir, `${item.review.runId}.audit.${slug}.json`));
    if (!audit) throw new Error(`감사 파일이 없습니다: ${item.review.runId}`);
    const pending = selectPendingAdjudicationItems(audit).length;
    if (pending > 0) targets.push({ run: item.run, audit, pending });
  }
  const missing = [...runIds].filter((runId) => !found.has(runId));
  if (missing.length > 0) throw new Error(`AI 검수 런을 찾지 못했습니다: ${missing.join(", ")}`);
  console.log(`[ai-adjudicate] ${targets.length}개 런 · 충돌 ${targets.reduce((sum, item) => sum + item.pending, 0)}항목 · ${model} · ${AI_ADJUDICATION_PROMPT_VERSION}`);
  for (const target of targets) console.log(`  - ${target.run.runId} · ${target.run.grantId} · ${target.pending}항목`);
  if (dryRun || targets.length === 0) return 0;

  const binding = await resolveLabLlmBinding();
  if (binding.transport !== "claude-cli") throw new Error("3차 판정은 ANALYSIS_LAB_TRANSPORT=claude-cli에서만 실행합니다.");
  let totalCost = 0;
  let applied = 0;
  for (const target of targets) {
    if (totalCost >= maxCost) break;
    const outcome = await runAiAdjudication({
      run: target.run,
      audit: target.audit,
      model,
      apiKey: binding.apiKey,
      ...(binding.fetchImpl ? { fetchImpl: binding.fetchImpl } : {}),
      transport: binding.transport,
    });
    if (outcome.status !== "adjudicated") {
      throw new Error(`${target.run.runId}: 3차 판정 미종결(${outcome.status})`);
    }
    applied += outcome.applied;
    totalCost += outcome.costUsd ?? 0;
    console.log(`[ai-adjudicate] 완료 ${target.run.runId} · ${outcome.applied}항목 · ${(outcome.durationMs / 1000).toFixed(1)}s · 명목 $${(outcome.costUsd ?? 0).toFixed(4)}`);
  }
  if (applied !== targets.reduce((sum, item) => sum + item.pending, 0)) {
    throw new Error(`3차 판정이 일부만 끝났습니다: ${applied}/${targets.reduce((sum, item) => sum + item.pending, 0)}`);
  }
  console.log(`[ai-adjudicate] 전체 종결 ${applied}항목 · 명목 $${totalCost.toFixed(4)} · API 비용 $0`);
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
  console.error("[ai-adjudicate] 실패:", error instanceof Error ? error.message : error);
  await closeDbIfLoaded();
  process.exit(1);
});
