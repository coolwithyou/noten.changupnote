/**
 * 웹 서버용 크레딧 미터링 진입점 — core 의 withCreditMetering 을 serviceData 리포지토리로 배선한다.
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md 6.2.
 *
 * 운영 배치(ops_batch_*)는 userId=null 로 호출 — 무과금·원가수집 경로(hold 없음).
 * 사용자 과금 LLM 기능(지원서 등, 아직 미구현)은 userId 를 넘겨 hold→capture 경로를 탄다.
 *
 * ★ Anthropic usage 필드 매핑(6.2): 응답 JSON 의
 *   usage.input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens.
 */

import {
  withCreditMetering as coreWithCreditMetering,
  type MeteringContext,
  type MeteringRun,
  type TokenUsage,
} from "@cunote/core";
import { getServiceRepositories } from "@/lib/server/serviceData";

/**
 * serviceData 리포지토리로 배선한 withCreditMetering. 호출측은 deps 를 신경 쓰지 않는다.
 */
export async function withCreditMetering<T>(
  ctx: MeteringContext,
  run: MeteringRun<T>,
): Promise<{ result: T; usageEvent: { id: string; featureCode: string; status: string; creditsCharged: number } }> {
  const repositories = getServiceRepositories();
  return coreWithCreditMetering(
    { credits: repositories.credits, creditsSystem: repositories.creditsSystem },
    ctx,
    run,
  );
}

/**
 * 운영 배치(ops_batch_*) 전용 무과금 미터링 래퍼 — ★ 기존 동작 절대 불변(fail-open).
 *
 * 미터링(요율 조회·이벤트 기록)이 어떤 이유로든 실패하면(비-drizzle 어댑터, 요율 미시드, DB 오류 등)
 * 로그만 남기고 LLM 호출은 그대로 실행한다. 즉 이 래퍼는 원가 수집을 "베스트에포트"로 얹을 뿐,
 * 감싼 함수의 반환값·오류 경로를 절대 바꾸지 않는다(설계 P2 요구: "반환값·오류 경로가 절대 변하지 않아야").
 *
 * run 콜백은 실제 LLM 호출을 수행하고, 응답 usage 를 report 로 넘겨야 한다.
 */
export interface OpsBatchMeteringContext {
  featureCode: string;
  model: string;
  estimate: { inputTokens: number; maxOutputTokens: number };
  requestId: string;
  contextRef?: Record<string, unknown>;
  provider?: string;
}

export async function withOpsBatchMetering<T>(
  ctx: OpsBatchMeteringContext,
  run: MeteringRun<T>,
): Promise<T> {
  const meteringCtx: MeteringContext = {
    userId: null,
    companyId: null,
    featureCode: ctx.featureCode,
    model: ctx.model,
    estimate: ctx.estimate,
    requestId: ctx.requestId,
    ...(ctx.contextRef ? { contextRef: ctx.contextRef } : {}),
    ...(ctx.provider ? { provider: ctx.provider } : {}),
  };

  // run 은 ★ 정확히 한 번만 실행돼야 한다(LLM 이중 호출 방지). 실행 여부·결과·오류를 포착해
  // 미터링 실패가 재실행을 유발하지 않도록 한다.
  let ran = false;
  let runResult: T;
  let runThrew = false;
  let runError: unknown;
  const trackedRun: MeteringRun<T> = async (args) => {
    ran = true;
    try {
      runResult = await run(args);
      return runResult;
    } catch (error) {
      runThrew = true;
      runError = error;
      throw error;
    }
  };

  try {
    const { result } = await withCreditMetering(meteringCtx, trackedRun);
    return result;
  } catch (error) {
    // run 이 던진 진짜 LLM 오류는 그대로 전파(미터링이 삼키면 안 됨).
    if (runThrew) throw runError;
    // run 이 이미 성공했는데 미터링 후처리가 실패 → 결과는 유효하다. 재실행하지 않고 그대로 반환.
    if (ran) {
      console.warn(
        `ops-batch metering post-step failed (${ctx.featureCode}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return runResult!;
    }
    // run 실행 전에 미터링이 실패(요율 미시드·비-drizzle 어댑터·DB 오류) → LLM 을 직접 한 번 실행.
    console.warn(
      `ops-batch metering skipped (${ctx.featureCode}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return run({ report: () => {}, maxTokens: ctx.estimate.maxOutputTokens });
  }
}

/** Anthropic 응답 JSON 의 usage 객체를 TokenUsage 로 매핑(6.2). 필드 부재는 0. */
export function anthropicUsageToTokenUsage(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
}
