// 공모 딥분석 실험실 — 층화 확대 배치 러너 코어 (batch.ts CLI 에서 추출, 2026-08-03 §3-1).
// 스캔(scanExistingRuns) → 기간 가드(splitByPeriodPolicy) → 워커 풀 → 가드 중단(비용
// 상한·윈도 소진·abort) → 요약을 담당하고, 진행은 전부 onEvent 로 방출한다.
// 호출부 계약(CLI batch.ts · 웹 배치 잡이 공유):
// - 이 모듈은 console 출력·process.exit·env 로드(loadMonorepoEnv)를 하지 않는다 — 래퍼 책임.
// - DB 모듈(../db/*)과 analyze.ts 는 실행 시점 동적 import 로만 로드한다. 이 모듈을 import
//   하는 것만으로는 DB 가 로드되지 않는다(CLI dry-run 의 "DB 미로드" 불변식이 여기에 의존).
// - transport/model 오버라이드는 진입 시 1회 해석(오타 fail-fast)해 runLabAnalysis 로
//   전달한다. 미지정 시 기존 env 경로(ANALYSIS_LAB_TRANSPORT/ANALYSIS_LAB_MODEL) 그대로다.
// - 이벤트/서머리 타입의 모양은 contract.ts(LabBatchEvent/LabBatchSummary)가 단일 원천이다
//   (§3-4 단일 원천화) — 이 파일은 계약의 additive 옵셔널 필드를 Required 로 좁힌 러너 관점
//   별칭만 export 한다(아래 LabBatchEvent 주석 참조).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabBatchEvent as LabBatchEventContract,
  type LabBatchPeriodSkipStatus,
  type LabBatchPeriodSkippedEntry,
  type LabBatchSummary,
} from "@/features/dev/analysis-lab/contract";
import { classifyNoticePeriod } from "@/features/dev/analysis-lab/notice-period";
import { partitionCohortEntries, type GrantRunState } from "./batch-plan";
import { CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER, resolveLabTransport } from "./claude-cli-transport";
import { cohortFilePath, readCohortFileV2, type CohortEntry, type CohortFileV2 } from "./cohort-file";
import { analysisLabDir } from "./run-store";

// ---- 공개 계약 -----------------------------------------------------------------

export type LabBatchTransport = "api" | "claude-cli";

export interface LabBatchRunnerOptions {
  limit: number;
  concurrency: number;
  maxCostUsd: number;
  retryErrors: boolean;
  /** 구버전 ok 런"만" 보유한 공고를 대상에 편입한다 — 우발 재분석 가드의 명시적 탈출구. */
  reanalyzeOutdated: boolean;
  /** env(ANALYSIS_LAB_TRANSPORT)보다 우선하는 명시 오버라이드. 미지정 시 기존 env 경로. */
  transport?: LabBatchTransport;
  /** env(ANALYSIS_LAB_MODEL)보다 우선하는 명시 오버라이드. 미지정 시 기존 env 경로. */
  model?: string;
  onEvent?: (event: LabBatchEvent) => void;
  /** abort 시 신규 착수만 중단한다 — 진행분은 각 워커가 완료하고 런도 저장된다. */
  signal?: AbortSignal;
}

// 계약(contract.ts)이 소유한 타입의 러너 관점 재수출 — 기존 소비처(batch.ts·테스트)의
// import 경로("./batch-runner")를 보존한다.
export type { LabBatchPeriodSkipStatus, LabBatchPeriodSkippedEntry, LabBatchSummary };

type LabBatchPlanEventContract = Extract<LabBatchEventContract, { type: "plan" }>;
type LabBatchTargetErrorEventContract = Extract<LabBatchEventContract, { type: "target-error" }>;

/**
 * 배치 진행 이벤트 — 모양의 단일 원천은 contract.ts 의 LabBatchEvent 다(§3-4 단일 원천화).
 * target 계열의 index 는 0 기반이다(CLI 표기 ordinal 은 index+1).
 * 계약의 additive 필드(plan 의 runnable/periodSkippedEntries/estimatedCostPerGrantUsd/
 * costSampleCount · target-error 의 title/durationMs)는 구 스냅샷 호환을 위해 옵셔널이지만,
 * 러너는 항상 채워 방출한다 — CLI 래퍼(batch.ts)의 로그 라인 재현(기간 스킵 상세·예상 비용
 * 근거)이 이 보장에 의존하므로, 여기서 Required 로 좁힌 별칭을 export 한다(로컬 재정의가
 * 아니라 계약 union 의 옵셔널 강화 — 필드 추가·변경은 반드시 contract.ts 에서 한다).
 */
export type LabBatchEvent =
  | (LabBatchPlanEventContract &
      Required<
        Pick<
          LabBatchPlanEventContract,
          "runnable" | "periodSkippedEntries" | "estimatedCostPerGrantUsd" | "costSampleCount"
        >
      >)
  | Extract<LabBatchEventContract, { type: "target-started" }>
  | Extract<LabBatchEventContract, { type: "target-ok" }>
  | (LabBatchTargetErrorEventContract &
      Required<Pick<LabBatchTargetErrorEventContract, "title" | "durationMs">>)
  | Extract<LabBatchEventContract, { type: "guard-stop" }>
  | Extract<LabBatchEventContract, { type: "finished" }>;

/** cohort.json 부재·형식 파손 — 래퍼가 잡아 기존 안내 문구 + exit 1 로 매핑한다. */
export class LabCohortMissingError extends Error {
  constructor(public readonly path: string) {
    super(`cohort.json 이 없거나 형식이 깨졌습니다: ${path}`);
    this.name = "LabCohortMissingError";
  }
}

// ---- 테스트 주입점 --------------------------------------------------------------
// runLabAnalysis(API/CLI 호출)·파일 스캔·DB 기간 가드를 페이크로 대체할 수 있게 한다.
// 프로덕션 호출은 deps 를 생략한다(기본: 실구현 + 실행 시점 동적 import).

/** runLabAnalysis 반환값 중 러너가 소비하는 부분집합(LabRun 이 구조적으로 만족). */
export interface LabBatchRunResult {
  title: string;
  costUsd: number | null;
  error: string | null;
}

export type LabBatchAnalysisImpl = (
  grantId: string,
  overrides?: { transport?: LabBatchTransport; model?: string },
) => Promise<LabBatchRunResult>;

export interface LabBatchRunnerDeps {
  runAnalysisImpl?: LabBatchAnalysisImpl;
  scanRunsImpl?: () => Promise<LabBatchRunScan>;
  splitPeriodImpl?: (entries: CohortEntry[]) => Promise<LabBatchPeriodSplit>;
  readCohortImpl?: () => Promise<CohortFileV2 | null>;
}

// ---- 비용 추정 -----------------------------------------------------------------

/** 파일럿 실측 공고당 비용(계획 문서 §4 "비용·시간") — 기존 ok 런이 없을 때의 추정 기준. */
export const FALLBACK_COST_PER_GRANT_USD = 0.395;

/** 공고당 예상 비용 — 현행 버전 ok 런 평균, 표본이 없으면 파일럿 실측 기본값. */
export function estimatePerGrantCostUsd(okCostSamples: number[]): {
  perGrantUsd: number;
  sampleCount: number;
} {
  if (okCostSamples.length === 0) {
    return { perGrantUsd: FALLBACK_COST_PER_GRANT_USD, sampleCount: 0 };
  }
  return {
    perGrantUsd: okCostSamples.reduce((sum, cost) => sum + cost, 0) / okCostSamples.length,
    sampleCount: okCostSamples.length,
  };
}

// ---- 기존 런 스캔(스킵 판정) ---------------------------------------------------
// grantId→경로 매핑이 없으므로 spike-out/analysis-lab/<source>__<sourceId>/ 를 전수
// 스캔한다(run-store.readLabRun 과 같은 접근 — dev 실험실 규모라 비용 무시 가능).
// GrantRunState 는 batch-plan.ts 소유(분할 순수 로직과 공유). CLI dry-run 경로도
// 이 함수를 직접 사용한다(러너 미경유 — DB 미로드 불변식).

export interface LabBatchRunScan {
  states: Map<string, GrantRunState>;
  /** 현행 버전 ok 런들의 costUsd 표본 — 예상 비용의 근거. */
  okCostSamples: number[];
}

export async function scanExistingRuns(): Promise<LabBatchRunScan> {
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
      if (!file.startsWith("run-") || !file.endsWith(".json")) continue;
      // 부속 파일(검수·AI 검수·감사·질문 사이드카)은 런이 아니다 — 버전 무관 스킵 판정에서
      // 런으로 오인되면 안 된다(파일명 + 아래 startedAt 이중 방어, e4556df 오인 편입 전례).
      if (
        file.endsWith(".review.json") ||
        file.includes(".ai-review.") ||
        file.includes(".audit.") ||
        file.includes(".confirmations.")
      ) {
        continue;
      }
      let parsed: {
        grantId?: unknown;
        promptVersion?: unknown;
        startedAt?: unknown;
        error?: unknown;
        costUsd?: unknown;
      };
      try {
        parsed = JSON.parse(await readFile(join(root, entry, file), "utf8")) as typeof parsed;
      } catch {
        continue; // 깨진 파일은 판정에서 제외(불변 저장소라 원본은 건드리지 않는다)
      }
      if (
        typeof parsed.grantId !== "string" ||
        typeof parsed.promptVersion !== "string" ||
        typeof parsed.startedAt !== "string" // 런 파일 표식 — run-store readRunFile 관행
      ) {
        continue;
      }
      const current = parsed.promptVersion === ANALYSIS_LAB_PROMPT_VERSION;
      const ok = parsed.error === null;
      const state =
        states.get(parsed.grantId) ?? { okCurrent: false, okOutdated: false, errorCurrent: false };
      if (ok && current) {
        state.okCurrent = true;
        if (typeof parsed.costUsd === "number") okCostSamples.push(parsed.costUsd);
      } else if (ok) {
        state.okOutdated = true;
      } else if (current) {
        // 구버전 error 런은 종전대로 판정에 쓰지 않는다(보류 사유는 현행 버전 실패만).
        state.errorCurrent = true;
      }
      states.set(parsed.grantId, state);
    }
  }
  return { states, okCostSamples };
}

// ---- 모집기간 가드(2026-07-23 정책) ---------------------------------------------
// 실행 시 각 공고의 "현재" applyStart/applyEnd 를 DB에서 읽어 기간 정책 위반이면
// 스킵한다(비파괴 — 동결 코호트 파일·기존 런은 건드리지 않는다). CLI dry-run 은 러너를
// 거치지 않으므로 이 가드를 수행하지 않는다(DB 미로드 불변식 — 래퍼 쪽 주석 참조).

export const PERIOD_SKIP_LABELS: Record<LabBatchPeriodSkipStatus, string> = {
  closed: "마감(applyEnd 과거)",
  not_started: "접수 시작 전(applyStart 미래)",
  unknown: "기간 미상(applyEnd null) — 감사로 기간 특정 필요",
};

export interface LabBatchPeriodSplit {
  runnable: CohortEntry[];
  skipped: Array<{ entry: CohortEntry; status: LabBatchPeriodSkipStatus }>;
}

// cohort.ts 와 같은 이유의 가드 — uuid 형식이 아닌 id 를 inArray 에 넣으면 쿼리 전체가 죽는다.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function splitByPeriodPolicy(entries: CohortEntry[]): Promise<LabBatchPeriodSplit> {
  const split: LabBatchPeriodSplit = { runnable: [], skipped: [] };
  if (entries.length === 0) return split;

  // 실행 경로에서만 DB 를 로드한다(모듈 import 시점 DB 미로드 불변식 — 상단 계약 주석).
  const [{ getCunoteDb }, schema, { inArray }] = await Promise.all([
    import("../db/client"),
    import("../db/schema"),
    import("drizzle-orm"),
  ]);
  const validIds = entries.map((entry) => entry.grantId).filter((id) => UUID_PATTERN.test(id));
  const rows = validIds.length
    ? await getCunoteDb()
        .select({
          id: schema.grants.id,
          applyStart: schema.grants.applyStart,
          applyEnd: schema.grants.applyEnd,
        })
        .from(schema.grants)
        .where(inArray(schema.grants.id, validIds))
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const now = new Date();
  for (const entry of entries) {
    const grant = byId.get(entry.grantId);
    if (!grant) {
      // 공고 미존재는 기간 정책 위반이 아니다 — 기존 경로(runLabAnalysis 의
      // LabGrantNotFoundError → 런 미저장 실패 기록)를 그대로 태운다.
      split.runnable.push(entry);
      continue;
    }
    const status = classifyNoticePeriod(grant.applyStart, grant.applyEnd, now);
    if (status === "eligible") split.runnable.push(entry);
    else split.skipped.push({ entry, status });
  }
  return split;
}

// ---- 러너 본체 -----------------------------------------------------------------

/** 옵션 검증 — 러너 단독 호출(웹 잡 등) 대비 최소 방어. CLI 는 parseOptions 가 선검증한다. */
function assertRunnerOptions(options: LabBatchRunnerOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("limit 은 1 이상의 정수여야 합니다.");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("concurrency 는 1 이상의 정수여야 합니다.");
  }
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
    throw new Error("maxCostUsd 는 0보다 큰 숫자여야 합니다.");
  }
}

/**
 * transport 를 진입 시 1회 해석한다(오타 fail-fast — 배치 시작 전에 실패해야 잔여 타깃
 * 전부가 스폰→실패로 축적되지 않는다). 오버라이드가 없으면 env 해석(resolveLabTransport)
 * 을 그대로 태워 기존 선검증(계획 §5 #6-②)과 동일하게 동작한다.
 */
function resolveEffectiveTransport(override: LabBatchTransport | undefined): LabBatchTransport {
  if (override === undefined) return resolveLabTransport();
  if (override === "api" || override === "claude-cli") return override;
  throw new Error(
    `transport 오버라이드 값이 잘못됐습니다: "${String(override)}" — 허용값은 "api" 또는 "claude-cli" 뿐입니다(오타 fail-fast).`,
  );
}

/** 기본 분석 구현 — 실행 시점에만 analyze.ts(DB 포함)를 로드한다. */
async function loadRealAnalysisImpl(): Promise<LabBatchAnalysisImpl> {
  const { runLabAnalysis } = await import("./analyze");
  return (grantId, overrides) => runLabAnalysis(grantId, overrides);
}

export async function runLabBatch(
  options: LabBatchRunnerOptions,
  deps?: LabBatchRunnerDeps,
): Promise<LabBatchSummary> {
  assertRunnerOptions(options);
  // 전송층 선검증 — env/오버라이드 오타를 코호트 읽기 전에 fail-fast(기존 main 순서와 동형).
  resolveEffectiveTransport(options.transport);
  const emit = options.onEvent ?? (() => {});

  const cohort = await (deps?.readCohortImpl ?? readCohortFileV2)();
  if (!cohort) throw new LabCohortMissingError(cohortFilePath());

  const { states, okCostSamples } = await (deps?.scanRunsImpl ?? scanExistingRuns)();
  // 분할 규칙은 batch-plan.ts(순수 — 테스트 대상) 소유: 버전 무관 ok 스킵 + 탈출구 2종.
  const partition = partitionCohortEntries(cohort.entries, states, {
    retryErrors: options.retryErrors,
    reanalyzeOutdated: options.reanalyzeOutdated,
  });
  // 모집기간 가드 — 실행 시에만 DB로 확인해 위반(마감·시작 전·기간 미상)을 스킵한다(비파괴).
  const periodSplit = await (deps?.splitPeriodImpl ?? splitByPeriodPolicy)(partition.pending);
  const targets = periodSplit.runnable.slice(0, options.limit);
  const estimate = estimatePerGrantCostUsd(okCostSamples);

  emit({
    type: "plan",
    cohortLabel: cohort.experimentLabel,
    total: cohort.entries.length,
    skippedOk: partition.skippedOk.length,
    skippedOkOutdatedOnly: partition.skippedOkOutdatedOnly.length,
    heldError: partition.heldError.length,
    periodSkipped: periodSplit.skipped.length,
    targets: targets.length,
    estimatedCostUsd: targets.length > 0 ? estimate.perGrantUsd * targets.length : null,
    runnable: periodSplit.runnable.length,
    periodSkippedEntries: periodSplit.skipped.map(({ entry, status }) => ({
      grantId: entry.grantId,
      stratum: entry.stratum,
      status,
    })),
    estimatedCostPerGrantUsd: estimate.perGrantUsd,
    costSampleCount: estimate.sampleCount,
  });

  const buildSummary = (state: {
    okCount: number;
    errorRunCount: number;
    thrownCount: number;
    startedCount: number;
    totalCostUsd: number;
    costCapped: boolean;
    windowExhausted: boolean;
    durationMs: number;
  }): LabBatchSummary => ({
    ok: state.okCount,
    errorRuns: state.errorRunCount,
    unsavedFailures: state.thrownCount,
    notStarted: targets.length - state.startedCount,
    skippedOk: partition.skippedOk.length,
    skippedOkOutdatedOnly: partition.skippedOkOutdatedOnly.length,
    heldError: partition.heldError.length,
    periodSkipped: periodSplit.skipped.length,
    totalCostUsd: state.totalCostUsd,
    durationMs: state.durationMs,
    stopReason: state.costCapped
      ? "cost-cap"
      : state.windowExhausted
        ? "window-exhausted"
        : options.signal?.aborted
          ? "aborted"
          : "completed",
  });

  if (targets.length === 0) {
    const summary = buildSummary({
      okCount: 0,
      errorRunCount: 0,
      thrownCount: 0,
      startedCount: 0,
      totalCostUsd: 0,
      costCapped: false,
      windowExhausted: false,
      durationMs: 0,
    });
    emit({ type: "finished", summary });
    return summary;
  }

  // transport/model 오버라이드 — 둘 다 미지정이면 undefined 를 넘겨 기존 env 경로를 100% 보존.
  const analysisOverrides =
    options.transport !== undefined || options.model !== undefined
      ? {
          ...(options.transport !== undefined ? { transport: options.transport } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        }
      : undefined;

  const startedMs = Date.now();
  const runAnalysis = deps?.runAnalysisImpl ?? (await loadRealAnalysisImpl());

  const state = {
    okCount: 0,
    errorRunCount: 0,
    thrownCount: 0,
    startedCount: 0,
    totalCostUsd: 0,
    costCapped: false,
    windowExhausted: false,
  };
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      // 상한 도달·윈도 소진·abort — 신규 착수만 중단(진행분은 각 워커가 완료)
      if (state.costCapped || state.windowExhausted || options.signal?.aborted) return;
      const index = nextIndex;
      if (index >= targets.length) return;
      nextIndex += 1;
      const target = targets[index]!;
      state.startedCount += 1;
      emit({
        type: "target-started",
        index,
        total: targets.length,
        grantId: target.grantId,
        stratum: target.stratum,
      });
      const targetStartedMs = Date.now();
      try {
        const run = await runAnalysis(target.grantId, analysisOverrides);
        const durationMs = Date.now() - targetStartedMs;
        state.totalCostUsd += run.costUsd ?? 0;
        if (run.error === null) {
          state.okCount += 1;
          emit({
            type: "target-ok",
            index,
            total: targets.length,
            grantId: target.grantId,
            stratum: target.stratum,
            title: run.title,
            durationMs,
            costUsd: run.costUsd,
            cumulativeCostUsd: state.totalCostUsd,
          });
        } else {
          state.errorRunCount += 1;
          emit({
            type: "target-error",
            index,
            total: targets.length,
            grantId: target.grantId,
            stratum: target.stratum,
            runSaved: true,
            message: run.error,
            title: run.title,
            durationMs,
          });
          // Max 사용량 윈도 소진(계획 §5 #6-①): error 런에 transport 마커가 보이면 costCapped
          // 와 동일하게 신규 착수만 중단한다 — 소진 후 잔여 타깃 전부가 스폰→실패→불변 error
          // 런으로 축적되는 것을 차단(기본 재실행은 error 런을 보류하므로 재개도 안 된다).
          // 윈도 리셋 후 같은 명령 재실행 시 미착수 공고는 자연 재개되고, 소진 시점에 이미
          // 착수됐던 소수 error 런만 --retry-errors 대상이다.
          if (!state.windowExhausted && run.error.includes(CLAUDE_CLI_WINDOW_EXHAUSTED_MARKER)) {
            state.windowExhausted = true;
            emit({
              type: "guard-stop",
              reason: "window-exhausted",
              cumulativeCostUsd: state.totalCostUsd,
            });
          }
        }
      } catch (caught) {
        // 공고 미존재(LabGrantNotFoundError) 등 — 런 저장 없이 실패. 기록하고 계속.
        state.thrownCount += 1;
        emit({
          type: "target-error",
          index,
          total: targets.length,
          grantId: target.grantId,
          stratum: target.stratum,
          runSaved: false,
          message: caught instanceof Error ? caught.message : String(caught),
          title: null,
          durationMs: Date.now() - targetStartedMs,
        });
      }
      if (!state.costCapped && state.totalCostUsd >= options.maxCostUsd) {
        state.costCapped = true;
        emit({ type: "guard-stop", reason: "cost-cap", cumulativeCostUsd: state.totalCostUsd });
      }
    }
  }

  const workerCount = Math.min(options.concurrency, targets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const summary = buildSummary({ ...state, durationMs: Date.now() - startedMs });
  emit({ type: "finished", summary });
  return summary;
}
