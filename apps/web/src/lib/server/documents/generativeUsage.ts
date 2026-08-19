import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NormalizedChatUsage } from "../chat/budget";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";

export interface GenerativeUsageAttempt {
  id: string;
  sourceRequestId: string;
  status: "started" | "reported" | "unavailable";
}

export async function beginGenerativeUsage(input: {
  companyId: string;
  userId: string;
  grantId: string | null;
  sourceKind: string;
  sourceRequestId?: string;
  runId?: string | null;
  attempt?: number | null;
  leaseVersion?: number | null;
  model: string;
}): Promise<GenerativeUsageAttempt> {
  const sourceRequestId = input.sourceRequestId ?? randomUUID();
  const db = getCunoteDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.userId}, true)`);
    const inserted = await tx
      .insert(schema.generativeUsageEvents)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        grantId: input.grantId,
        sourceKind: input.sourceKind,
        sourceRequestId,
        runId: input.runId ?? null,
        attempt: input.attempt ?? null,
        leaseVersion: input.leaseVersion ?? null,
        model: input.model,
        usageStatus: "started",
      })
      .onConflictDoNothing()
      .returning({ id: schema.generativeUsageEvents.id, status: schema.generativeUsageEvents.usageStatus });
    const created = inserted[0];
    if (created) return { id: created.id, sourceRequestId, status: "started" };
    const where = input.runId
      ? and(
          eq(schema.generativeUsageEvents.runId, input.runId),
          eq(schema.generativeUsageEvents.attempt, input.attempt!),
          eq(schema.generativeUsageEvents.leaseVersion, input.leaseVersion!),
        )
      : and(
          eq(schema.generativeUsageEvents.sourceKind, input.sourceKind),
          eq(schema.generativeUsageEvents.sourceRequestId, sourceRequestId),
        );
    const [existing] = await tx
      .select({ id: schema.generativeUsageEvents.id, status: schema.generativeUsageEvents.usageStatus })
      .from(schema.generativeUsageEvents)
      .where(where)
      .limit(1);
    if (!existing) throw new Error("생성형 usage 시작 원장을 찾지 못했습니다.");
    return {
      id: existing.id,
      sourceRequestId,
      status: existing.status as GenerativeUsageAttempt["status"],
    };
  });
}

export async function finalizeGenerativeUsage(input: {
  eventId: string;
  companyId: string;
  userId: string;
  grantId: string | null;
  model: string;
  status: "reported" | "unavailable";
  providerRequestId?: string | null;
  usage?: NormalizedChatUsage;
}): Promise<{ finalized: boolean }> {
  const usage = input.status === "reported"
    ? input.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    : null;
  const db = getCunoteDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${input.userId}, true)`);
    await tx.execute(sql`
      SELECT id FROM generative_usage_events
      WHERE id = ${input.eventId}
        AND company_id = ${input.companyId}
        AND user_id = ${input.userId}
      FOR UPDATE
    `);
    const [event] = await tx
      .select({ status: schema.generativeUsageEvents.usageStatus })
      .from(schema.generativeUsageEvents)
      .where(and(
        eq(schema.generativeUsageEvents.id, input.eventId),
        eq(schema.generativeUsageEvents.companyId, input.companyId),
        eq(schema.generativeUsageEvents.userId, input.userId),
      ))
      .limit(1);
    if (!event) throw new Error("생성형 usage 원장을 찾지 못했습니다.");
    if (event.status !== "started") return { finalized: false };

    const [updated] = await tx
      .update(schema.generativeUsageEvents)
      .set({
        usageStatus: input.status,
        providerRequestId: input.providerRequestId ?? null,
        inputTokens: usage?.input ?? null,
        outputTokens: usage?.output ?? null,
        cacheReadTokens: usage?.cacheRead ?? null,
        cacheWriteTokens: usage?.cacheWrite ?? null,
        finalizedAt: new Date(),
      })
      .where(and(
        eq(schema.generativeUsageEvents.id, input.eventId),
        eq(schema.generativeUsageEvents.usageStatus, "started"),
      ))
      .returning({ id: schema.generativeUsageEvents.id });
    if (!updated) return { finalized: false };
    if (usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 && input.grantId) {
      await addDailyChatUsage(tx, {
        companyId: input.companyId,
        userId: input.userId,
        grantId: input.grantId,
        model: input.model,
        usage,
      });
    }
    return { finalized: true };
  });
}

type UsageTx = Parameters<Parameters<ReturnType<typeof getCunoteDb>["transaction"]>[0]>[0];

async function addDailyChatUsage(tx: UsageTx, input: {
  companyId: string;
  userId: string;
  grantId: string;
  model: string;
  usage: NormalizedChatUsage;
}): Promise<void> {
  const existing = (await tx.execute(sql`
    SELECT id FROM chat_sessions
    WHERE company_id = ${input.companyId}
      AND user_id = ${input.userId}
      AND grant_id = ${input.grantId}
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'
    ORDER BY last_message_at DESC
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  let sessionId = existing[0]?.id ?? null;
  if (!sessionId) {
    const [created] = await tx
      .insert(schema.chatSessions)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        contextType: "grant",
        grantId: input.grantId,
        model: input.model,
      })
      .returning({ id: schema.chatSessions.id });
    sessionId = created?.id ?? null;
  }
  if (!sessionId) throw new Error("생성형 usage 합산 세션을 만들지 못했습니다.");
  await tx
    .update(schema.chatSessions)
    .set({
      inputTokens: sql`${schema.chatSessions.inputTokens} + ${input.usage.input}`,
      outputTokens: sql`${schema.chatSessions.outputTokens} + ${input.usage.output}`,
      cacheReadTokens: sql`${schema.chatSessions.cacheReadTokens} + ${input.usage.cacheRead}`,
      cacheWriteTokens: sql`${schema.chatSessions.cacheWriteTokens} + ${input.usage.cacheWrite}`,
      lastMessageAt: sql`now()`,
    })
    .where(eq(schema.chatSessions.id, sessionId));
}
