/**
 * 채팅 진입 상황 인사(서버 조립, 결정론적 — 토큰 비용 없음) (Apply Experience v2 · §4.3 · P3-6).
 *
 * workspace 진입 시 ChatPanel 이 첫 assistant 버블로 렌더한다(자동 오픈).
 * 마감일은 공고 구조화 데이터에서 뽑아 인용 뱃지로 표시한다(§4.3 "마감은 …입니다(공고문 인용)").
 * LLM 호출이 아니므로 usage·세션과 무관하다.
 */
import type { ChatMessageContent } from "@/lib/chat/messageContent";

function formatDeadlineKo(applyEnd: string | null): string | null {
  if (!applyEnd) return null;
  const date = new Date(applyEnd);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export function buildChatGreeting(input: {
  title: string;
  applyEnd: string | null;
  dDay: number | null;
}): ChatMessageContent {
  const deadline = formatDeadlineKo(input.applyEnd);
  const parts: string[] = [`'${input.title}' 지원서 작성을 도와드릴게요.`];
  if (deadline) {
    const dday =
      typeof input.dDay === "number" && input.dDay >= 0 ? ` (D-${input.dDay})` : "";
    parts.push(`접수 마감은 ${deadline}입니다${dday}.`);
  }
  parts.push("공고 내용·자격·마감·작성 요령 무엇이든 물어보세요.");
  const content: ChatMessageContent = { text: parts.join(" ") };
  if (deadline) {
    content.citations = [{ citedText: deadline }];
  } else {
    content.generalNotice = true;
  }
  return content;
}
