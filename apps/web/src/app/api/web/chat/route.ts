/**
 * 채팅 라우트 (Apply Experience v2 · §7.2 · P3-5).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §7.2/§7.3 · ADR-4/6/7/10.
 *
 * - runtime nodejs · force-dynamic · requireCompanyAccess({permission:"write"})(세션·메시지 생성 = 변이).
 * - 스트리밍 응답(AI SDK UIMessage stream, sendSources:true) + X-Cunote-Chat-Session 헤더.
 * - 세션 생성/재사용 · 소유권 404 · matching 컨텍스트 400(Phase 5 전 개방 금지).
 * - 스트림 종료 시 assistant 메시지 영속화(ChatMessageContent — 얕은 매핑) + usage 누적.
 * - 어보트 시에도 consumeStream 으로 업스트림 완주 → onEnd 에서 usage 기록(ADR-6).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
} from "ai";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getCunoteDb } from "@/lib/server/db/client";
import {
  uiMessagePartsToContent,
  type FieldAssistOutcome,
  type UiMessagePartLike,
} from "@/lib/chat/messageContent";
import { assertChatBudget, normalizeChatUsage } from "@/lib/server/chat/budget";
import { buildGrantGrounding } from "@/lib/server/chat/grounding";
import { buildFieldAssistOutcome } from "@/lib/server/chat/fieldAssist";
import {
  buildGrantModelMessages,
  ChatSessionError,
  grantExists,
  insertUserMessage,
  loadSessionMessages,
  persistAssistantTurn,
  resolveOrCreateGrantSession,
} from "@/lib/server/chat/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_CHAT_MODEL = "claude-haiku-4-5-20251001";
const MESSAGE_MAX_LENGTH = 4_000;
const MAX_OUTPUT_TOKENS = 1_024;

function chatModel(): string {
  return process.env.CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}

interface ChatFieldContext {
  label: string;
  section?: string;
  fieldId?: string;
}

interface ParsedChatBody {
  sessionId: string | null;
  grantId: string;
  draftId: string | null; // fieldContext 해석용, 비저장(§7.2)
  text: string;
  fieldContext?: ChatFieldContext;
}

type GrantChatUIMessage = UIMessage<unknown, { fieldAssist: FieldAssistOutcome }>;

export async function POST(request: Request) {
  try {
    const access = await requireCompanyAccess({ permission: "write" });
    const body = parseChatBody(await readJson(request));
    const db = getCunoteDb();

    // 공고 존재 확인(세션 FK·컨텍스트 유효성). 없으면 404.
    if (!(await grantExists(db, body.grantId))) {
      throw new ChatSessionError("grant_not_found", "공고를 찾을 수 없습니다.", 404);
    }

    // 예산 집행(당일 합산 SQL) — 스트리밍 전. 초과 시 429.
    await assertChatBudget(db, access.companyId);

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new ChatSessionError("anthropic_key_missing", "채팅 서비스를 사용할 수 없습니다.", 500);
    }

    const model = chatModel();
    const { sessionId } = await resolveOrCreateGrantSession({
      db,
      access,
      sessionId: body.sessionId,
      grantId: body.grantId,
      model,
    });

    // 현재 사용자 메시지를 먼저 영속화(멀티턴 재구성의 원천).
    await insertUserMessage(db, sessionId, body.text);

    // 그라운딩 조립(현재 fieldContext 반영) + 세션 메시지로 모델 입력 구성.
    const grounding = await buildGrantGrounding({
      grantId: body.grantId,
      companyId: access.companyId,
      ...(body.fieldContext
        ? {
            fieldContext: {
              label: body.fieldContext.label,
              ...(body.fieldContext.section ? { section: body.fieldContext.section } : {}),
              ...(body.fieldContext.fieldId ? { fieldId: body.fieldContext.fieldId } : {}),
            },
          }
        : {}),
    });
    const priorMessages = await loadSessionMessages(db, sessionId);
    const modelMessages = buildGrantModelMessages({
      grounding,
      messages: priorMessages,
      ...(grounding.fieldContextBlock ? { fieldContextBlock: grounding.fieldContextBlock } : {}),
    });

    const anthropic = createAnthropic({ apiKey });
    const result = streamText({
      model: anthropic(model),
      system: grounding.system,
      messages: modelMessages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // 클라이언트 abortSignal 을 전파하지 않는다(ADR-6): 어보트해도 업스트림은 완주해 usage 를 기록한다.
    });

    const persist = async (responseMessage: { parts?: readonly unknown[] }) => {
      try {
        const content = uiMessagePartsToContent(
          (responseMessage.parts ?? []) as UiMessagePartLike[],
        );
        const usage = normalizeChatUsage(await result.usage, await result.providerMetadata);
        await persistAssistantTurn({ db, sessionId, content, usage });
      } catch (error) {
        console.error("[chat] assistant 영속화 실패", error);
      }
    };

    if (body.fieldContext && body.draftId) {
      const assistPromise = buildFieldAssistOutcome({
        access,
        grantId: body.grantId,
        draftId: body.draftId,
        field: body.fieldContext,
        userMessage: body.text,
      }).catch((error): FieldAssistOutcome => {
        console.error("[chat] field assist 생성 실패", error);
        return {
          status: "guidance",
          fieldId: body.fieldContext?.fieldId ?? `label:${body.fieldContext?.label ?? "field"}`,
          label: body.fieldContext?.label ?? "작성 항목",
          guidance: "지금은 추천 값을 안전하게 만들지 못했습니다. 아래 답변을 참고해 직접 입력해 주세요.",
        };
      });
      const stream = createUIMessageStream<GrantChatUIMessage>({
        execute: async ({ writer }) => {
          writer.merge(result.toUIMessageStream<GrantChatUIMessage>({
            sendSources: true,
            sendFinish: false,
            onError: () => "답변을 생성하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
          }));
          await result.text;
          const outcome = await assistPromise;
          writer.write({
            type: "data-fieldAssist",
            id: `field-assist-${outcome.fieldId}`,
            data: outcome,
          });
          writer.write({ type: "finish", finishReason: "stop" });
        },
        onEnd: async ({ responseMessage }) => {
          await persist(responseMessage);
        },
        onError: () => "답변을 생성하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      });
      return createUIMessageStreamResponse({
        stream,
        headers: { "X-Cunote-Chat-Session": sessionId },
        consumeSseStream: ({ stream: responseStream }) => {
          void consumeStream({ stream: responseStream });
        },
      });
    }

    // 백프레셔 제거 → 클라이언트 어보트 시에도 스트림 완주 & onEnd 발화 보장(ADR-6).
    void result.consumeStream();

    return result.toUIMessageStreamResponse({
      sendSources: true, // P0-1 필수: citations 를 source-document 파트로 표면화.
      onEnd: async ({ responseMessage }) => {
        await persist(responseMessage);
      },
      onError: () => "답변을 생성하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      headers: { "X-Cunote-Chat-Session": sessionId },
    });
  } catch (error) {
    return webActionError(error, {
      code: "chat_failed",
      message: "채팅 응답을 생성하지 못했습니다.",
    });
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ChatSessionError("invalid_request_body", "요청 본문을 해석하지 못했습니다.", 400);
  }
}

function parseChatBody(body: unknown): ParsedChatBody {
  if (typeof body !== "object" || body === null) {
    throw new ChatSessionError("invalid_request_body", "요청 본문이 올바르지 않습니다.", 400);
  }
  const record = body as Record<string, unknown>;

  const context = record.context;
  if (typeof context !== "object" || context === null) {
    throw new ChatSessionError("invalid_context", "context 가 필요합니다.", 400);
  }
  const contextRecord = context as Record<string, unknown>;
  const contextType = contextRecord.type;
  if (contextType === "matching") {
    // Phase 5 전까지 matching 컨텍스트는 개방하지 않는다(§7.2).
    throw new ChatSessionError("matching_not_open", "매칭 채팅은 아직 제공되지 않습니다.", 400);
  }
  if (contextType !== "grant") {
    throw new ChatSessionError("invalid_context", "지원되지 않는 채팅 컨텍스트입니다.", 400);
  }
  const grantId = contextRecord.grantId;
  if (typeof grantId !== "string" || grantId.trim().length === 0) {
    throw new ChatSessionError("invalid_context", "grantId 가 필요합니다.", 400);
  }
  const draftIdRaw = contextRecord.draftId;
  const draftId = typeof draftIdRaw === "string" && draftIdRaw.trim().length > 0 ? draftIdRaw : null;

  const messageRaw = record.message;
  if (typeof messageRaw !== "object" || messageRaw === null) {
    throw new ChatSessionError("invalid_message", "message 가 필요합니다.", 400);
  }
  const messageRecord = messageRaw as Record<string, unknown>;
  const text = messageRecord.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ChatSessionError("invalid_message", "message.text 가 필요합니다.", 400);
  }
  if (text.length > MESSAGE_MAX_LENGTH) {
    throw new ChatSessionError("message_too_long", `메시지는 ${MESSAGE_MAX_LENGTH}자까지 보낼 수 있습니다.`, 400);
  }

  const sessionIdRaw = record.sessionId;
  const sessionId =
    typeof sessionIdRaw === "string" && sessionIdRaw.trim().length > 0 ? sessionIdRaw : null;

  const parsed: ParsedChatBody = { sessionId, grantId, draftId, text };

  const fieldContextRaw = messageRecord.fieldContext;
  if (typeof fieldContextRaw === "object" && fieldContextRaw !== null) {
    const fc = fieldContextRaw as Record<string, unknown>;
    if (typeof fc.label === "string" && fc.label.trim().length > 0) {
      const fieldContext: ChatFieldContext = { label: fc.label.trim().slice(0, 200) };
      if (typeof fc.section === "string" && fc.section.trim().length > 0) {
        fieldContext.section = fc.section.trim().slice(0, 200);
      }
      if (typeof fc.fieldId === "string" && fc.fieldId.trim().length > 0) {
        fieldContext.fieldId = fc.fieldId.trim();
      }
      parsed.fieldContext = fieldContext;
    }
  }

  return parsed;
}
