/**
 * CODEF 추가인증(2-way, 간편인증) — 순수 타입/전이.
 *
 * 프로토콜: 1차 요청 → CF-03002 응답의 data에서 jobIndex/threadIndex/jti/twoWayTimestamp 보관
 *   → 사용자 앱 승인 후, **1차 파라미터 그대로 + is2Way:true + twoWayInfo{4필드} + simpleAuth:"1"**
 *   로 같은 엔드포인트 재요청. 세션 제한시간 4분30초, 제한시간 내 동일계정 재요청은 차단된다.
 *
 * 세션 상태(CodefTwoWayState)와 전이 가드는 Phase B DB가 상태머신 참조용으로 쓴다.
 */

/** CF-03002 응답 data에서 보관하는 2-way 재요청 정보. */
export interface TwoWayInfo {
  jobIndex: number;
  threadIndex: number;
  jti: string;
  twoWayTimestamp: number;
}

/** 2-way 완료 재요청 시 simpleAuth 승인값. */
export const CODEF_SIMPLE_AUTH_APPROVED = "1";

/** 간편인증 세션 제한시간(ms). 4분 30초. */
export const CODEF_TWO_WAY_TIMEOUT_MS = 270_000;

/**
 * CF-03002 응답 data에서 TwoWayInfo 4필드를 추출한다. 4필드가 모두 유효(형 일치)해야 반환,
 * 하나라도 누락/형 불일치면 null.
 */
export function extractTwoWayInfo(data: unknown): TwoWayInfo | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const jobIndex = rec["jobIndex"];
  const threadIndex = rec["threadIndex"];
  const jti = rec["jti"];
  const twoWayTimestamp = rec["twoWayTimestamp"];
  if (
    typeof jobIndex !== "number" ||
    typeof threadIndex !== "number" ||
    typeof jti !== "string" ||
    typeof twoWayTimestamp !== "number"
  ) {
    return null;
  }
  return { jobIndex, threadIndex, jti, twoWayTimestamp };
}

/**
 * 2-way 완료 재요청 body를 만든다(순수).
 * = 1차 파라미터 그대로 + is2Way:true + twoWayInfo{jobIndex,threadIndex,jti,twoWayTimestamp} + simpleAuth:"1".
 */
export function buildTwoWayRequestBody(
  originalParams: Record<string, unknown>,
  twoWayInfo: TwoWayInfo,
): Record<string, unknown> {
  return {
    ...originalParams,
    is2Way: true,
    twoWayInfo: {
      jobIndex: twoWayInfo.jobIndex,
      threadIndex: twoWayInfo.threadIndex,
      jti: twoWayInfo.jti,
      twoWayTimestamp: twoWayInfo.twoWayTimestamp,
    },
    simpleAuth: CODEF_SIMPLE_AUTH_APPROVED,
  };
}

/** 간편인증 세션 상태(Phase B DB 상태머신). */
export type CodefTwoWayState =
  | "pending_approval" // 1차 요청 완료, 사용자 앱 승인 대기(CF-03002 수신)
  | "completing" // 승인 확인 후 2차 재요청 진행 중
  | "done" // 완료(성공 응답 수신)
  | "failed" // 실패(오류/미승인 한도 초과 등)
  | "expired"; // 제한시간(4분30초) 초과

const TWO_WAY_TRANSITIONS: Record<CodefTwoWayState, readonly CodefTwoWayState[]> = {
  pending_approval: ["completing", "expired", "failed"],
  completing: ["done", "failed", "expired"],
  done: [],
  failed: [],
  expired: [],
};

/** from → to 전이가 허용되는지 판정한다. */
export function canTransitionTwoWay(from: CodefTwoWayState, to: CodefTwoWayState): boolean {
  return TWO_WAY_TRANSITIONS[from].includes(to);
}

/** 허용된 전이면 to를 반환, 아니면 throw(잘못된 상태 전이 방지). */
export function assertTwoWayTransition(
  from: CodefTwoWayState,
  to: CodefTwoWayState,
): CodefTwoWayState {
  if (!canTransitionTwoWay(from, to)) {
    throw new Error(`허용되지 않은 CODEF 2-way 상태 전이: ${from} → ${to}`);
  }
  return to;
}

/**
 * 우리가 기록한 세션 시작 시각(ms) 기준으로 제한시간(4분30초)이 지났는지 판정한다.
 * (twoWayTimestamp의 단위가 문서상 불명확해 벤더 값이 아니라 자체 기록 시각을 기준으로 둔다.)
 */
export function isTwoWaySessionExpired(
  startedAtMs: number,
  nowMs: number = Date.now(),
  timeoutMs: number = CODEF_TWO_WAY_TIMEOUT_MS,
): boolean {
  return nowMs - startedAtMs >= timeoutMs;
}
