/**
 * 채팅 메시지 콘텐츠 — 전송 계층 격리 지점 (Apply Experience v2 · §7.2 · ADR-4).
 *
 * 서버 영속화(chat_messages.content)와 클라이언트 렌더가 공용하는 고정 형태다.
 * AI SDK 의 UIMessage 파트(`text` / `source-document`)를 이 형태로 얕게 매핑한다 —
 * P0-1 실측(ADR-4): 인용 메타는 `source-document` 파트의
 * `providerMetadata.anthropic.{citedText,startCharIndex,endCharIndex}` 에 중첩되어 온다.
 *
 * 이 모듈은 **클라이언트-안전**하다(서버 전용 모듈 import 금지) — schema.ts(서버)와
 * ChatPanel(클라이언트)이 함께 import 한다.
 */

/** §7.2 인용 1건. page/오프셋은 표시용 부가 정보(페이지 점프는 P6-6). */
export interface ChatCitation {
  citedText: string;
  page?: number;
  startChar?: number;
  endChar?: number;
}

export type FieldAssistOutcome =
  | {
      status: "guidance";
      fieldId: string;
      label: string;
      guidance: string;
    }
  | {
      status: "needs_input";
      fieldId: string;
      label: string;
      guidance: string;
      questions: string[];
    }
  | {
      status: "proposal";
      fieldId: string;
      label: string;
      guidance: string;
      proposal: {
        value: string;
        basis: string;
        basisKind: "announcement" | "profile" | "user";
      };
    };

/** §7.2 클라이언트-서버 공용 메시지 콘텐츠. 전송 계층과 무관하게 고정. */
export interface ChatMessageContent {
  text: string;
  citations?: ChatCitation[];
  /** 인용이 하나도 없는 일반 안내 메시지 여부 (원칙 P4 시각 구분). */
  generalNotice?: boolean;
  /** 필드 문맥 턴의 실행 가능한 안내. 기존 JSONB 행에는 없을 수 있는 additive 계약. */
  fieldAssist?: FieldAssistOutcome;
}

/**
 * UIMessage 파트의 최소 구조 타입(AI SDK 타입에 강결합하지 않도록 구조적으로 정의).
 * 실제 파트는 이보다 필드가 많지만 매핑에 필요한 것만 좁혀 받는다.
 */
export interface UiMessageTextPart {
  type: "text";
  text: string;
}
export interface UiMessageSourceDocumentPart {
  type: "source-document";
  sourceId?: string;
  title?: string;
  filename?: string;
  mediaType?: string;
  providerMetadata?: {
    anthropic?: {
      citedText?: unknown;
      startCharIndex?: unknown;
      endCharIndex?: unknown;
    };
  };
}
export type UiMessagePartLike =
  | UiMessageTextPart
  | UiMessageSourceDocumentPart
  | { type: string; [key: string]: unknown };

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseFieldAssistOutcome(value: unknown): FieldAssistOutcome | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  const fieldId = typeof record.fieldId === "string" ? record.fieldId.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const guidance = typeof record.guidance === "string" ? record.guidance.trim() : "";
  if (!fieldId || !label || !guidance) return null;
  if (status === "guidance") return { status, fieldId, label, guidance };
  if (status === "needs_input") {
    if (!Array.isArray(record.questions)) return null;
    const questions = record.questions
      .filter((question): question is string => typeof question === "string")
      .map((question) => question.trim())
      .filter(Boolean)
      .slice(0, 2);
    if (questions.length === 0) return null;
    return { status, fieldId, label, guidance, questions };
  }
  if (status !== "proposal" || !record.proposal || typeof record.proposal !== "object") return null;
  const proposal = record.proposal as Record<string, unknown>;
  const proposalValue = typeof proposal.value === "string" ? proposal.value.trim() : "";
  const basis = typeof proposal.basis === "string" ? proposal.basis.trim() : "";
  const basisKind = proposal.basisKind;
  if (
    !proposalValue
    || !basis
    || (basisKind !== "announcement" && basisKind !== "profile" && basisKind !== "user")
  ) return null;
  return {
    status,
    fieldId,
    label,
    guidance,
    proposal: { value: proposalValue, basis, basisKind },
  };
}

/** `source-document` 파트 1건 → ChatCitation(citedText 없으면 null). */
export function sourceDocumentToCitation(part: UiMessageSourceDocumentPart): ChatCitation | null {
  const meta = part.providerMetadata?.anthropic;
  const citedText = typeof meta?.citedText === "string" ? meta.citedText.trim() : "";
  if (!citedText) return null;
  const citation: ChatCitation = { citedText };
  const start = toFiniteNumber(meta?.startCharIndex);
  const end = toFiniteNumber(meta?.endCharIndex);
  if (start !== undefined) citation.startChar = start;
  if (end !== undefined) citation.endChar = end;
  return citation;
}

/**
 * UIMessage 파트 배열 → ChatMessageContent (얕은 매핑).
 * - text: 모든 text 파트를 순서대로 이어붙인다.
 * - citations: 모든 source-document 파트에서 anthropic 인용 메타를 추출(citedText 있는 것만).
 * - generalNotice: 인용이 하나도 없으면 true(원칙 P4 — 인용 없는 메시지는 "일반 안내").
 *
 * 스트림 순서상 source 파트는 연관 텍스트 블록 직전에 온다(ADR-4). v1 은 메시지 단위 generalNotice
 * 로 구분하며, 문장 단위 하이라이트는 P6-6.
 */
export function uiMessagePartsToContent(parts: readonly UiMessagePartLike[]): ChatMessageContent {
  let text = "";
  const citations: ChatCitation[] = [];
  let contentFieldAssist: FieldAssistOutcome | null = null;
  for (const part of parts) {
    if (part.type === "text" && typeof (part as UiMessageTextPart).text === "string") {
      text += (part as UiMessageTextPart).text;
    } else if (part.type === "source-document") {
      const citation = sourceDocumentToCitation(part as UiMessageSourceDocumentPart);
      if (citation) citations.push(citation);
    } else if (part.type === "data-fieldAssist") {
      const parsed = parseFieldAssistOutcome((part as { data?: unknown }).data);
      if (parsed) contentFieldAssist = parsed;
    }
  }
  const content: ChatMessageContent = { text };
  if (citations.length > 0) content.citations = citations;
  else content.generalNotice = true;
  if (contentFieldAssist) content.fieldAssist = contentFieldAssist;
  return content;
}
