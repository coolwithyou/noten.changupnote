export interface ConfirmationRequestScope {
  endpoint: string;
  generation: number;
}

/** endpoint가 다시 같아지는 ABA도 generation으로 구별한다. 닫힌 시트 응답은 항상 폐기한다. */
export function confirmationResponseIsCurrent(input: {
  request: ConfirmationRequestScope;
  current: ConfirmationRequestScope;
  open: boolean;
}): boolean {
  return input.open
    && input.request.endpoint === input.current.endpoint
    && input.request.generation === input.current.generation;
}

/**
 * cleanup은 generation만 무효화한다. key까지 바꾸면 React StrictMode의 cleanup→setup 뒤
 * 동일 props 재렌더가 정상 두 번째 요청을 또 다른 세대로 오인한다.
 */
export function invalidateConfirmationRequestScope<T extends ConfirmationRequestScope>(input: {
  request: ConfirmationRequestScope;
  current: T;
}): T {
  return input.current.generation === input.request.generation
    ? { ...input.current, generation: input.current.generation + 1 }
    : input.current;
}

export type ConfirmationResultAction = "reload" | "reload_with_notice" | "replace" | "ignore";

/** 저장 회사는 match=null 실패 receipt도 다시 읽어야 하며, 익명 호환만 응답 카드로 치환한다. */
export function confirmationResultAction(input: {
  hasCompany: boolean;
  hasMatch: boolean;
  refreshStatus?: "succeeded" | "not_persisted_user_scope" | "stale" | "failed";
}): ConfirmationResultAction {
  if (input.hasCompany) {
    return input.refreshStatus === "failed" || input.refreshStatus === "stale"
      ? "reload_with_notice"
      : "reload";
  }
  return input.hasMatch ? "replace" : "ignore";
}
