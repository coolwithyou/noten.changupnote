/**
 * 가입 보너스 지급 훅 — 공통 진입점 (설계 6.6).
 *
 * lazy grant: 지갑 없으면 생성 + signup_bonus_grant 분개(key=signup:{userId}, 멱등·경쟁 안전).
 * 이미 지급됐으면 no-op. 세 배선 지점에서 호출한다:
 *   (1) 이메일 인증 완료 / 로그인 성공 핸들러 — apps/web/.../auth/options.ts 의 events.signIn
 *       (현재 코드베이스에 별도 이메일 인증 플로우가 없어, 로그인 성공(비밀번호·OAuth 공통)을
 *        "인증 완료" 지점으로 삼는다. 크레덴셜 로그인은 유효 비밀번호 검증을 통과한 상태다.)
 *   (2) OAuth 최초 로그인 — resolveSessionUserId 의 신규 유저 생성 직후
 *   (3) 크레딧 잔액 첫 조회(안전망) — 잔액 API/위젯이 조회 전에 호출 (P2 에서 배선)
 *
 * ★ 인증 흐름을 절대 막지 않는다. 실패는 삼키고 로그만 남긴다(잔액 첫 조회 안전망이 복구).
 */

import { getServiceRepositories } from "@/lib/server/serviceData";

export async function ensureWalletWithSignupBonus(userId: string | undefined | null): Promise<void> {
  if (!userId || typeof userId !== "string") return;
  try {
    await getServiceRepositories().credits.ensureWalletWithSignupBonus(userId);
  } catch (error) {
    // 지갑/원장 스키마 미적용 환경이나 일시 오류에서도 인증을 막지 않는다.
    // 안전망(잔액 첫 조회 시 재호출)이 뒤늦게 지급을 보정한다.
    console.warn(
      `ensureWalletWithSignupBonus skipped for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
