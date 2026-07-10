// 서버 간(내부) 호출 전용 인증. admin(apps/admin)이 웹앱의 /api/internal/credits/* 를 호출할 때
// 사용한다. 세션·회사 접근 정책이 아니라 공유 시크릿 헤더로 보호한다(CRON_SECRET 과 동일 체계 — 설계 9.3
// "admin 결제 실행 경로"). 포트원·원장 실행 로직을 웹앱에 단일 구현으로 두고, admin 은 이 경로로만 호출한다.
//
// 규칙(cronAuth 와 동형):
//   - INTERNAL_API_SECRET 미설정 → 401(공개 실행 차단). 프리뷰/미설정 환경에서 누구도 호출 못 하게 한다.
//     (내부 라우트는 라우트 정책상 공개/세션 어디에도 없으므로 미설정 시 사실상 비활성.)
//   - x-internal-secret 헤더가 INTERNAL_API_SECRET 와 다르면 → 401.
//   - 외부 노출 없음: /api/internal/* 는 verify:route-policy 스코프(api/web, api/app/v1) 밖이라
//     공개/세션 목록에 등재되지 않는다. 웹훅(/api/webhooks/*)과 같은 취급.
import { NextResponse } from "next/server";

const INTERNAL_SECRET_HEADER = "x-internal-secret";

export interface InternalAuthResult {
  ok: boolean;
  response?: NextResponse;
}

export function authorizeInternalRequest(request: Request): InternalAuthResult {
  const secret = process.env.INTERNAL_API_SECRET?.trim();
  if (!secret) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: {
            code: "internal_secret_unset",
            message: "INTERNAL_API_SECRET 이 설정되지 않아 내부 호출을 차단합니다.",
          },
        },
        { status: 401 },
      ),
    };
  }

  const header = request.headers.get(INTERNAL_SECRET_HEADER);
  if (!header || header !== secret) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "내부 호출 인증에 실패했습니다.",
          },
        },
        { status: 401 },
      ),
    };
  }

  return { ok: true };
}
