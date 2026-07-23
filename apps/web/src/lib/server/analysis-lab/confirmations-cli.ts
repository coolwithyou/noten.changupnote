// 공모 딥분석 실험실 — 확정 결격 질문 경량 보강 CLI (tsx 단독 실행, dev 서버 불필요, DB read-only).
// 확인 루프 Phase B-0: v2 런에는 confirmation(자가신고 확인 질문)이 없으므로, 검수 확정
// 데이터가 있는 런의 correct exclusion criterion 만 대상으로 질문을 보강 생성한다.
//
// 실행: pnpm lab:confirmations -- [--dry-run] [--limit=50] [--max-cost-usd=3] [--model=...]
//                                 [--force] [--grantId=<uuid>]
//   대상: 사람 review.json 보유 런(selectReviewedRuns) + 감사 완료 병합 런
//   (loadAuditedConfirmedReviews) — aggregate 와 같은 공유 로더로 같은 선정 규칙을 쓴다.
//   그중 verdict=correct 확정 exclusion criterion 만 LLM 에 전달하며, v3 인라인 confirmation
//   보유 criterion 과 기존 사이드카 보유 런은 제외한다(--force 는 사이드카 재생성).
//   --dry-run 은 대상·예상 비용만 출력(API 호출 0).
// 주의: --dry-run 이 아니면 실제 Anthropic API 비용이 발생한다. 런·검수·감사 파일은 절대
//   건드리지 않으며, 쓰기는 사이드카 <runId>.confirmations.json 생성뿐이다.
import { existsSync } from "node:fs";
import { AI_REVIEW_ADOPTED, type LabReview, type LabRun } from "@/features/dev/analysis-lab/contract";
import { computeAiReviewCostUsd } from "./ai-review";
import { loadAuditedConfirmedReviews } from "./audited-reviews";
import {
  CONFIRMATIONS_PROMPT_VERSION,
  labConfirmationsFilePath,
  resolveConfirmationsModel,
  runConfirmations,
  selectConfirmationTargets,
  type ConfirmationTarget,
} from "./confirmations";
import { selectReviewedRuns } from "./reviewed-runs";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const DEFAULT_LIMIT = 50;
const CONCURRENCY = 2;
const DEFAULT_MAX_COST_USD = 3;

// ---- argv 파싱 (ai-audit-cli 관행) --------------------------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readNumberArg(name: string, fallback: number): number | null {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// 콘솔 표 정렬(전각 2칸) — ai-audit-cli 헬퍼 복제(그 파일은 CLI 라 import 불가).
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

function shortTitle(title: string, max = 30): string {
  let width = 0;
  let out = "";
  for (const ch of title) {
    width += WIDE_CHAR.test(ch) ? 2 : 1;
    if (width > max) return `${out}…`;
    out += ch;
  }
  return out;
}

function requireApiKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY 가 없습니다 — 모노레포 루트 .env(.env.local)를 확인하세요.");
  }
  return apiKey;
}

/**
 * 보강 비용 추정 — ai-audit CLI 추정식 동형. 입력은 추출 런 입력 토큰 + 규칙·criteria
 * 오버헤드 ~2K, 출력은 질문 몇 개 분량 ~1.5K(판정 태스크보다 짧다).
 */
function estimateConfirmationsCostUsd(model: string, run: LabRun): number | null {
  const inputTokens = (run.usage?.inputTokens ?? Math.round(run.inputTotalChars / 2)) + 2_000;
  return computeAiReviewCostUsd(model, { inputTokens, outputTokens: 1_500, cacheReadTokens: null });
}

interface ConfirmationTargetEntry {
  run: LabRun;
  review: LabReview;
  /** 검수 확정의 출처 — 사람 전수 검수(human) / AI 검수 + 감사 완료 병합(audited). */
  origin: "human" | "audited";
  targets: ConfirmationTarget[];
  sidecarPath: string;
}

async function main(): Promise<number> {
  const model = resolveConfirmationsModel(readArg("model"));
  const force = hasFlag("force");
  const dryRun = hasFlag("dry-run");
  const grantFilter = readArg("grantId")?.trim();
  const limit = readNumberArg("limit", DEFAULT_LIMIT);
  const maxCostUsd = readNumberArg("max-cost-usd", DEFAULT_MAX_COST_USD);
  if (limit === null || !Number.isInteger(limit) || limit < 1) {
    console.error("[confirmations] 설정 오류: --limit 은 1 이상의 정수여야 합니다.");
    return 1;
  }
  if (maxCostUsd === null || maxCostUsd <= 0) {
    console.error("[confirmations] 설정 오류: --max-cost-usd 는 0보다 큰 숫자여야 합니다.");
    return 1;
  }
  // 클로저(worker) 안에서도 non-null 로 좁혀지도록 별도 상수에 고정한다(ai-audit-cli 관행).
  const costCapUsd: number = maxCostUsd;

  console.log(`[confirmations] 보강 모델 ${model} · promptVersion=${CONFIRMATIONS_PROMPT_VERSION}`);

  // 대상 수집 — aggregate 가 쓰는 공유 로더 재사용(직접 재구현 금지, 계획 명세):
  //   ① 사람 review.json 보유 런(코호트 필터·dedupe 포함) ② 감사 완료 병합 런.
  const reviewedSelection = await selectReviewedRuns({ scanAll: false });
  const audited = await loadAuditedConfirmedReviews({ model: AI_REVIEW_ADOPTED.model, scanAll: false });

  // 같은 공고 중복은 사람 검수 우선(구조상 겹치지 않지만 — collectAiReviewsForAudit 가
  // 사람 검수 보유 공고를 제외한다 — 로더 규칙 변경에 대비한 방어).
  const byGrant = new Map<string, { run: LabRun; review: LabReview; origin: "human" | "audited" }>();
  for (const item of reviewedSelection.reviewed) {
    byGrant.set(item.run.grantId, { run: item.run, review: item.review, origin: "human" });
  }
  for (const item of audited.confirmed) {
    if (!byGrant.has(item.run.grantId)) {
      byGrant.set(item.run.grantId, { run: item.run, review: item.review, origin: "audited" });
    }
  }
  let pool = [...byGrant.values()];
  const humanCount = pool.filter((entry) => entry.origin === "human").length;
  if (grantFilter) pool = pool.filter((entry) => entry.run.grantId === grantFilter);

  let noTargetCount = 0;
  let sidecarSkipCount = 0;
  const eligible: ConfirmationTargetEntry[] = [];
  for (const entry of pool) {
    const targets = selectConfirmationTargets(entry.run, entry.review);
    if (targets.length === 0) {
      noTargetCount += 1;
      continue;
    }
    const sidecarPath = labConfirmationsFilePath(entry.run.source, entry.run.sourceId, entry.run.runId);
    if (!force && existsSync(sidecarPath)) {
      sidecarSkipCount += 1;
      continue;
    }
    eligible.push({ ...entry, targets, sidecarPath });
  }
  eligible.sort((a, b) => a.run.grantId.localeCompare(b.run.grantId));
  const batch = eligible.slice(0, limit);
  const batchCriterionCount = batch.reduce((sum, entry) => sum + entry.targets.length, 0);

  console.log(
    `[confirmations] 검수 확정 런 ${pool.length}건 스캔(사람 ${humanCount} · 감사 병합 ${pool.length - humanCount}` +
      `${audited.pending.length > 0 ? ` · 감사 미완 제외 ${audited.pending.length}` : ""}${grantFilter ? ` · --grantId 필터` : ""}) — ` +
      `질문 대상 없음 ${noTargetCount} · 사이드카 보유 스킵 ${sidecarSkipCount} · ` +
      `대상 ${eligible.length} → 이번 실행 ${batch.length}건 · 대상 criterion ${batchCriterionCount}건 ` +
      `(limit=${limit}${force ? " · --force 재생성" : ""})`,
  );
  if (batch.length === 0) {
    console.log("[confirmations] 실행 대상이 0건입니다 — 종료.");
    return 0;
  }

  const estimated = batch.reduce((sum, entry) => sum + (estimateConfirmationsCostUsd(model, entry.run) ?? 0), 0);
  console.log(`[confirmations] 예상 비용 ≈ $${estimated.toFixed(2)} (추출 런 입력 토큰 + 오버헤드 기반 추정)`);

  if (dryRun) {
    console.log("[confirmations] --dry-run — 대상 목록만 출력하고 종료합니다(API 호출 0).");
    for (const entry of batch) {
      console.log(
        `  - ${entry.run.grantId} · ${shortTitle(entry.run.title, 40)} · ${entry.run.runId} · ` +
          `[${entry.origin === "human" ? "사람 검수" : "감사 병합"}] 확정 exclusion ${entry.targets.length}건` +
          `(#${entry.targets.map((target) => target.criterionIndex).join(", #")}) · ` +
          `예상 $${(estimateConfirmationsCostUsd(model, entry.run) ?? 0).toFixed(3)}`,
      );
    }
    return 0;
  }

  const apiKey = requireApiKey();
  console.log(`[confirmations] 실행 시작 — concurrency=${CONCURRENCY} · max-cost-usd=$${costCapUsd}`);

  let okCount = 0;
  let failCount = 0;
  let refusalCount = 0;
  let driftCount = 0;
  let existsCount = 0;
  let generatedTotal = 0;
  let targetTotal = 0;
  let totalCostUsd = 0;
  let costCapped = false;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (costCapped) return;
      const index = nextIndex;
      if (index >= batch.length) return;
      nextIndex += 1;
      const entry = batch[index]!;
      const ordinal = `${index + 1}/${batch.length}`;
      const label = `${shortTitle(entry.run.title)} (${entry.run.runId})`;
      // 오류 1회 재시도 — ai-audit CLI 관행(HTTP 재시도와 별개의 겉 재시도).
      for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
        try {
          const outcome = await runConfirmations({
            run: entry.run,
            review: entry.review,
            model,
            apiKey,
            sidecarPath: entry.sidecarPath,
            force,
          });
          if (outcome.status === "input_drift") {
            driftCount += 1;
            console.warn(`[confirmations] (${ordinal}) 원문 드리프트 — 스킵: ${label}`);
          } else if (outcome.status === "refusal") {
            refusalCount += 1;
            console.warn(`[confirmations] (${ordinal}) 생성 거부(refusal): ${label}`);
          } else if (outcome.status === "exists") {
            // 사전 필터 후 생긴 파일(동시 실행 경합) — 멱등 스킵.
            existsCount += 1;
            console.log(`[confirmations] (${ordinal}) 사이드카 이미 존재 — 스킵: ${label}`);
          } else if (outcome.status === "no_targets") {
            console.log(`[confirmations] (${ordinal}) 질문 대상 없음 — 스킵: ${label}`);
          } else {
            okCount += 1;
            generatedTotal += outcome.generatedCount;
            targetTotal += outcome.targetCount;
            const cost = outcome.file.costUsd ?? 0;
            totalCostUsd += cost;
            console.log(
              `[confirmations] (${ordinal}) 완료: ${label} · ${(outcome.durationMs / 1000).toFixed(1)}s · ` +
                `질문 ${outcome.generatedCount}/${outcome.targetCount}건(비해당 생략 ${outcome.targetCount - outcome.generatedCount})` +
                ` · $${cost.toFixed(4)} · 누적 $${totalCostUsd.toFixed(4)}`,
            );
          }
          break;
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          if (attemptNo === 1) {
            console.warn(`[confirmations] (${ordinal}) 실패 — 1회 재시도: ${label} · ${message.slice(0, 200)}`);
            continue;
          }
          failCount += 1;
          console.error(`[confirmations] (${ordinal}) 실패(재시도 후에도): ${label} · ${message.slice(0, 400)}`);
        }
      }
      if (!costCapped && totalCostUsd >= costCapUsd) {
        costCapped = true;
        console.log(
          `[confirmations] 누적 비용 $${totalCostUsd.toFixed(4)} ≥ 상한 $${costCapUsd} — 신규 착수 중단(진행분은 완료).`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker()));

  console.log("\n===== 확정 결격 질문 보강 배치 요약 =====");
  console.log(
    `완료 ${okCount} · 실패 ${failCount} · 생성 거부 ${refusalCount} · 원문 드리프트 ${driftCount} · ` +
      `기존 파일 ${existsCount} · 미착수 ${batch.length - okCount - failCount - refusalCount - driftCount - existsCount}`,
  );
  console.log(
    `생성 질문 ${generatedTotal}건 / 대상 criterion ${targetTotal}건 (자가신고 비해당 생략 ${targetTotal - generatedTotal}건)` +
      ` · 총비용 $${totalCostUsd.toFixed(4)}${costCapped ? " · 비용 상한 도달" : ""}`,
  );
  return 0;
}

/** DB 커넥션이 로드된 경우에만 닫는다(dry-run 은 no-op) — ai-audit-cli 관행. */
async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 커넥션 정리 실패는 종료를 막지 않는다
  }
}

// verify 계열 스크립트의 커넥션 잔존 미종료 전례가 있어 명시적으로 정리·종료한다.
main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[confirmations] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });
