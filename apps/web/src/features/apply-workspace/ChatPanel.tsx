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
import { CheckCircle2, CircleHelp, ExternalLink, Loader2, Mail, MessageSquare, Phone, Quote, Send, Sparkles, Square, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
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
import type { StudioFieldTargetV1 } from "@/lib/rhwp/studioDocumentAgentProtocol";
import { ChatMessageMarkdown } from "./ChatMessageMarkdown";

export interface ChatFieldPrompt {
  label: string;
  section?: string | null;
  fieldId?: string | null;
  fieldAgent?: {
    baseRevisionId: string;
    target: StudioFieldTargetV1;
  };
}

export interface ChatFieldProposalApplyInput {
  fieldId: string;
  label: string;
  value: string;
  runId?: string;
  suggestionId?: string;
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
  askField: (field: ChatFieldPrompt) => void;
  activeField: ChatFieldPrompt | null;
  cancel: () => void;
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

function initialFieldQuestion(label: string): string {
  return `'${label}' 항목은 어떤 내용을 어떻게 작성해야 하나요? 공고 기준으로 알려주세요.`;
}

export function collectFieldEvidence(current: readonly string[], text: string, label: string): string[] {
  const normalized = text.trim();
  if (!normalized || normalized === initialFieldQuestion(label) || current.includes(normalized)) {
    return [...current];
  }
  return [...current, normalized].slice(-6);
}

/** WorkspaceView 에서 단 한 번 호출하는 채팅 컨트롤러 훅(단일 세션). */
export function useGrantChat(input: { grantId: string; draftId?: string | null }): GrantChatController {
  const { grantId, draftId } = input;
  const sessionIdRef = useRef<string | null>(null);
  const pendingFieldContextRef = useRef<ChatFieldPrompt | null>(null);
  const activeFieldContextRef = useRef<ChatFieldPrompt | null>(null);
  const fieldEvidenceRef = useRef<Map<string, string[]>>(new Map());
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
          const text = lastMessageText(last).trim();
          const fieldPromptForTurn = pendingFieldContextRef.current ?? activeFieldContextRef.current;
          pendingFieldContextRef.current = null; // per-메시지 소비.
          if (fieldPromptForTurn) activeFieldContextRef.current = fieldPromptForTurn;
          let evidenceText: string | undefined;
          if (fieldPromptForTurn) {
            const fieldKey = fieldPromptForTurn.fieldId?.trim() || `label:${fieldPromptForTurn.label}`;
            const currentEvidence = fieldEvidenceRef.current.get(fieldKey) ?? [];
            const nextEvidence = collectFieldEvidence(currentEvidence, text, fieldPromptForTurn.label);
            fieldEvidenceRef.current.set(fieldKey, nextEvidence);
            const combined = nextEvidence.join("\n").trim().slice(0, 4_000);
            if (combined) evidenceText = combined;
          }
          const fieldContext = fieldPromptForTurn
            ? {
                label: fieldPromptForTurn.label,
                ...(fieldPromptForTurn.section ? { section: fieldPromptForTurn.section } : {}),
                ...(fieldPromptForTurn.fieldId ? { fieldId: fieldPromptForTurn.fieldId } : {}),
                ...(evidenceText ? { evidenceText } : {}),
                ...(fieldPromptForTurn.fieldAgent ? {
                  fieldAgent: {
                    ...fieldPromptForTurn.fieldAgent,
                    clientRequestId: crypto.randomUUID(),
                  },
                } : {}),
              }
            : undefined;
          return {
            body: {
              sessionId: sessionIdRef.current,
              context: { type: "grant", grantId, ...(draftId ? { draftId } : {}) },
              message: { text, ...(fieldContext ? { fieldContext } : {}) },
            },
          };
        },
      }),
    [grantId, draftId],
  );

  const { messages, sendMessage, regenerate, stop, status, error } = useChat({
    transport,
    // AI SDK는 기본적으로 스트림 chunk마다 렌더한다. 짧은 간격으로 묶어 Markdown 재파싱과
    // 레이아웃 측정을 줄이되, 타이핑처럼 보이는 응답성은 유지한다.
    throttle: 50,
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

  const askField = useCallback(
    (field: ChatFieldPrompt) => {
      if (isBusy) return;
      setFailure(null);
      pendingFieldContextRef.current = field;
      activeFieldContextRef.current = field;
      setActiveField(field);
      const question = initialFieldQuestion(field.label);
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

  const cancel = useCallback(() => {
    if (!isBusy) return;
    // 서버는 사용량 기록을 위해 upstream 생성을 완주하므로, 사용자가 보지 않은 assistant turn과
    // 다음 질문이 섞이지 않도록 취소한 클라이언트는 새 세션에서 이어간다.
    sessionIdRef.current = null;
    pendingFieldContextRef.current = activeFieldContextRef.current;
    setFailure(null);
    void stop();
  }, [isBusy, stop]);

  const errorMessage = failure ? grantChatFailureMessage(failure) : null;

  return {
    messages: messages as unknown as UiChatMessageLike[],
    isBusy,
    errorMessage,
    canRetry: Boolean(errorMessage) && messages.length > 0 && !isBusy,
    input: inputValue,
    setInput: setInputValue,
    submit,
    askField,
    activeField,
    cancel,
    retry,
  };
}

/** 표현 전용 채팅 뷰(컨트롤러를 공유받아 렌더만 한다). */
export function ChatPanelView({
  controller,
  greeting,
  variant = "dock",
  fillAvailableHeight = false,
  institutionContact,
  onClose,
  onApplyFieldProposal,
}: {
  controller: GrantChatController;
  greeting: ChatMessageContent;
  variant?: "dock" | "front";
  fillAvailableHeight?: boolean;
  institutionContact?: InstitutionContact | null;
  onClose?: () => void;
  onApplyFieldProposal?: (input: ChatFieldProposalApplyInput) => void;
}) {
  const { messages, isBusy, errorMessage, canRetry, input, setInput, submit, cancel, retry } = controller;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [answeringFieldQuestion, setAnsweringFieldQuestion] = useState(false);
  const lastMessage = messages[messages.length - 1];
  const showTypingIndicator = isBusy && (
    !lastMessage
    || lastMessage.role !== "assistant"
    || lastMessageText(lastMessage).trim().length === 0
  );
  const submitFromComposer = useCallback(() => {
    if (!input.trim() || isBusy) return;
    setAnsweringFieldQuestion(false);
    submit();
  }, [input, isBusy, submit]);
  const focusFieldAnswer = useCallback(() => {
    setAnsweringFieldQuestion(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-[var(--radius-xl)] border bg-card p-5 sm:gap-5 sm:p-6",
        fillAvailableHeight
          ? "min-h-0 flex-1"
          : variant === "front"
            ? "min-h-96"
            : "min-h-0 shrink-0",
      )}
    >
      <div className="flex min-h-10 items-center gap-2.5 text-sm font-medium">
        <MessageSquare className="text-muted-foreground" aria-hidden />
        이 공고에 대해 물어보기
        {controller.activeField ? (
          <Badge variant="secondary" className="max-w-44 truncate">
            {controller.activeField.label} 작성 중
          </Badge>
        ) : null}
        {onClose ? (
          <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="채팅 닫기" className="ml-auto">
            <X />
          </Button>
        ) : null}
      </div>

      <MessageScrollerProvider autoScroll>
        <MessageScroller
          className={cn(
            "w-full",
            fillAvailableHeight
              ? "min-h-56 flex-1"
              : variant === "front"
                ? "h-[45dvh] min-h-56 max-h-[28rem] flex-none"
                : "h-72 flex-none",
          )}
        >
          <MessageScrollerViewport aria-label="공고 대화 내역">
            <MessageScrollerContent className="gap-5 pr-1" aria-live="polite" aria-relevant="additions text">
              <MessageScrollerItem messageId="grant-chat-greeting">
                <AssistantBubble content={greeting} />
              </MessageScrollerItem>
              {messages.map((message) => {
                const content = uiMessagePartsToContent((message.parts ?? []) as UiMessagePartLike[]);
                if (message.role === "user") {
                  return (
                    <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor>
                      <UserBubble text={content.text} />
                    </MessageScrollerItem>
                  );
                }
                return (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    <AssistantBubble
                      content={content}
                      {...(onApplyFieldProposal ? { onApplyFieldProposal } : {})}
                      onRequestAnswer={focusFieldAnswer}
                    />
                  </MessageScrollerItem>
                );
              })}
              {showTypingIndicator ? (
                <MessageScrollerItem messageId="grant-chat-typing">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                    <Loader2 className="animate-spin" aria-hidden />
                    답변을 작성하고 있어요…
                  </div>
                </MessageScrollerItem>
              ) : null}
              {errorMessage ? (
                <MessageScrollerItem messageId="grant-chat-error">
                  <Alert variant="destructive">
                    <AlertDescription className="flex flex-col items-start gap-2">
                      {errorMessage}
                      <Button type="button" size="xs" variant="outline" disabled={!canRetry} onClick={retry}>
                        같은 질문 다시 요청
                      </Button>
                    </AlertDescription>
                  </Alert>
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitFromComposer();
        }}
        className="flex flex-col gap-2 border-t pt-4"
      >
        {answeringFieldQuestion ? (
          <p className="text-xs font-medium text-primary" id="field-answer-mode">
            AI가 요청한 정보를 입력하고 있어요. 작성한 내용만 전송됩니다.
          </p>
        ) : null}
        <div className="flex min-w-0 items-stretch gap-3">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitFromComposer();
              }
            }}
            placeholder={answeringFieldQuestion
              ? "위 질문에 대한 실제 사실을 적어 주세요"
              : controller.activeField
                ? `${controller.activeField.label}에 반영할 사실이나 수정 방향을 적어 주세요`
                : "공고 내용·자격·마감·작성 요령을 물어보세요"}
            aria-label="채팅 입력"
            aria-describedby={answeringFieldQuestion ? "field-answer-mode" : undefined}
            rows={variant === "front" ? 3 : 2}
            disabled={isBusy}
            className="min-h-24 flex-1 resize-none"
          />
          {isBusy ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={cancel}
              aria-label="답변 생성 중단"
              className="h-auto w-12 self-stretch"
            >
              <Square aria-hidden />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={input.trim().length === 0}
              aria-label="보내기"
              className="h-auto w-12 self-stretch"
            >
              <Send aria-hidden />
            </Button>
          )}
        </div>
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
    <Message align="end">
      <MessageContent>
        <Bubble align="end" className="max-w-[min(85%,48rem)]">
          <BubbleContent className="px-4 py-3 whitespace-pre-wrap">{text}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function AssistantBubble({
  content,
  onApplyFieldProposal,
  onRequestAnswer,
}: {
  content: ChatMessageContent;
  onApplyFieldProposal?: (input: ChatFieldProposalApplyInput) => void;
  onRequestAnswer?: () => void;
}) {
  const hasCitations = (content.citations?.length ?? 0) > 0;
  const hasText = content.text.trim().length > 0;
  const isGeneralNotice = hasText && content.generalNotice === true && !hasCitations;
  return (
    <Message align="start">
      <MessageContent className="gap-1.5">
        {hasText ? (
          <Bubble variant={isGeneralNotice ? "muted" : "outline"} className="max-w-[min(92%,48rem)]">
            <BubbleContent className={cn("px-4 py-3 leading-6", isGeneralNotice && "border-dashed text-muted-foreground")}>
              {isGeneralNotice ? (
                <span className="mb-1 block text-xs font-medium text-muted-foreground">일반 안내</span>
              ) : null}
              <ChatMessageMarkdown>{content.text}</ChatMessageMarkdown>
            </BubbleContent>
          </Bubble>
        ) : null}
        {hasCitations ? (
          <div className="flex flex-wrap gap-1">
            {content.citations!.map((citation, index) => (
              <Tooltip key={`${index}-${citation.citedText}`}>
                <TooltipTrigger
                  render={
                    <Badge
                      variant="outline"
                      render={<button type="button" />}
                      className="h-8 min-w-0 max-w-[min(32rem,100%)] border-sky-500/40 bg-sky-500/10 px-3 text-sky-700 dark:text-sky-400"
                    />
                  }
                >
                  <Quote data-icon="inline-start" aria-hidden />
                  <span className="min-w-0 truncate">{citation.citedText}</span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-60 items-start px-2.5 py-2 leading-5">
                  <span className="line-clamp-4 text-pretty break-words">{citation.citedText}</span>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ) : null}
        {content.fieldAssist ? (
          <FieldAssistCard
            outcome={content.fieldAssist}
            {...(onApplyFieldProposal ? { onApply: onApplyFieldProposal } : {})}
            {...(onRequestAnswer ? { onRequestAnswer } : {})}
          />
        ) : null}
      </MessageContent>
    </Message>
  );
}

export function FieldAssistCard({
  outcome,
  onApply,
  onRequestAnswer,
}: {
  outcome: FieldAssistOutcome;
  onApply?: (input: ChatFieldProposalApplyInput) => void;
  onRequestAnswer?: () => void;
}) {
  const readiness = outcome.readiness;
  return (
    <Card size="sm" className="w-full max-w-2xl border-primary/20 bg-primary/[0.04] [--card-spacing:--spacing(4)] sm:[--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Sparkles className="text-primary" data-icon="inline-start" aria-hidden />
          {outcome.label} 문서 반영 준비도
          <Badge variant={readiness.canApply ? "default" : "secondary"} className="ml-auto">
            {readiness.canApply ? "반영 가능" : "정보 수집 중"}
          </Badge>
        </CardTitle>
        <CardDescription className="text-sm leading-6">{outcome.guidance}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Progress
          value={readiness.score}
          aria-label={`${outcome.label} 문서 반영 준비도`}
          className="[&_[data-slot=progress-track]]:h-2"
        >
          <ProgressLabel>현재 준비도</ProgressLabel>
          <ProgressValue>{() => `${readiness.score}%`}</ProgressValue>
        </Progress>
        <p className="text-xs leading-5 text-muted-foreground">
          {readiness.threshold}% 이상이 되면 검증된 초안을 문서에 반영할 수 있어요.
        </p>
        {outcome.status === "proposal" ? (
          <>
            <div className="rounded-[var(--radius-lg)] border bg-background px-4 py-3 text-sm leading-6 whitespace-pre-wrap">
              {outcome.proposal.value}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">근거: {outcome.proposal.basis}</p>
            {readiness.canApply ? (
              <Button
                type="button"
                onClick={() => onApply?.({
                  fieldId: outcome.fieldId,
                  label: outcome.label,
                  value: outcome.proposal.value,
                  ...(outcome.proposal.runId ? { runId: outcome.proposal.runId } : {}),
                  ...(outcome.proposal.suggestionId ? { suggestionId: outcome.proposal.suggestionId } : {}),
                })}
                disabled={!onApply}
              >
                <CheckCircle2 data-icon="inline-start" aria-hidden />
                {outcome.label}에 적용하기
              </Button>
            ) : null}
          </>
        ) : null}
        {outcome.status === "needs_input" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold">AI가 더 확인해야 할 내용</p>
            <ul className="grid gap-2" aria-label="추가로 필요한 정보">
              {outcome.questions.map((question) => (
                <li key={question} className="flex min-h-12 items-start gap-2.5 rounded-[var(--radius-lg)] border bg-background px-4 py-3 text-sm leading-6">
                  <CircleHelp className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span>{question}</span>
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" onClick={onRequestAnswer} disabled={!onRequestAnswer}>
              답변 입력하기
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
