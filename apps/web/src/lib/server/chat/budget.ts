/**
 * 채팅 예산 집행 + usage 정규화 (Apply Experience v2 · ADR-6 · P3-4).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md ADR-6.
 *
 * - **예산**: 회사당 일일 토큰 예산(env CHAT_DAILY_TOKEN_BUDGET, 기본 300,000 — §12 결정 2 확정).
 *   input+output 합산, cache read 포함. 집행 = chat_sessions 당일 usage **합산 SQL**(인메모리 금지).
 * - **당일 기준일**: **Asia/Seoul**(한국 공공서비스 — 예산은 한국 자정에 리셋, 사용자의 "내일 다시" 기대와 정합).
 *   UTC 가 아니라 KST 자정 경계로 절단한다. (UTC 였다면 한국 오전 9시에 리셋되어 사용자 기대와 어긋남.)
 * - **어보트 우회 방지(택1 방식)**: 요청 시작 시 선계상하지 않고, **스트림 종료 시 실측 usage 를 기록**한다.
 *   클라이언트 어보트 시에도 라우트가 result.consumeStream() 으로 업스트림을 완주시켜 onFinish 가 반드시
 *   발화하도록 보장한다(route.ts) — 그 onFinish 에서 recordChatUsage 를 호출한다. (선추정→실측 대체 방식은
 *   채택하지 않음: consumeStream 이 완주를 보장하므로 불필요.)
 * - **동시성 제한은 v1 미구현**(서버리스 lease 비용 대비 실익 없음 — 일일 예산이 상한).
 */
import { sql } from "drizzle-orm";
import type { CunoteDb } from "@/lib/server/db/client";

const DEFAULT_DAILY_TOKEN_BUDGET = 300_000;

export function chatDailyTokenBudget(): number {
  const raw = process.env.CHAT_DAILY_TOKEN_BUDGET?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_TOKEN_BUDGET;
}

/** 예산 초과 오류 — webActionError 가 status/code 를 그대로 전달한다(429 { code:"chat_budget_exceeded" }). */
export class ChatBudgetExceededError extends Error {
  readonly code = "chat_budget_exceeded";
  readonly status = 429;
  constructor(message = "오늘 사용 가능한 채팅 한도를 초과했습니다. 내일 다시 이용해 주세요.") {
    super(message);
    this.name = "ChatBudgetExceededError";
  }
}

/**
 * 회사의 당일(Asia/Seoul) 누적 토큰 합계.
 * chat_sessions 의 4개 usage 컬럼(input/output/cacheRead/cacheWrite)은 서로 겹치지 않게 기록되므로
 * 단순 합이 곧 총 소비 토큰이다(cache read 포함 — ADR-6). v1 세션은 진입마다 신규 생성되므로
 * created_at 기준 당일 절단으로 그 날의 사용량을 정확히 집계한다.
 */
export async function getCompanyDailyTokenUsage(db: CunoteDb, companyId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(
      SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),
      0
    )::bigint AS total
    FROM chat_sessions
    WHERE company_id = ${companyId}
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
  `)) as unknown as Array<{ total: string | number | bigint }>;
  const total = rows[0]?.total ?? 0;
  const parsed = typeof total === "string" ? Number.parseInt(total, 10) : Number(total);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 당일 누적이 예산 이상이면 ChatBudgetExceededError. 스트리밍 시작 전에 호출한다. */
export async function assertChatBudget(db: CunoteDb, companyId: string): Promise<void> {
  const used = await getCompanyDailyTokenUsage(db, companyId);
  if (used >= chatDailyTokenBudget()) {
    throw new ChatBudgetExceededError();
  }
}

// ── usage 정규화(AI SDK v7 LanguageModelUsage + providerMetadata.anthropic) ────

export interface NormalizedChatUsage {
  input: number; // cache 를 제외한 신선 입력 토큰(겹침 방지)
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * AI SDK usage(+anthropic providerMetadata)를 겹치지 않는 4개 값으로 정규화한다.
 * 컬럼이 서로 배타적이어야 예산 합산(SUM of 4)이 중복 계산되지 않는다.
 * - cacheRead/cacheWrite: usage.inputTokenDetails 우선, 없으면 providerMetadata.anthropic 폴백.
 * - input(신선): noCacheTokens 우선, 없으면 (총입력 - cacheRead - cacheWrite) clamp(음수 방지).
 */
export function normalizeChatUsage(
  usage: unknown,
  providerMetadata?: unknown,
): NormalizedChatUsage {
  const u = (usage ?? {}) as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    inputTokenDetails?: { noCacheTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown };
  };
  const anthropic = ((providerMetadata ?? {}) as { anthropic?: Record<string, unknown> }).anthropic ?? {};

  const cacheRead =
    num(u.inputTokenDetails?.cacheReadTokens) ??
    num(anthropic.cacheReadInputTokens) ??
    0;
  const cacheWrite =
    num(u.inputTokenDetails?.cacheWriteTokens) ??
    num(anthropic.cacheCreationInputTokens) ??
    0;
  const totalInput = num(u.inputTokens) ?? 0;
  let input = num(u.inputTokenDetails?.noCacheTokens);
  if (input === undefined) {
    input = Math.max(0, totalInput - cacheRead - cacheWrite);
  }
  const output = num(u.outputTokens) ?? 0;
  return { input, output, cacheRead, cacheWrite };
}

/** usage → chat_messages.usage jsonb 형태(짧은 키). */
export function usageToJson(usage: NormalizedChatUsage): Record<string, number> {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}
