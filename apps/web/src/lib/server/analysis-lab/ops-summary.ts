// 공모 딥분석 실험실 — 배치 운영 대시보드 서버 집계 (dev 전용, DB read-only).
// 깔때기 6단계(2026-08-03 계획 §2)의 소스를 한곳에서 조립한다:
//   ① grants servingState='visible' (grantServingVisiblePredicate 단일 원천 — 전 소스 총계
//      + LAB_SOURCES 한정 수치 병기). ARCHIVE_HIDDEN 킬스위치는 상태가 아니므로 무시(DB 직조회).
//   ② LAB_SOURCES·visible 기준 모집기간 3분할 — withinApplyPeriod(아래 사본) + applyEnd IS NULL.
//   ③ readCohortFileV2() 코호트 메타.
//   ④ partitionCohortEntries(batch-plan) + 자체 런 스캐너 — batch.ts scanExistingRuns 와 동형이나
//      batch.ts 는 모듈 최상단 env 로드 + main() 자기실행이라 import 금지(계획 §2), 여기 재작성.
//   ⑤ selectReviewedRuns(사람 검수) + loadAuditedConfirmedReviews(감사 확정 — provenance 로
//      사람 판정/AI 자동확정 분리, 무은폐 3분할). excludePilotStratum 은 게이트 전용이라 켜지 않는다.
//   ⑥ analysis_lab_promotion_items status='applied' AND rolled_back_at IS NULL — DISTINCT grantId
//      (릴리스 상태가 아니라 item 상태로 센다 — partial_failed 함정, 계획 §2 ⑥).
// 파일시스템 전수 스캔(④⑤)은 요청마다 돌리지 않는다 — 모듈 메모리 캐시(TTL 30s),
// refresh=true 로 무효화. 스캔 자체도 요청당 최대 1회다.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, count, countDistinct, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  AI_REVIEW_ADOPTED,
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabOpsFunnel,
  type LabOpsSummary,
  type LabOpsTransportStatus,
} from "@/features/dev/analysis-lab/contract";
import { kstDayStartUtc } from "@/features/dev/analysis-lab/notice-period";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { grantServingVisiblePredicate } from "@/lib/server/grantServingVisibility";
import { loadAuditedConfirmedReviews } from "./audited-reviews";
import { partitionCohortEntries, type CohortPartition, type GrantRunState } from "./batch-plan";
import { readCohortFileV2, type CohortEntry, type CohortFileV2 } from "./cohort-file";
import { resolveLabTransport } from "./claude-cli-transport";
import { resolveLabModel } from "./extractor";
import { selectReviewedRuns } from "./reviewed-runs";
import { analysisLabDir } from "./run-store";
import { LAB_SOURCES } from "./strata";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPS_SUMMARY_TTL_MS = 30_000;

// ---- 런 스캐너 (④ + transport 분포 — 1회 스캔 공용) ------------------------------

export interface LabOpsRunScan {
  /** 공고별 기존 런 상태 — partitionCohortEntries(batch-plan.ts) 입력. */
  states: Map<string, GrantRunState>;
  /** 코호트 공고의 "현행 버전 ok 런" transport 분포(undefined transport 는 api 로 해석). */
  runsByTransport: { api: number; claudeCli: number };
}

/**
 * spike-out/analysis-lab/<source>__<sourceId>/ 전수 스캔 — batch.ts scanExistingRuns 와 동형
 * (사본 출처: batch.ts:101, 자기실행 모듈이라 import 금지). 런 파일 판별은 이중 방어
 * (e4556df 부속 파일 오인 편입 전례): ① 사이드카 접미(review/ai-review/audit/confirmations/
 * human-overlay) 파일명 제외 ② startedAt 문자열 존재 확인.
 * transport 분포는 같은 스캔에서 함께 집계한다(현행 버전 ok 런 × 코호트 공고 한정).
 */
export async function scanLabRunsForOps(
  rootDir: string,
  cohortGrantIds: ReadonlySet<string>,
): Promise<LabOpsRunScan> {
  const scan: LabOpsRunScan = {
    states: new Map(),
    runsByTransport: { api: 0, claudeCli: 0 },
  };
  let entries: string[] = [];
  try {
    entries = await readdir(rootDir);
  } catch {
    return scan; // 산출물 디렉토리 자체가 없으면 전원 미분석
  }
  for (const entry of entries) {
    if (!entry.includes("__")) continue; // cohort.json 등 파일 제외
    let files: string[] = [];
    try {
      files = await readdir(join(rootDir, entry));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith("run-") || !file.endsWith(".json")) continue;
      // 이중 방어 ① — 부속 파일(검수·AI 검수·감사·질문 사이드카·사람 검수 오버레이)은
      // 런이 아니다(run-store listLabRunSummaries 와 같은 제외 목록).
      if (
        file.endsWith(".review.json") ||
        file.includes(".ai-review.") ||
        file.includes(".audit.") ||
        file.includes(".confirmations.") ||
        file.endsWith(".human-overlay.json")
      ) {
        continue;
      }
      let parsed: {
        grantId?: unknown;
        promptVersion?: unknown;
        startedAt?: unknown;
        error?: unknown;
        transport?: unknown;
      };
      try {
        parsed = JSON.parse(await readFile(join(rootDir, entry, file), "utf8")) as typeof parsed;
      } catch {
        continue; // 깨진 파일은 판정에서 제외(불변 저장소라 원본은 건드리지 않는다)
      }
      if (
        typeof parsed.grantId !== "string" ||
        typeof parsed.promptVersion !== "string" ||
        typeof parsed.startedAt !== "string" // 이중 방어 ② — 런 파일 표식(readRunFile 관행)
      ) {
        continue;
      }
      const current = parsed.promptVersion === ANALYSIS_LAB_PROMPT_VERSION;
      const ok = parsed.error === null;
      const state =
        scan.states.get(parsed.grantId) ??
        { okCurrent: false, okOutdated: false, errorCurrent: false };
      if (ok && current) {
        state.okCurrent = true;
        if (cohortGrantIds.has(parsed.grantId)) {
          if (parsed.transport === "claude-cli") scan.runsByTransport.claudeCli += 1;
          else scan.runsByTransport.api += 1; // undefined(구런)·"api" 모두 api
        }
      } else if (ok) {
        state.okOutdated = true;
      } else if (current) {
        // 구버전 error 런은 판정에 쓰지 않는다(batch.ts 와 동일 — 보류 사유는 현행 실패만).
        state.errorCurrent = true;
      }
      scan.states.set(parsed.grantId, state);
    }
  }
  return scan;
}

// ---- 깔때기 조립 (순수 — 테스트 대상) ---------------------------------------------

/** DB 카운트 주입점 — DB 의존부를 분리해 조립 로직을 순수하게 유지한다(테스트 계약). */
export interface LabOpsDbCounts {
  archivedVisible: number;
  archivedVisibleLabSources: number;
  openToday: number;
  periodUnknown: number;
  promotedGrants: number;
}

export function buildLabOpsFunnel(input: {
  dbCounts: LabOpsDbCounts;
  cohort: CohortFileV2 | null;
  partition: CohortPartition<CohortEntry>;
  humanReviewedCount: number;
  /** 감사 확정 공고들의 provenance — auditedCount>0 이면 사람 판정 포함, 0 이면 AI 자동확정. */
  auditConfirmedProvenances: Array<{ auditedCount: number }>;
  auditPendingCount: number;
}): LabOpsFunnel {
  const { dbCounts, cohort, partition } = input;
  // ② 3분할의 나머지 갈래 — openToday(오늘 포함)·periodUnknown(applyEnd null)은 상호 배타라
  // 차감이 정확하다(방어적 clamp 만 유지).
  const closedOrNotStarted = Math.max(
    0,
    dbCounts.archivedVisibleLabSources - dbCounts.openToday - dbCounts.periodUnknown,
  );
  const humanJudged = input.auditConfirmedProvenances.filter(
    (provenance) => provenance.auditedCount > 0,
  ).length;
  return {
    archivedVisible: dbCounts.archivedVisible,
    archivedVisibleLabSources: dbCounts.archivedVisibleLabSources,
    openToday: dbCounts.openToday,
    periodUnknown: dbCounts.periodUnknown,
    closedOrNotStarted,
    cohortSize: cohort?.entries.length ?? 0,
    cohortLabel: cohort?.experimentLabel ?? null,
    cohortSelectedAt: cohort && cohort.selectedAt.length > 0 ? cohort.selectedAt : null,
    analysisOkCurrent: partition.skippedOk.length - partition.skippedOkOutdatedOnly.length,
    analysisOkOutdatedOnly: partition.skippedOkOutdatedOnly.length,
    analysisErrorHeld: partition.heldError.length,
    analysisPending: partition.pending.length,
    humanReviewed: input.humanReviewedCount,
    auditConfirmed: humanJudged,
    auditAiAutoConfirmed: input.auditConfirmedProvenances.length - humanJudged,
    auditPending: input.auditPendingCount,
    promotedGrants: dbCounts.promotedGrants,
  };
}

// ---- DB 카운트 (①②⑥) ------------------------------------------------------------

/**
 * "모집기간에 오늘(KST)이 포함" DB 조건 — cohort.ts withinApplyPeriod(비공개 함수,
 * cohort.ts:403)의 사본. 원본은 export 되어 있지 않고 cohort.ts 는 이 트랙의 수정 범위 밖이라
 * 출처 주석과 함께 복제한다(기준 동일 유지 의무): applyEnd >= 오늘시작 AND
 * (applyStart IS NULL OR applyStart < 내일시작). 날짜 규약은 notice-period.ts 헤더 참조
 * (저장값은 캘린더 날짜의 UTC 자정 — KST 캘린더 일 단위 비교). 제품 쪽 activeGrantWhere 와
 * 정의가 다르므로 혼용 금지(계획 §2 ②).
 */
function withinApplyPeriod(now: Date) {
  const dayStart = kstDayStartUtc(now);
  const nextDayStart = new Date(dayStart.getTime() + DAY_MS);
  return and(
    gte(schema.grants.applyEnd, dayStart),
    or(isNull(schema.grants.applyStart), lt(schema.grants.applyStart, nextDayStart)),
  );
}

async function queryDbCounts(now: Date): Promise<LabOpsDbCounts> {
  const db = getCunoteDb();
  const labSourcesVisible = and(
    grantServingVisiblePredicate(),
    inArray(schema.grants.source, [...LAB_SOURCES]),
  );
  const [visibleAll, visibleLab, openToday, periodUnknown, promoted] = await Promise.all([
    db.select({ value: count() }).from(schema.grants).where(grantServingVisiblePredicate()),
    db.select({ value: count() }).from(schema.grants).where(labSourcesVisible),
    db
      .select({ value: count() })
      .from(schema.grants)
      .where(and(labSourcesVisible, withinApplyPeriod(now))),
    db
      .select({ value: count() })
      .from(schema.grants)
      .where(and(labSourcesVisible, isNull(schema.grants.applyEnd))),
    // ⑥ — item 상태 기준(applied & 미롤백), 재승격 중복 방지로 DISTINCT grantId.
    db
      .select({ value: countDistinct(schema.analysisLabPromotionItems.grantId) })
      .from(schema.analysisLabPromotionItems)
      .where(
        and(
          eq(schema.analysisLabPromotionItems.status, "applied"),
          isNull(schema.analysisLabPromotionItems.rolledBackAt),
        ),
      ),
  ]);
  return {
    archivedVisible: Number(visibleAll[0]?.value ?? 0),
    archivedVisibleLabSources: Number(visibleLab[0]?.value ?? 0),
    openToday: Number(openToday[0]?.value ?? 0),
    periodUnknown: Number(periodUnknown[0]?.value ?? 0),
    promotedGrants: Number(promoted[0]?.value ?? 0),
  };
}

// ---- transport 상태 ----------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** claude CLI 버전 — 프로세스 수명 동안 불변이라 1회만 시도하고 결과(실패 포함)를 메모한다. */
let cliVersionMemo: { value: string | null } | null = null;

async function readClaudeCliVersion(): Promise<string | null> {
  if (cliVersionMemo) return cliVersionMemo.value;
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 5_000 });
    const value = stdout.trim();
    cliVersionMemo = { value: value.length > 0 ? value : null };
  } catch {
    cliVersionMemo = { value: null }; // 미설치·PATH 부재 — 필수 아님(계약 주석)
  }
  return cliVersionMemo.value;
}

// ---- 요약 로더 (캐시 TTL 30s) ------------------------------------------------------

let summaryCache: { summary: LabOpsSummary; expiresAt: number } | null = null;

export async function loadLabOpsSummary(
  options: { refresh?: boolean } = {},
): Promise<LabOpsSummary> {
  if (options.refresh === true) summaryCache = null;
  if (summaryCache && Date.now() < summaryCache.expiresAt) {
    return { ...summaryCache.summary, cacheHit: true };
  }
  const summary = await computeLabOpsSummary();
  summaryCache = { summary, expiresAt: Date.now() + OPS_SUMMARY_TTL_MS };
  return summary;
}

async function computeLabOpsSummary(): Promise<LabOpsSummary> {
  const now = new Date();

  // ③ 코호트 파일 — 없으면 깔때기 ③④와 transport 분포는 0 이다(스캔은 states 용으로 유지).
  const cohort = await readCohortFileV2();
  const cohortEntries: CohortEntry[] = cohort?.entries ?? [];
  const cohortGrantIds = new Set(cohortEntries.map((entry) => entry.grantId));

  // ①②⑥ DB 카운트 + ④ 파일 스캔(요청당 1회) 병행.
  const [dbCounts, scan] = await Promise.all([
    queryDbCounts(now),
    scanLabRunsForOps(analysisLabDir(), cohortGrantIds),
  ]);

  // ④ — 대시보드는 현황 표시라 탈출구 플래그 없이 기본 분할(retry/reanalyze 미지정)을 쓴다.
  const partition = partitionCohortEntries(cohortEntries, scan.states, {
    retryErrors: false,
    reanalyzeOutdated: false,
  });

  // ⑤ — 로더 내부의 console.warn 소음(코호트 밖 검수 제외·같은 공고 dedupe 안내 등)은
  // 수용한다: 집계 CLI 와 출력 계약을 공유하는 모듈이라 quiet 옵션을 추가하지 않는다(계획 §2 ⑤).
  // excludePilotStratum 은 게이트 판정 표본 전용이라 켜지 않는다(무은폐 전량 집계).
  const reviewedSelection = await selectReviewedRuns({ scanAll: false });
  const auditedSelection = await loadAuditedConfirmedReviews({
    model: AI_REVIEW_ADOPTED.model,
    scanAll: false,
  });

  const funnel = buildLabOpsFunnel({
    dbCounts,
    cohort,
    partition,
    humanReviewedCount: reviewedSelection.reviewed.length,
    auditConfirmedProvenances: auditedSelection.confirmed.map((item) => ({
      auditedCount: item.provenance.auditedCount,
    })),
    auditPendingCount: auditedSelection.pending.length,
  });

  const transportStatus: LabOpsTransportStatus = {
    resolved: resolveLabTransport(),
    model: resolveLabModel(),
    envSource: (process.env.ANALYSIS_LAB_TRANSPORT ?? "").trim().length > 0 ? "env" : "unset",
    cliVersion: await readClaudeCliVersion(),
    runsByTransport: scan.runsByTransport,
  };

  return {
    funnel,
    transportStatus,
    generatedAt: now.toISOString(),
    cacheHit: false,
  };
}
