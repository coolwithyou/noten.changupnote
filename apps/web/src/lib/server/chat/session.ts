/**
 * 채팅 세션·메시지 영속화 + 모델 메시지 조립 (Apply Experience v2 · §7.2 · P3-5).
 *
 * - 세션 소유권: sessionId 의 companyId+userId 불일치는 404(§7.2). draftId 는 비저장.
 * - v1 정책: workspace 진입마다 신규 세션(§7.2). 저장은 유지(usage 집계·원가 데이터).
 * - 모델 메시지 조립: 배치 규약(§7.3)대로 grounding 문서를 첫 사용자 메시지에 붙이고(캐시 prefix),
 *   dynamicContext(세션 안정)는 첫 사용자 메시지의 문서 뒤(캐시 브레이크포인트 이후), fieldContext(per-메시지)는
 *   현재 사용자 메시지에 붙인다.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { ModelMessage } from "ai";
import type { CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { ChatMessageContent } from "@/lib/chat/messageContent";
import type { GrantGrounding } from "./grounding";
import type { NormalizedChatUsage } from "./budget";
import { usageToJson } from "./budget";

/** status/code 를 지닌 채팅 오류 — webActionError 가 그대로 전달한다. */
export class ChatSessionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ChatSessionError";
    this.code = code;
    this.status = status;
  }
}

/**
 * grant 컨텍스트 세션 확보. sessionId 있으면 소유권 검증(불일치 404), 없으면 신규 생성.
 * grantId 는 사전에 존재가 검증된 값이어야 한다(FK).
 */
export async function resolveOrCreateGrantSession(input: {
  db: CunoteDb;
  access: CompanyAccess;
  sessionId?: string | null;
  grantId: string;
  model: string;
}): Promise<{ sessionId: string; isNew: boolean }> {
  const { db, access, sessionId, grantId, model } = input;
  if (sessionId) {
    const rows = await db
      .select({ companyId: schema.chatSessions.companyId, userId: schema.chatSessions.userId })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row || row.companyId !== access.companyId || row.userId !== access.userId) {
      // 존재하지 않거나 타사/타인 세션 — 정보 노출 없이 404(§7.2).
      throw new ChatSessionError("session_not_found", "채팅 세션을 찾을 수 없습니다.", 404);
    }
    return { sessionId, isNew: false };
  }
  const created = await db
    .insert(schema.chatSessions)
    .values({
      companyId: access.companyId,
      userId: access.userId,
      contextType: "grant",
      grantId,
      model,
    })
    .returning({ id: schema.chatSessions.id });
  return { sessionId: created[0]!.id, isNew: true };
}

/** 세션의 기존 메시지(역할+텍스트)를 시간순으로 로드한다(모델 입력 재구성용). */
export async function loadSessionMessages(
  db: CunoteDb,
  sessionId: string,
): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  const rows = await db
    .select({ role: schema.chatMessages.role, content: schema.chatMessages.content })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(asc(schema.chatMessages.createdAt));
  return rows.map((r) => ({
    role: r.role === "assistant" ? "assistant" : "user",
    text: r.content?.text ?? "",
  }));
}

/** 사용자 메시지 영속화(스트리밍 전 동기 — 멀티턴 재구성의 원천). */
export async function insertUserMessage(
  db: CunoteDb,
  sessionId: string,
  text: string,
): Promise<void> {
  const content: ChatMessageContent = { text };
  await db.insert(schema.chatMessages).values({ sessionId, role: "user", content });
}

/**
 * assistant 턴 영속화 + 세션 usage 누적 + lastMessageAt 갱신.
 * 스트림 종료(onFinish)에서 호출 — 클라이언트 어보트 시에도 consumeStream 이 완주를 보장하므로 기록된다(ADR-6).
 */
export async function persistAssistantTurn(input: {
  db: CunoteDb;
  sessionId: string;
  content: ChatMessageContent;
  usage: NormalizedChatUsage;
}): Promise<void> {
  const { db, sessionId, content, usage } = input;
  await db
    .insert(schema.chatMessages)
    .values({ sessionId, role: "assistant", content, usage: usageToJson(usage) });
  await db
    .update(schema.chatSessions)
    .set({
      inputTokens: sql`${schema.chatSessions.inputTokens} + ${usage.input}`,
      outputTokens: sql`${schema.chatSessions.outputTokens} + ${usage.output}`,
      cacheReadTokens: sql`${schema.chatSessions.cacheReadTokens} + ${usage.cacheRead}`,
      cacheWriteTokens: sql`${schema.chatSessions.cacheWriteTokens} + ${usage.cacheWrite}`,
      lastMessageAt: sql`now()`,
    })
    .where(eq(schema.chatSessions.id, sessionId));
}

/** 세션이 특정 회사·유저 소유인지 확인(존재+소유권). 없으면 null. */
export async function getSessionOwnership(
  db: CunoteDb,
  sessionId: string,
): Promise<{ companyId: string; userId: string; grantId: string | null } | null> {
  const rows = await db
    .select({
      companyId: schema.chatSessions.companyId,
      userId: schema.chatSessions.userId,
      grantId: schema.chatSessions.grantId,
    })
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/** grantId 가 실제 공고인지 확인(세션 FK·컨텍스트 유효성). */
export async function grantExists(db: CunoteDb, grantId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.grants.id })
    .from(schema.grants)
    .where(eq(schema.grants.id, grantId))
    .limit(1);
  return rows.length > 0;
}

const NON_EMPTY = (value: string): boolean => value.trim().length > 0;

/**
 * 배치 규약(§7.3)대로 모델 메시지를 조립한다.
 * - 첫 사용자 메시지: [ ...grounding.documents(파일·캐시 prefix), dynamicContext(세션 안정, 캐시 이후), (현재턴이면 fieldContext), 질문 ]
 * - 이후 사용자 메시지: [ (현재턴이면 fieldContext), 질문 ]
 * - assistant: 문자열 content.
 * messages 는 시간순이며 [0] 은 반드시 user, 마지막은 현재(user) 턴이다.
 */
export function buildGrantModelMessages(input: {
  grounding: GrantGrounding;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  fieldContextBlock?: string;
}): ModelMessage[] {
  const { grounding, messages, fieldContextBlock } = input;
  const lastIndex = messages.length - 1;
  const out: ModelMessage[] = [];

  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      out.push({ role: "assistant", content: message.text });
      return;
    }
    const isCurrent = index === lastIndex;
    const parts: Array<Record<string, unknown>> = [];
    if (index === 0) {
      for (const doc of grounding.documents) parts.push(doc as unknown as Record<string, unknown>);
      if (NON_EMPTY(grounding.dynamicContext)) {
        parts.push({ type: "text", text: grounding.dynamicContext });
      }
    }
    if (isCurrent && fieldContextBlock && NON_EMPTY(fieldContextBlock)) {
      parts.push({ type: "text", text: fieldContextBlock });
    }
    parts.push({ type: "text", text: message.text });
    // 파트는 TextPart(문서 뒤 텍스트) + FilePart(grounding 문서, citations/cacheControl providerOptions)로,
    // UserContent 구조와 동형이다(P0 스파이크로 런타임 검증). exactOptionalPropertyTypes 하에서 유니온
    // 구조 매칭이 과엄격하므로 메시지 단위로 캐스팅한다.
    out.push({ role: "user", content: parts } as unknown as ModelMessage);
  });

  return out;
}
