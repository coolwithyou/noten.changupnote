// 공모 딥분석 실험실 — 층화 확대 배치 러너 CLI (tsx 단독 실행, dev 서버 불필요).
// cohort.json(v2)의 entries 를 대상으로 runLabAnalysis 를 동시성 제한 워커 풀로 실행한다.
// 현행 ANALYSIS_LAB_PROMPT_VERSION 의 ok 런이 이미 있는 공고는 스킵(재개 멱등성).
// 실패는 analyze 가 error 런으로 저장하므로 배치는 기록만 하고 계속한다(런당 추가
// 재시도 없음 — extractor 내부에 이미 1회 재시도가 있다).
// 실행: pnpm lab:batch -- --dry-run                     (대상·예상 비용만, API 호출 0)
//       pnpm lab:batch -- --limit=10 --concurrency=2 --max-cost-usd=5
//       pnpm lab:batch -- --retry-errors                (현행 버전 error 런만 있는 공고도 대상 포함)
// 주의: --dry-run 이 아니면 실제 Anthropic API 비용이 발생한다. DB에는 어떤 쓰기도 하지 않는다.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/features/dev/analysis-lab/contract";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { cohortFilePath, readCohortFileV2, type CohortEntry } from "./cohort-file";
import { analysisLabDir } from "./run-store";

loadMonorepoEnv();

/** 파일럿 실측 공고당 비용(계획 문서 §4 "비용·시간") — 기존 ok 런이 없을 때의 추정 기준. */
const FALLBACK_COST_PER_GRANT_USD = 0.395;
const DEFAULT_LIMIT = 10;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 3;
const DEFAULT_MAX_COST_USD = 5;

// ---- argv 파싱 (라이브러리 없이 smoke.ts 관행) ---------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** 숫자 옵션 파싱 — 미지정이면 fallback, 형식 오류면 null(설정 오류로 exit 1). */
function readNumberArg(name: string, fallback: number): number | null {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

interface BatchOptions {
  limit: number;
  concurrency: number;
  maxCostUsd: number;
  dryRun: boolean;
  retryErrors: boolean;
}

/** 옵션 검증 — 오류면 사유 문자열 반환(호출부에서 안내 후 exit 1). */
function parseOptions(): BatchOptions | string {
  const limit = readNumberArg("limit", DEFAULT_LIMIT);
  const concurrency = readNumberArg("concurrency", DEFAULT_CONCURRENCY);
  const maxCostUsd = readNumberArg("max-cost-usd", DEFAULT_MAX_COST_USD);
  if (limit === null || !Number.isInteger(limit) || limit < 1) {
    return "--limit 은 1 이상의 정수여야 합니다.";
  }
  if (concurrency === null || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return `--concurrency 는 1~${MAX_CONCURRENCY} 정수여야 합니다.`;
  }
  if (maxCostUsd === null || maxCostUsd <= 0) {
    return "--max-cost-usd 는 0보다 큰 숫자여야 합니다.";
  }
  return { limit, concurrency, maxCostUsd, dryRun: hasFlag("dry-run"), retryErrors: hasFlag("retry-errors") };
}

// ---- 기존 런 스캔(스킵 판정) ---------------------------------------------------
// grantId→경로 매핑이 없으므로 spike-out/analysis-lab/<source>__<sourceId>/ 를 전수
// 스캔한다(run-store.readLabRun 과 같은 접근 — dev 실험실 규모라 비용 무시 가능).

interface GrantRunState {
  /** 현행 promptVersion 의 ok 런 존재 → 스킵. */
  okCurrent: boolean;
  /** 현행 promptVersion 의 error 런 존재 → --retry-errors 없으면 보류. */
  errorCurrent: boolean;
}

interface RunScan {
  states: Map<string, GrantRunState>;
  /** 현행 버전 ok 런들의 costUsd 표본 — dry-run 예상 비용의 근거. */
  okCostSamples: number[];
}

async function scanExistingRuns(): Promise<RunScan> {
  const states = new Map<string, GrantRunState>();
  const okCostSamples: number[] = [];
  const root = analysisLabDir();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return { states, okCostSamples }; // 산출물 디렉토리 자체가 없으면 전원 미분석
  }
  for (const entry of entries) {
    if (!entry.includes("__")) continue; // cohort.json 등 파일 제외
    let files: string[] = [];
    try {
      files = await readdir(join(root, entry));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith("run-") || !file.endsWith(".json") || file.endsWith(".review.json")) continue;
      let parsed: { grantId?: unknown; promptVersion?: unknown; error?: unknown; costUsd?: unknown };
      try {
        parsed = JSON.parse(await readFile(join(root, entry, file), "utf8")) as typeof parsed;
      } catch {
        continue; // 깨진 파일은 판정에서 제외(불변 저장소라 원본은 건드리지 않는다)
      }
      if (typeof parsed.grantId !== "string" || parsed.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION) continue;
      const ok = parsed.error === null;
      const state = states.get(parsed.grantId) ?? { okCurrent: false, errorCurrent: false };
      if (ok) {
        state.okCurrent = true;
        if (typeof parsed.costUsd === "number") okCostSamples.push(parsed.costUsd);
      } else {
        state.errorCurrent = true;
      }
      states.set(parsed.grantId, state);
    }
  }
  return { states, okCostSamples };
}

// ---- 실행(동시성 제한 워커 풀) -------------------------------------------------

interface BatchOutcome {
  okCount: number;
  errorRunCount: number; // error 런으로 저장된 실패
  thrownCount: number; // 런 저장 없이 던져진 실패(공고 미존재 등)
  startedCount: number;
  totalCostUsd: number;
  costCapped: boolean;
}

async function runTargets(targets: CohortEntry[], options: BatchOptions): Promise<BatchOutcome> {
  // dry-run 경로가 DB 모듈을 아예 로드하지 않도록 실행 시점에만 가져온다(read-only 신뢰).
  const { runLabAnalysis } = await import("./analyze");
  const outcome: BatchOutcome = {
    okCount: 0,
    errorRunCount: 0,
    thrownCount: 0,
    startedCount: 0,
    totalCostUsd: 0,
    costCapped: false,
  };
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (outcome.costCapped) return; // 상한 도달 — 신규 착수만 중단(진행분은 각 워커가 완료)
      const index = nextIndex;
      if (index >= targets.length) return;
      nextIndex += 1;
      const target = targets[index]!;
      const ordinal = `${index + 1}/${targets.length}`;
      outcome.startedCount += 1;
      console.log(`[batch] (${ordinal}) 시작: [${target.stratum}] ${target.grantId}`);
      const startedMs = Date.now();
      try {
        const run = await runLabAnalysis(target.grantId);
        const seconds = ((Date.now() - startedMs) / 1000).toFixed(1);
        const cost = run.costUsd ?? 0;
        outcome.totalCostUsd += cost;
        if (run.error === null) {
          outcome.okCount += 1;
          console.log(
            `[batch] (${ordinal}) ok: [${target.stratum}] ${run.title} · ${seconds}s · $${cost.toFixed(4)} · 누적 $${outcome.totalCostUsd.toFixed(4)}`,
          );
        } else {
          outcome.errorRunCount += 1;
          console.log(
            `[batch] (${ordinal}) error 런 저장: [${target.stratum}] ${run.title} · ${seconds}s · ${run.error.slice(0, 160)}`,
          );
        }
      } catch (caught) {
        // 공고 미존재(LabGrantNotFoundError) 등 — 런 저장 없이 실패. 기록하고 계속.
        outcome.thrownCount += 1;
        const seconds = ((Date.now() - startedMs) / 1000).toFixed(1);
        console.error(
          `[batch] (${ordinal}) 실패(런 미저장): [${target.stratum}] ${target.grantId} · ${seconds}s · ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
      if (!outcome.costCapped && outcome.totalCostUsd >= options.maxCostUsd) {
        outcome.costCapped = true;
        console.log(
          `[batch] 누적 비용 $${outcome.totalCostUsd.toFixed(4)} ≥ 상한 $${options.maxCostUsd} — 신규 착수를 중단합니다(진행분은 완료).`,
        );
      }
    }
  }

  const workerCount = Math.min(options.concurrency, targets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return outcome;
}

// ---- 메인 ---------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseOptions();
  if (typeof options === "string") {
    console.error(`[batch] 설정 오류: ${options}`);
    return 1;
  }

  const cohort = await readCohortFileV2();
  if (!cohort) {
    console.error(`[batch] cohort.json 이 없거나 형식이 깨졌습니다: ${cohortFilePath()}`);
    console.error("[batch] 실험실 UI(/dev/analysis-lab) 또는 코호트 선정 CLI로 코호트를 먼저 생성해주세요.");
    return 1;
  }

  const { states, okCostSamples } = await scanExistingRuns();
  const skippedOk: CohortEntry[] = [];
  const heldError: CohortEntry[] = [];
  const pending: CohortEntry[] = [];
  for (const entry of cohort.entries) {
    const state = states.get(entry.grantId);
    if (state?.okCurrent) skippedOk.push(entry);
    else if (state?.errorCurrent && !options.retryErrors) heldError.push(entry);
    else pending.push(entry);
  }
  const targets = pending.slice(0, options.limit);

  console.log(
    `[batch] promptVersion=${ANALYSIS_LAB_PROMPT_VERSION} · 코호트 ${cohort.entries.length}건` +
      (cohort.experimentLabel ? ` (${cohort.experimentLabel})` : ""),
  );
  console.log(
    `[batch] 스킵(ok 런 보유) ${skippedOk.length} · 보류(error 런만, --retry-errors 미지정) ${heldError.length} · 잔여 ${pending.length} → 이번 실행 대상 ${targets.length}건 (limit=${options.limit})`,
  );

  if (targets.length === 0) {
    console.error("[batch] 실행 대상이 0건입니다 — 이미 전부 분석되었거나 보류 상태입니다.");
    if (heldError.length > 0) console.error("[batch] error 런만 있는 공고를 재시도하려면 --retry-errors 를 지정하세요.");
    return 1;
  }

  // 예상 비용 — 현행 버전 ok 런 평균, 없으면 파일럿 실측 기본값.
  const perGrant =
    okCostSamples.length > 0
      ? okCostSamples.reduce((sum, cost) => sum + cost, 0) / okCostSamples.length
      : FALLBACK_COST_PER_GRANT_USD;
  const basis = okCostSamples.length > 0 ? `기존 ok 런 ${okCostSamples.length}건 평균` : "파일럿 실측 기본값";
  console.log(`[batch] 예상 비용 ≈ $${(perGrant * targets.length).toFixed(2)} (공고당 $${perGrant.toFixed(4)}, ${basis})`);

  if (options.dryRun) {
    console.log("[batch] --dry-run — 대상 목록만 출력하고 종료합니다(API 호출 0).");
    for (const target of targets) console.log(`  - [${target.stratum}] ${target.grantId}`);
    return 0;
  }

  console.log(`[batch] 실행 시작 — concurrency=${options.concurrency} · max-cost-usd=$${options.maxCostUsd}`);
  const startedMs = Date.now();
  const outcome = await runTargets(targets, options);
  const notStarted = targets.length - outcome.startedCount;

  console.log("\n===== 배치 요약 =====");
  console.log(
    `성공 ${outcome.okCount} · 실패(error 런) ${outcome.errorRunCount} · 실패(런 미저장) ${outcome.thrownCount} · 미착수(비용 상한) ${notStarted}`,
  );
  console.log(`스킵(ok) ${skippedOk.length} · 보류(error) ${heldError.length}`);
  console.log(
    `총비용 $${outcome.totalCostUsd.toFixed(4)} · 소요 ${((Date.now() - startedMs) / 1000).toFixed(1)}s` +
      (outcome.costCapped ? " · 비용 상한 도달" : ""),
  );
  return 0;
}

/** 실행 경로에서만 DB 커넥션이 생기므로, 로드된 경우에 한해 닫는다(dry-run 은 no-op). */
async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 커넥션 정리 실패는 종료를 막지 않는다
  }
}

// verify 계열 스크립트가 커넥션 잔존으로 안 죽는 기존 현상이 있어, 명시적으로 정리·종료한다.
main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[batch] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });
