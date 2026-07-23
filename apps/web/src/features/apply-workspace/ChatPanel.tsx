"use client";

/**
 * 채팅 패널 (Apply Experience v2 · §4.3/§7.2 · P3-6/P3-7).
 *
 * 스트리밍 채팅(AI SDK useChat) · 인용 뱃지(cited_text 표시, 페이지 점프 없음) · 인용 없는 답변은
 * "일반 안내" 시각 구분(원칙 P4) · 진입 시 자동 오픈 + 서버 상황 인사(첫 assistant 버블).
 * "이 항목이 뭐예요?"(FieldCard) → fieldContext 프리필 전송(ADR-9).
 *
 * **단일 세션 원칙**: 데스크톱 dock 과 모바일 탭이 동시에 마운트되므로, useChat 을 WorkspaceView 에서
 * `useGrantChat` 로 한 번만 호출해 컨트롤러를 공유한다(멀티 인스턴스→멀티 세션 방지). 각 뷰(ChatPanelView)는
 * 표현만 담당한다.
 *
 * 전송 계층 격리(ADR-4): UIMessage 파트 → ChatMessageContent 매핑은 공용 모듈(lib/chat/messageContent)로.
 * 세션은 서버가 X-Cunote-Chat-Session 헤더로 발급 → 커스텀 fetch 로 캡처해 다음 턴에 재사용(§7.2 소유권).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { CheckCircle2, ExternalLink, Loader2, Mail, MessageSquare, Phone, Quote, Send, Sparkles, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  uiMessagePartsToContent,
  type ChatMessageContent,
  type FieldAssistOutcome,
  type UiMessagePartLike,
} from "@/lib/chat/messageContent";
import {
  GRANT_CHAT_TIMEOUT_MS,
  grantChatFailureMessage,
  isGrantChatBusyStatus,
  type GrantChatFailure,
} from "./chatRequestState";
import { contactPhoneHref, type InstitutionContact } from "./workspacePresentation";

export interface ChatFieldPrompt {
  label: string;
  section?: string | null;
  fieldId?: string | null;
}

interface UiChatMessageLike {
  id: string;
  role: string;
  parts?: readonly UiMessagePartLike[];
}

export interface GrantChatController {
  messages: UiChatMessageLike[];
  isBusy: boolean;
  errorMessage: string | null;
  canRetry: boolean;
  input: string;
  setInput: (value: string) => void;
  submit: () => void;
  sendText: (text: string) => void;
  askField: (field: ChatFieldPrompt) => void;
  activeField: ChatFieldPrompt | null;
  retry: () => void;
}

function lastMessageText(message: UiChatMessageLike | undefined): string {
  if (!message?.parts) return "";
  return message.parts
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("");
}

/** WorkspaceView 에서 단 한 번 호출하는 채팅 컨트롤러 훅(단일 세션). */
export function useGrantChat(input: { grantId: string; draftId?: string | null }): GrantChatController {
  const { grantId, draftId } = input;
  const sessionIdRef = useRef<string | null>(null);
  const pendingFieldContextRef = useRef<ChatFieldPrompt | null>(null);
  const activeFieldContextRef = useRef<ChatFieldPrompt | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [activeField, setActiveField] = useState<ChatFieldPrompt | null>(null);
  const [failure, setFailure] = useState<GrantChatFailure | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/web/chat",
        // 서버가 발급하는 세션 id 를 응답 헤더에서 캡처해 다음 턴에 재사용한다.
        fetch: (async (url: RequestInfo | URL, options?: RequestInit) => {
          const response = await fetch(url, options);
          const sid = response.headers.get("X-Cunote-Chat-Session");
          if (sid) sessionIdRef.current = sid;
          return response;
        }) as typeof fetch,
        // §7.2 바디: 단일 message + sessionId + context(서버가 히스토리를 보유).
        prepareSendMessagesRequest: ({ messages }) => {
          const last = messages[messages.length - 1] as UiChatMessageLike | undefined;
          const fieldPromptForTurn = pendingFieldContextRef.current ?? activeFieldContextRef.current;
          pendingFieldContextRef.current = null; // per-메시지 소비.
          if (fieldPromptForTurn) activeFieldContextRef.current = fieldPromptForTurn;
          const fieldContext = fieldPromptForTurn
            ? {
                label: fieldPromptForTurn.label,
                ...(fieldPromptForTurn.section ? { section: fieldPromptForTurn.section } : {}),
                ...(fieldPromptForTurn.fieldId ? { fieldId: fieldPromptForTurn.fieldId } : {}),
              }
            : undefined;
          return {
            body: {
              sessionId: sessionIdRef.current,
              context: { type: "grant", grantId, ...(draftId ? { draftId } : {}) },
              message: { text: lastMessageText(last), ...(fieldContext ? { fieldContext } : {}) },
            },
          };
        },
      }),
    [grantId, draftId],
  );

  const { messages, sendMessage, regenerate, stop, status, error } = useChat({
    transport,
    onFinish: ({ isAbort, isError }) => {
      if (!isAbort && !isError) setFailure(null);
    },
  });
  const isBusy = isGrantChatBusyStatus(status);

  useEffect(() => {
    if (!isBusy) return;
    const timeoutId = window.setTimeout(() => {
      // 시간 초과 턴은 기존 서버 세션에서 분리해, 재시도 시 동일 user turn이
      // 하나의 세션에 중복 적재되지 않게 한다. regenerate는 클라이언트 user 메시지를 추가하지 않는다.
      sessionIdRef.current = null;
      setFailure("timeout");
      void stop();
    }, GRANT_CHAT_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isBusy, stop]);

  useEffect(() => {
    if (error) setFailure("request");
  }, [error]);

  useEffect(() => () => {
    void stop();
  }, [stop]);

  const submit = useCallback(() => {
    const text = inputValue.trim();
    if (!text || isBusy) return;
    setFailure(null);
    setInputValue("");
    void sendMessage({ text });
  }, [inputValue, isBusy, sendMessage]);

  const sendText = useCallback((text: string) => {
    const normalized = text.trim();
    if (!normalized || isBusy) return;
    setFailure(null);
    setInputValue("");
    void sendMessage({ text: normalized });
  }, [isBusy, sendMessage]);

  const askField = useCallback(
    (field: ChatFieldPrompt) => {
      if (isBusy) return;
      setFailure(null);
      pendingFieldContextRef.current = field;
      activeFieldContextRef.current = field;
      setActiveField(field);
      const question = `'${field.label}' 항목은 어떤 내용을 어떻게 작성해야 하나요? 공고 기준으로 알려주세요.`;
      void sendMessage({ text: question });
    },
    [isBusy, sendMessage],
  );

  const retry = useCallback(() => {
    if (isBusy || messages.length === 0) return;
    // 이전 세션에는 user turn이 이미 저장됐을 수 있으므로 재시도는 새 세션으로 분리한다.
    // AI SDK regenerate는 마지막 user 메시지를 재사용해 클라이언트 대화에 중복 turn을 추가하지 않는다.
    sessionIdRef.current = null;
    pendingFieldContextRef.current = activeFieldContextRef.current;
    setFailure(null);
    void regenerate();
  }, [isBusy, messages.length, regenerate]);

  const errorMessage = failure ? grantChatFailureMessage(failure) : null;

  return {
    messages: messages as unknown as UiChatMessageLike[],
    isBusy,
    errorMessage,
    canRetry: Boolean(errorMessage) && messages.length > 0 && !isBusy,
    input: inputValue,
    setInput: setInputValue,
    submit,
    sendText,
    askField,
    activeField,
    retry,
  };
}

/** 표현 전용 채팅 뷰(컨트롤러를 공유받아 렌더만 한다). */
export function ChatPanelView({
  controller,
  greeting,
  variant = "dock",
  institutionContact,
  onClose,
  onApplyFieldProposal,
}: {
  controller: GrantChatController;
  greeting: ChatMessageContent;
  variant?: "dock" | "front";
  institutionContact?: InstitutionContact | null;
  onClose?: () => void;
  onApplyFieldProposal?: (input: { label: string; value: string }) => void;
}) {
  const { messages, isBusy, errorMessage, canRetry, input, setInput, submit, sendText, retry } = controller;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const showTypingIndicator =
    isBusy && (messages.length === 0 || messages[messages.length - 1]?.role !== "assistant");

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-[var(--radius-xl)] border bg-card p-4",
        variant === "front" ? "min-h-96" : "min-h-0 shrink-0",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageSquare className="text-muted-foreground" aria-hidden />
        이 공고에 대해 물어보기
        {onClose ? (
          <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="채팅 닫기" className="ml-auto">
            <X />
          </Button>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1",
          variant === "front" ? "max-h-[28rem]" : "max-h-72",
        )}
      >
        <AssistantBubble content={greeting} />
        {messages.map((message) => {
          const content = uiMessagePartsToContent((message.parts ?? []) as UiMessagePartLike[]);
          if (message.role === "user") {
            return <UserBubble key={message.id} text={content.text} />;
          }
            return (
              <AssistantBubble
                key={message.id}
                content={content}
                {...(onApplyFieldProposal ? { onApplyFieldProposal } : {})}
                onAskQuestion={sendText}
              />
            );
        })}
        {showTypingIndicator ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            답변을 작성하고 있어요…
          </div>
        ) : null}
        {errorMessage ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-col items-start gap-2">
              {errorMessage}
              <Button type="button" size="xs" variant="outline" disabled={!canRetry} onClick={retry}>
                같은 질문 다시 요청
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex items-end gap-2"
      >
        <Textarea
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="공고 내용·자격·마감·작성 요령을 물어보세요"
          aria-label="채팅 입력"
          rows={variant === "front" ? 3 : 2}
          disabled={isBusy}
          className="min-h-0 flex-1 resize-none"
        />
        <Button type="submit" size="icon" disabled={isBusy || input.trim().length === 0} aria-label="보내기">
          {isBusy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        </Button>
      </form>

      {institutionContact ? (
        <>
          <Separator />
          <InstitutionContactCard contact={institutionContact} />
        </>
      ) : null}
    </div>
  );
}

function InstitutionContactCard({ contact }: { contact: InstitutionContact }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>기관에 직접 물어보기</CardTitle>
        <CardDescription>{contact.name}의 공고 공개 정보로 연결합니다.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {contact.phone ? (
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href={contactPhoneHref(contact.phone)}>
            <Phone data-icon="inline-start" aria-hidden />
            {contact.phone}
          </a>
        ) : null}
        {contact.email ? (
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href={`mailto:${contact.email}`}>
            <Mail data-icon="inline-start" aria-hidden />
            메일 보내기
          </a>
        ) : null}
        {contact.sourceUrl ? (
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={contact.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink data-icon="inline-start" aria-hidden />
            공고 원문에서 확인
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}

function UserBubble({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--radius-lg)] bg-primary px-3 py-2 text-sm text-primary-foreground">
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({
  content,
  onApplyFieldProposal,
  onAskQuestion,
}: {
  content: ChatMessageContent;
  onApplyFieldProposal?: (input: { label: string; value: string }) => void;
  onAskQuestion?: (question: string) => void;
}) {
  const hasCitations = (content.citations?.length ?? 0) > 0;
  const isGeneralNotice = content.generalNotice === true && !hasCitations;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "max-w-[92%] whitespace-pre-wrap break-words rounded-[var(--radius-lg)] px-3 py-2 text-sm",
          isGeneralNotice
            ? "border border-dashed border-border bg-muted/40 text-muted-foreground"
            : "border bg-background text-foreground",
        )}
      >
        {isGeneralNotice ? (
          <span className="mb-1 block text-xs font-medium text-muted-foreground">일반 안내</span>
        ) : null}
        {content.text || (isGeneralNotice ? "" : "…")}
      </div>
      {hasCitations ? (
        <div className="flex flex-wrap gap-1">
          {content.citations!.map((citation, index) => (
            <Tooltip key={`${index}-${citation.citedText.slice(0, 8)}`}>
              <TooltipTrigger
                render={
                  <Badge
                    variant="outline"
                    className="max-w-full gap-1 border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400"
                  />
                }
              >
                <Quote className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{citation.citedText}</span>
              </TooltipTrigger>
              <TooltipContent>{citation.citedText}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : null}
      {content.fieldAssist ? (
        <FieldAssistCard
          outcome={content.fieldAssist}
          {...(onApplyFieldProposal ? { onApply: onApplyFieldProposal } : {})}
          {...(onAskQuestion ? { onAskQuestion } : {})}
        />
      ) : null}
    </div>
  );
}

function FieldAssistCard({
  outcome,
  onApply,
  onAskQuestion,
}: {
  outcome: FieldAssistOutcome;
  onApply?: (input: { label: string; value: string }) => void;
  onAskQuestion?: (question: string) => void;
}) {
  return (
    <Card size="sm" className="max-w-[92%] border-primary/20 bg-primary/[0.04]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4 text-primary" aria-hidden />
          {outcome.label} 작성 도우미
        </CardTitle>
        <CardDescription>{outcome.guidance}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {outcome.status === "proposal" ? (
          <>
            <div className="rounded-[var(--radius-lg)] border bg-background px-3 py-2 text-sm whitespace-pre-wrap">
              {outcome.proposal.value}
            </div>
            <p className="text-xs text-muted-foreground">근거: {outcome.proposal.basis}</p>
            <Button
              type="button"
              size="sm"
              onClick={() => onApply?.({ label: outcome.label, value: outcome.proposal.value })}
              disabled={!onApply}
            >
              <CheckCircle2 data-icon="inline-start" aria-hidden />
              이 값으로 채우기
            </Button>
          </>
        ) : null}
        {outcome.status === "needs_input" ? (
          <div className="flex flex-col gap-2">
            {outcome.questions.map((question) => (
              <Button
                key={question}
                type="button"
                variant="outline"
                size="sm"
                className="h-auto justify-start whitespace-normal text-left"
                onClick={() => onAskQuestion?.(question)}
                disabled={!onAskQuestion}
              >
                {question}
              </Button>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
