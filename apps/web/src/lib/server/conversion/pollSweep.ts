// 변환 폴링 스윕 공용 헬퍼 — CLI(poll-conversion-jobs)와 동일한 흐름을 라우트에서 재사용한다.
// 호출처: /api/cron/poll-conversions(수동·스케줄 스윕), /api/cron/ingest-kstartup(잔여 예산 스윕),
//         /api/web/grants/[grantId]/conversions/poll(on-demand, grantId 필터).
// 계획: docs/plans/2026-07-08-ideal-flow-vertical-slice.md 슬라이스 A3.

import type { GrantSource } from "@cunote/contracts";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import { createConversionClientFromEnv } from "./conversionClient";
import {
  collectPendingSurfaceJobs,
  pollAndPersistSurfaceJob,
  type PollOneResult,
} from "./pollConversions";

export interface ConversionPollSweepOptions {
  /** 한 사이클에 처리할 최대 surface 수 (기본 10). */
  limit?: number;
  /** updated_at 이 이 ms 이상 지난 pending 만 (기본 0 = 전부). */
  staleMs?: number;
  /** 특정 source 로 제한. */
  source?: GrantSource;
  /** 특정 grant 의 surface 로 제한 (on-demand). */
  grantId?: string;
  /** job 폴링 최대 시도 (기본 60). */
  maxAttempts?: number;
  /** job 폴링 간격 ms (기본 1000). */
  intervalMs?: number;
  /**
   * 전체 스윕 시간 예산 ms (기본 120초). 예산 소진 시 남은 surface 는 건드리지 않고
   * 종료한다 — pending 으로 남아 다음 스윕이 회복한다(재조정 스윕 설계 그대로).
   */
  budgetMs?: number;
}

export interface ConversionPollSweepSummary {
  ok: boolean;
  /** 변환 서버 env 미설정 등으로 스윕 자체를 건너뛴 이유. */
  skippedReason?: "conversion_env_missing";
  pendingCount: number;
  previewReady: number;
  failed: number;
  stillPending: number;
  skipped: number;
  budgetExhausted: boolean;
  elapsedMs: number;
  results: PollOneResult[];
}

/**
 * pending surface 를 변환 서버에 (재)등록·폴링하고 artifact/상태를 반영한다.
 * env 미설정이면 조용히 건너뛴다(로컬·프리뷰 환경 무해). job 별 트랜잭션이라
 * 개별 실패가 스윕 전체를 깨지 않는다.
 */
export async function runConversionPollSweep(
  db: CunoteDb,
  options: ConversionPollSweepOptions = {},
): Promise<ConversionPollSweepSummary> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 120_000;
  const base: ConversionPollSweepSummary = {
    ok: true,
    pendingCount: 0,
    previewReady: 0,
    failed: 0,
    stillPending: 0,
    skipped: 0,
    budgetExhausted: false,
    elapsedMs: 0,
    results: [],
  };

  const client = createConversionClientFromEnv();
  if (!client) {
    return { ...base, ok: false, skippedReason: "conversion_env_missing", elapsedMs: Date.now() - startedAt };
  }

  const jobs = await collectPendingSurfaceJobs(db, {
    limit: options.limit ?? 10,
    staleMs: options.staleMs ?? 0,
    ...(options.source ? { source: options.source } : {}),
    ...(options.grantId ? { grantId: options.grantId } : {}),
  });
  base.pendingCount = jobs.length;

  for (const job of jobs) {
    if (Date.now() - startedAt > budgetMs) {
      base.budgetExhausted = true;
      break;
    }
    try {
      const result = await db.transaction((tx) =>
        pollAndPersistSurfaceJob(tx as unknown as CunoteDbSession, client, job, {
          maxAttempts: options.maxAttempts ?? 60,
          intervalMs: options.intervalMs ?? 1000,
        }),
      );
      base.results.push(result);
    } catch (error) {
      base.results.push({
        surfaceId: job.surfaceId,
        filename: job.filename,
        outcome: "pending",
        artifactsInserted: 0,
        artifactsUpdated: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const result of base.results) {
    if (result.outcome === "preview_ready") base.previewReady += 1;
    else if (result.outcome === "failed") base.failed += 1;
    else if (result.outcome === "pending") base.stillPending += 1;
    else base.skipped += 1;
  }
  base.elapsedMs = Date.now() - startedAt;
  return base;
}
