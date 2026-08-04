// 공모 딥분석 실험실 — 층화 확대 배치 러너 CLI (tsx 단독 실행, dev 서버 불필요).
// cohort.json(v2)의 entries 를 대상으로 runLabAnalysis 를 동시성 제한 워커 풀로 실행한다.
// 코어(스캔→기간 가드→워커 풀→가드 중단→요약)는 batch-runner.ts 로 추출됐다(2026-08-03
// §3-1) — 이 파일은 argv 파싱 + env 로드 + 이벤트의 콘솔 렌더 + exit code + 관측 브리지
// (batch-job.json 베스트에포트 기록 — 아래 CliBatchRecorder)만 담당하는 얇은 래퍼다.
// 로그 라인 포맷·exit code 는 추출 전과 동일해야 한다(합격선).
// **버전 무관** ok 런이 이미 있는 공고는 스킵(재개 멱등성 + 우발 재분석 가드 — Phase B-0,
// batch-plan.ts 상단 주석: v3 승격 여파로 v2 ok 런 30건이 통째로 재분석되는 ~$12 함정 차단).
// 구버전 ok 런 보유 공고의 현행 버전 재분석은 --reanalyze-outdated 로만 허용한다.
// 모집기간 정책(2026-07-23): 실행 시 각 공고의 현재 applyStart/applyEnd 를 확인해
// 마감·시작 전·기간 미상(applyEnd null)이면 사유 로그와 함께 스킵한다(비파괴).
// 실패는 analyze 가 error 런으로 저장하므로 배치는 기록만 하고 계속한다(런당 추가
// 재시도 없음 — extractor 내부에 이미 1회 재시도가 있다).
// 실행: pnpm lab:batch -- --dry-run                     (대상·예상 비용만, API 호출 0)
//       pnpm lab:batch -- --limit=10 --concurrency=2 --max-cost-usd=5
//       pnpm lab:batch -- --retry-errors                (현행 버전 error 런만 있는 공고도 대상 포함)
//       pnpm lab:batch -- --reanalyze-outdated          (구버전 ok 런만 있는 공고도 대상 포함)
//       ANALYSIS_LAB_TRANSPORT=claude-cli pnpm lab:batch -- --with-application-roundtrip
// 주의: --dry-run 이 아니면 실제 Anthropic API 비용이 발생한다. DB에는 어떤 쓰기도 하지 않는다.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabBatchJobSnapshot,
} from "@/features/dev/analysis-lab/contract";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { applyLabBatchEvent, labBatchJobFilePath } from "./batch-job";
import { partitionCohortEntries } from "./batch-plan";
import {
  LabCohortMissingError,
  PERIOD_SKIP_LABELS,
  estimatePerGrantCostUsd,
  runLabBatch,
  scanExistingRuns,
  type LabBatchEvent,
  type LabBatchPeriodSkipStatus,
  type LabBatchPeriodSkippedEntry,
  type LabBatchSummary,
  type LabBatchTransport,
} from "./batch-runner";
import { resolveLabTransport } from "./claude-cli-transport";
import { cohortFilePath, readCohortFileV2 } from "./cohort-file";
import { resolveLabModel } from "./extractor";

loadMonorepoEnv();

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
  /** 구버전 ok 런"만" 보유한 공고를 대상에 편입한다 — 우발 재분석 가드의 명시적 탈출구. */
  reanalyzeOutdated: boolean;
  withApplicationRoundtrip: boolean;
  roundtripModel?: string;
}

/** 옵션 검증 — 오류면 사유 문자열 반환(호출부에서 안내 후 exit 1). */
function parseOptions(): BatchOptions | string {
  const limit = readNumberArg("limit", DEFAULT_LIMIT);
  const concurrency = readNumberArg("concurrency", DEFAULT_CONCURRENCY);
  const maxCostUsd = readNumberArg("max-cost-usd", DEFAULT_MAX_COST_USD);
  const withApplicationRoundtrip = hasFlag("with-application-roundtrip");
  const roundtripModel = readArg("roundtrip-model")?.trim();
  if (limit === null || !Number.isInteger(limit) || limit < 1) {
    return "--limit 은 1 이상의 정수여야 합니다.";
  }
  if (concurrency === null || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return `--concurrency 는 1~${MAX_CONCURRENCY} 정수여야 합니다.`;
  }
  if (maxCostUsd === null || maxCostUsd <= 0) {
    return "--max-cost-usd 는 0보다 큰 숫자여야 합니다.";
  }
  if (roundtripModel !== undefined && roundtripModel.length === 0) {
    return "--roundtrip-model 은 비어 있을 수 없습니다.";
  }
  if (roundtripModel !== undefined && !withApplicationRoundtrip) {
    return "--roundtrip-model 은 --with-application-roundtrip 과 함께 지정해야 합니다.";
  }
  return {
    limit,
    concurrency,
    maxCostUsd,
    dryRun: hasFlag("dry-run"),
    retryErrors: hasFlag("retry-errors"),
    reanalyzeOutdated: hasFlag("reanalyze-outdated"),
    withApplicationRoundtrip,
    ...(roundtripModel !== undefined ? { roundtripModel } : {}),
  };
}

// ---- 콘솔 렌더(추출 전 로그 라인 포맷 그대로 — 합격선) --------------------------

function printCohortMissing(): void {
  console.error(`[batch] cohort.json 이 없거나 형식이 깨졌습니다: ${cohortFilePath()}`);
  console.error("[batch] 실험실 UI(/dev/analysis-lab) 또는 코호트 선정 CLI로 코호트를 먼저 생성해주세요.");
}

/** dry-run(래퍼 자체 계산)과 실행 경로(plan 이벤트)가 공유하는 계획 표시 값. */
interface PlanView {
  cohortTotal: number;
  cohortLabel: string | null;
  skippedOk: number;
  skippedOkOutdatedOnly: number;
  heldError: number;
  periodSkippedCount: number;
  runnable: number;
  targets: number;
}

function printPlanLines(view: PlanView, options: BatchOptions): void {
  console.log(
    `[batch] promptVersion=${ANALYSIS_LAB_PROMPT_VERSION} · 코호트 ${view.cohortTotal}건` +
      (view.cohortLabel ? ` (${view.cohortLabel})` : ""),
  );
  console.log(
    `[batch] 스킵(ok 런 보유·버전 무관) ${view.skippedOk}` +
      (view.skippedOkOutdatedOnly > 0
        ? ` (현행 ${view.skippedOk - view.skippedOkOutdatedOnly} · 구버전만 ${view.skippedOkOutdatedOnly})`
        : "") +
      ` · 보류(error 런만, --retry-errors 미지정) ${view.heldError} · 기간 스킵 ${view.periodSkippedCount} · 잔여 ${view.runnable} → 이번 실행 대상 ${view.targets}건 (limit=${options.limit}${options.reanalyzeOutdated ? " · --reanalyze-outdated" : ""})`,
  );
}

function printZeroTargetAdvisory(view: PlanView, options: BatchOptions): void {
  console.error("[batch] 실행 대상이 0건입니다 — 이미 전부 분석되었거나 보류·기간 스킵 상태입니다.");
  if (view.heldError > 0) console.error("[batch] error 런만 있는 공고를 재시도하려면 --retry-errors 를 지정하세요.");
  if (view.skippedOkOutdatedOnly > 0 && !options.reanalyzeOutdated) {
    console.error(
      `[batch] 구버전 ok 런만 보유한 공고 ${view.skippedOkOutdatedOnly}건은 우발 재분석 가드로 스킵됐습니다 — 현행 버전(${ANALYSIS_LAB_PROMPT_VERSION}) 재분석은 --reanalyze-outdated 를 지정하세요.`,
    );
  }
  if (view.periodSkippedCount > 0) {
    console.error(
      "[batch] 기간 미상 공고는 실험실 UI 카드에서 기간을 특정(저장)하면 대상에 편입됩니다.",
    );
  }
}

/** 예상 비용 — 현행 버전 ok 런 평균, 없으면 파일럿 실측 기본값. */
function printEstimateLine(perGrantUsd: number, sampleCount: number, targetCount: number): void {
  const basis = sampleCount > 0 ? `기존 ok 런 ${sampleCount}건 평균` : "파일럿 실측 기본값";
  console.log(
    `[batch] 예상 비용 ≈ $${(perGrantUsd * targetCount).toFixed(2)} (공고당 $${perGrantUsd.toFixed(4)}, ${basis})`,
  );
}

function printSummaryLines(args: {
  summary: LabBatchSummary;
  periodSkippedEntries: LabBatchPeriodSkippedEntry[];
  costCapSeen: boolean;
  windowExhaustedSeen: boolean;
}): void {
  const { summary } = args;
  console.log("\n===== 배치 요약 =====");
  console.log(
    `성공 ${summary.ok} · 실패(error 런) ${summary.errorRuns} · 실패(런 미저장) ${summary.unsavedFailures} · 미착수(비용 상한) ${summary.notStarted}`,
  );
  const periodSkipCounts = args.periodSkippedEntries.reduce(
    (acc, { status }) => {
      acc[status] += 1;
      return acc;
    },
    { closed: 0, not_started: 0, unknown: 0 } as Record<LabBatchPeriodSkipStatus, number>,
  );
  console.log(
    `스킵(ok·버전 무관) ${summary.skippedOk}` +
      (summary.skippedOkOutdatedOnly > 0 ? ` (구버전만 ${summary.skippedOkOutdatedOnly})` : "") +
      ` · 보류(error) ${summary.heldError} · 기간 스킵 ${summary.periodSkipped}` +
      (summary.periodSkipped > 0
        ? ` (마감 ${periodSkipCounts.closed} · 시작 전 ${periodSkipCounts.not_started} · 기간 미상 ${periodSkipCounts.unknown})`
        : ""),
  );
  console.log(
    `총비용 $${summary.totalCostUsd.toFixed(4)} · 소요 ${(summary.durationMs / 1000).toFixed(1)}s` +
      (args.costCapSeen ? " · 비용 상한 도달" : "") +
      (args.windowExhaustedSeen
        ? " · Max 사용량 윈도 소진 감지 — 신규 착수 중단, 윈도 리셋 후 같은 명령 재실행"
        : ""),
  );
}

// ---- dry-run (러너 미경유 — DB 미로드 불변식) -----------------------------------
// 기간 가드(DB)·analyze 로드 없이 계획만 출력한다. 러너는 기간 가드를 무조건 수행하므로
// dry-run 은 추출 전과 동일하게 스캔+분할만 직접 수행한다(scanExistingRuns 는 러너 export 재사용).

async function runDryRun(options: BatchOptions): Promise<number> {
  const cohort = await readCohortFileV2();
  if (!cohort) {
    printCohortMissing();
    return 1;
  }
  const { states, okCostSamples } = await scanExistingRuns();
  const partition = partitionCohortEntries(cohort.entries, states, {
    retryErrors: options.retryErrors,
    reanalyzeOutdated: options.reanalyzeOutdated,
  });
  const targets = partition.pending.slice(0, options.limit);
  const view: PlanView = {
    cohortTotal: cohort.entries.length,
    cohortLabel: cohort.experimentLabel,
    skippedOk: partition.skippedOk.length,
    skippedOkOutdatedOnly: partition.skippedOkOutdatedOnly.length,
    heldError: partition.heldError.length,
    periodSkippedCount: 0, // dry-run 은 기간 가드를 수행하지 않는다(아래 주의 문구)
    runnable: partition.pending.length,
    targets: targets.length,
  };
  printPlanLines(view, options);
  if (targets.length === 0) {
    printZeroTargetAdvisory(view, options);
    return 1;
  }
  const estimate = estimatePerGrantCostUsd(okCostSamples);
  printEstimateLine(estimate.perGrantUsd, estimate.sampleCount, targets.length);
  console.log("[batch] --dry-run — 대상 목록만 출력하고 종료합니다(API 호출 0).");
  console.log(
    "[batch] 주의: 모집기간 가드(마감·시작 전·기간 미상 스킵)는 DB 미로드 원칙상 dry-run 에 반영되지 않습니다 — 실제 실행 시 대상이 줄어들 수 있습니다.",
  );
  for (const target of targets) console.log(`  - [${target.stratum}] ${target.grantId}`);
  return 0;
}

// ---- 관측 브리지 — 웹 대시보드용 스냅샷 기록(베스트에포트, 2026-08-03) -------------
// CLI 배치 진행을 웹 잡 관리자(batch-job.ts)와 같은 파일(spike-out/analysis-lab/
// batch-job.json)에 **같은 LabBatchJobSnapshot 직렬화 형태**로 중계한다 — 웹 GET 폴백이
// origin "cli" + pid 생존 판정으로 running 을 그대로 노출한다. 반영 규칙(링 200·progress
// 누적)은 batch-job.ts 의 applyLabBatchEvent 를 공유한다(형태 단일 원천).
// 기록 실패는 전부 조용히 무시한다 — 배치 본연 동작(분석·로그·exit code)에 무영향.
// dry-run 경로는 무기록(파일 무접촉). 쓰기는 동기(writeFileSync) — 이벤트 간격(런당 수십 초)
// 대비 무시 가능한 비용이고, process.exit 가 비동기 쓰기를 자르는 함정을 원천 차단한다.

interface CliBatchRecorder {
  /** 러너 이벤트 반영 + 기록. finished 이벤트에서 종료 상태(finished/aborted)로 전이한다. */
  record: (event: LabBatchEvent) => void;
  /** 러너 자체 throw(인프라 실패) — state "error" 로 최종 기록한다. */
  fail: (message: string) => void;
}

const NOOP_RECORDER: CliBatchRecorder = { record: () => {}, fail: () => {} };

/** 관측 브리지 레코더 — 초기화 실패 시 무해한 no-op 로 강등된다(배치 본연 동작 무영향). */
function createCliBatchRecorder(options: BatchOptions, transport: LabBatchTransport): CliBatchRecorder {
  try {
    const path = labBatchJobFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const startedAt = new Date();
    const snapshot: LabBatchJobSnapshot = {
      // 웹 잡 관리자와 같은 jobId 규약(콜론 제거 ISO + 랜덤 6hex) — origin 이 출처를 가른다.
      jobId: `job-${startedAt.toISOString().replace(/:/g, "")}-${randomBytes(3).toString("hex")}`,
      state: "running",
      origin: "cli",
      pid: process.pid,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      options: {
        limit: options.limit,
        concurrency: options.concurrency,
        maxCostUsd: options.maxCostUsd,
        retryErrors: options.retryErrors,
        reanalyzeOutdated: options.reanalyzeOutdated,
        transport,
        model: resolveLabModel(),
        ...(options.withApplicationRoundtrip ? { withApplicationRoundtrip: true } : {}),
        ...(options.roundtripModel !== undefined ? { roundtripModel: options.roundtripModel } : {}),
      },
      progress: { total: 0, started: 0, ok: 0, error: 0, cumulativeCostUsd: 0 },
      guardStop: null,
      summary: null,
      events: [],
      error: null,
    };
    const persist = (): void => {
      try {
        writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");
      } catch {
        // 베스트에포트 — 디스크 실패가 배치 진행을 막으면 안 된다
      }
    };
    persist();
    return {
      record: (event) => {
        try {
          applyLabBatchEvent(snapshot, event);
          if (event.type === "finished") {
            // 웹 잡 관리자의 종료 전이와 동형 — Ctrl-C 등 비정상 종료는 기록 없이 남고,
            // 웹 폴백이 pid 사망으로 aborted 강등한다(설계된 경로).
            snapshot.state = event.summary.stopReason === "aborted" ? "aborted" : "finished";
            snapshot.finishedAt = new Date().toISOString();
          }
          persist();
        } catch {
          // 베스트에포트
        }
      },
      fail: (message) => {
        try {
          snapshot.state = "error";
          snapshot.error = message;
          snapshot.finishedAt = new Date().toISOString();
          persist();
        } catch {
          // 베스트에포트
        }
      },
    };
  } catch {
    return NOOP_RECORDER;
  }
}

// ---- 실행 경로(러너 위임 + 이벤트 콘솔 렌더) ------------------------------------

async function runBatchViaRunner(options: BatchOptions, transport: LabBatchTransport): Promise<number> {
  // 이벤트는 러너 안에서 동기 방출되므로 콘솔 라인 순서는 추출 전과 동일하다.
  const recorder = createCliBatchRecorder(options, transport);
  let planTargets = -1;
  let periodSkippedEntries: LabBatchPeriodSkippedEntry[] = [];
  let costCapSeen = false;
  let windowExhaustedSeen = false;
  try {
    await runLabBatch({
      limit: options.limit,
      concurrency: options.concurrency,
      maxCostUsd: options.maxCostUsd,
      retryErrors: options.retryErrors,
      reanalyzeOutdated: options.reanalyzeOutdated,
      ...(options.withApplicationRoundtrip ? { withApplicationRoundtrip: true } : {}),
      ...(options.roundtripModel !== undefined ? { roundtripModel: options.roundtripModel } : {}),
      onEvent: (event) => {
        recorder.record(event); // 관측 브리지 — 콘솔 렌더와 무관하게 베스트에포트 기록
        switch (event.type) {
          case "plan": {
            planTargets = event.targets;
            periodSkippedEntries = event.periodSkippedEntries;
            for (const skipped of event.periodSkippedEntries) {
              console.log(
                `[batch] 기간 정책 스킵: [${skipped.stratum}] ${skipped.grantId} · ${PERIOD_SKIP_LABELS[skipped.status]}`,
              );
            }
            const view: PlanView = {
              cohortTotal: event.total,
              cohortLabel: event.cohortLabel,
              skippedOk: event.skippedOk,
              skippedOkOutdatedOnly: event.skippedOkOutdatedOnly,
              heldError: event.heldError,
              periodSkippedCount: event.periodSkipped,
              runnable: event.runnable,
              targets: event.targets,
            };
            printPlanLines(view, options);
            if (event.targets === 0) {
              printZeroTargetAdvisory(view, options);
              break;
            }
            printEstimateLine(event.estimatedCostPerGrantUsd, event.costSampleCount, event.targets);
            console.log(
              `[batch] 실행 시작 — concurrency=${options.concurrency} · max-cost-usd=$${options.maxCostUsd}`,
            );
            break;
          }
          case "target-started":
            console.log(
              `[batch] (${event.index + 1}/${event.total}) 시작: [${event.stratum}] ${event.grantId}`,
            );
            break;
          case "target-ok": {
            const seconds = (event.durationMs / 1000).toFixed(1);
            console.log(
              `[batch] (${event.index + 1}/${event.total}) ok: [${event.stratum}] ${event.title} · ${seconds}s · $${(event.costUsd ?? 0).toFixed(4)} · 누적 $${event.cumulativeCostUsd.toFixed(4)}`,
            );
            break;
          }
          case "target-error": {
            const seconds = (event.durationMs / 1000).toFixed(1);
            if (event.runSaved) {
              console.log(
                `[batch] (${event.index + 1}/${event.total}) error 런 저장: [${event.stratum}] ${event.title ?? event.grantId} · ${seconds}s · ${event.message.slice(0, 160)}`,
              );
            } else {
              console.error(
                `[batch] (${event.index + 1}/${event.total}) 실패(런 미저장): [${event.stratum}] ${event.grantId} · ${seconds}s · ${event.message}`,
              );
            }
            break;
          }
          case "guard-stop":
            if (event.reason === "cost-cap") {
              costCapSeen = true;
              console.log(
                `[batch] 누적 비용 $${event.cumulativeCostUsd.toFixed(4)} ≥ 상한 $${options.maxCostUsd} — 신규 착수를 중단합니다(진행분은 완료).`,
              );
            } else {
              windowExhaustedSeen = true;
              console.log(
                "[batch] Max 사용량 윈도 소진 감지 — 신규 착수를 중단합니다(진행분은 완료). 윈도 리셋 후 같은 명령으로 재실행하세요.",
              );
            }
            break;
          case "finished":
            if (planTargets !== 0) {
              printSummaryLines({
                summary: event.summary,
                periodSkippedEntries,
                costCapSeen,
                windowExhaustedSeen,
              });
            }
            break;
        }
      },
    });
  } catch (caught) {
    // 러너 자체 throw — 웹 잡 관리자의 state "error" 흡수와 동형으로 최종 기록한다.
    recorder.fail(caught instanceof Error ? caught.message : String(caught));
    if (caught instanceof LabCohortMissingError) {
      printCohortMissing();
      return 1;
    }
    throw caught; // 그 외는 부트스트랩 .catch 가 "[batch] 실패:" + exit 1 로 처리(추출 전과 동일)
  }
  return planTargets === 0 ? 1 : 0;
}

// ---- 메인 ---------------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseOptions();
  if (typeof options === "string") {
    console.error(`[batch] 설정 오류: ${options}`);
    return 1;
  }

  // 전송층 선검증(계획 §5 #6-②) — env 오타(resolveLabTransport throw)를 배치 시작 전에 fail-fast.
  const transport = resolveLabTransport();
  if (options.withApplicationRoundtrip && transport !== "claude-cli") {
    console.error(
      "[batch] 설정 오류: --with-application-roundtrip 은 현재 로컬 Max 구독 transport(ANALYSIS_LAB_TRANSPORT=claude-cli)에서만 허용됩니다.",
    );
    return 1;
  }
  if (transport === "claude-cli") {
    console.log("[batch] transport=claude-cli — Max 구독(claude CLI) 경유로 실행합니다(API 토큰 미지출, 명목 비용만 집계).");
  }
  if (options.withApplicationRoundtrip) {
    console.log(
      `[batch] Kordoc 지원 양식 선분석을 딥 분석과 함께 실행합니다` +
        (options.roundtripModel ? ` (model=${options.roundtripModel})` : " (딥 분석 모델 상속)"),
    );
  }

  if (options.dryRun) return runDryRun(options); // 무기록 — 관측 브리지는 실행 경로 전용
  return runBatchViaRunner(options, transport);
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
