/**
 * withCreditMetering — LLM 호출 래퍼 (타입/시그니처).
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md 6.2.
 *
 * ★ P1 범위 주의: 이 파일은 P1 에서 타입/계약만 정의한다.
 *   실제 구현(hold→run→capture, hold cron 연동)은 P2 다 —
 *   설계 15장 "제외(다음 Phase): withCreditMetering·hold cron(P2)".
 *   여기 시그니처는 P2 구현과 호출측이 미리 계약을 공유하기 위한 것.
 */

import type { TokenUsage } from "./pricing.js";

export interface MeteringContext {
  /** 운영 배치는 null. */
  userId: string | null;
  companyId: string | null;
  /** 3.2 featureCode 사전. */
  featureCode: string;
  model: string;
  /** hold 산정용. maxOutputTokens 는 실제 LLM max_tokens 에 바인딩(6.2 M8). */
  estimate: { inputTokens: number; maxOutputTokens: number };
  requestId: string;
  contextRef?: Record<string, unknown>;
}

export interface MeteredUsageEvent {
  id: string;
  featureCode: string;
  status: "pending" | "settled" | "failed" | "free";
  creditsCharged: number;
}

/** run 콜백이 받는 리포터·주입값. maxTokens 는 estimate.maxOutputTokens 와 결속(6.2 M8). */
export interface MeteringRunArgs {
  report: (usage: TokenUsage) => void;
  maxTokens: number;
}

export type MeteringRun<T> = (args: MeteringRunArgs) => Promise<T>;

/**
 * P2 에서 구현할 함수의 시그니처. (P1 은 계약만.)
 * deps 는 CreditRepository/CreditSystemRepository 확장(hold/capture 포함)을 요구하므로 P2 에서 확정한다.
 */
export type WithCreditMetering = <T>(
  ctx: MeteringContext,
  run: MeteringRun<T>,
) => Promise<{ result: T; usageEvent: MeteredUsageEvent }>;
