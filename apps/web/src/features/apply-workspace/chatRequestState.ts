export const GRANT_CHAT_TIMEOUT_MS = 25_000;

export type GrantChatFailure = "timeout" | "request";

export function isGrantChatBusyStatus(status: string): boolean {
  return status === "submitted" || status === "streaming";
}

export function grantChatFailureMessage(failure: GrantChatFailure): string {
  return failure === "timeout"
    ? "답변이 오래 걸려 요청을 중단했어요. 같은 질문으로 다시 요청할 수 있어요."
    : "답변을 받지 못했어요. 같은 질문으로 다시 요청할 수 있어요.";
}
