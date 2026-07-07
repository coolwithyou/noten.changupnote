// Vercel Cron(및 수동 트리거) 전용 인증. 세션·회사 접근 정책이 아니라 CRON_SECRET Bearer 로 보호한다.
// /api/cron/* 라우트가 공유한다(routePolicy.SYSTEM_CRON_ROUTES 로 분류·검증됨).
//
// 규칙:
//   - CRON_SECRET 미설정 → 503(공개 실행 차단). 프리뷰/미설정 환경에서 누구도 크론을 못 돌리게 한다.
//   - authorization 헤더가 `Bearer ${CRON_SECRET}` 와 다르면 → 401.
import { NextResponse } from "next/server";

export interface CronAuthResult {
  ok: boolean;
  response?: NextResponse;
}

export function authorizeCronRequest(request: Request): CronAuthResult {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: {
            code: "cron_secret_unset",
            message: "CRON_SECRET 이 설정되지 않아 크론 실행을 차단합니다.",
          },
        },
        { status: 503 },
      ),
    };
  }

  const header = request.headers.get("authorization");
  if (header !== `Bearer ${secret}`) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "크론 인증에 실패했습니다.",
          },
        },
        { status: 401 },
      ),
    };
  }

  return { ok: true };
}
