# ops.changupnote.com 별도 어드민 사이트 구축 계획

## 목표

`ops.changupnote.com`에 창업노트 운영자 전용 admin 사이트를 별도 구축한다. 이 사이트는 `changupnote.com` 사용자 프론트와 세션을 공유하지 않는다.

필수 요구사항:

- admin 사이트 도메인은 `ops.changupnote.com`이다.
- admin 로그인 수단은 Google 로그인과 이메일/패스워드 로그인만 허용한다.
- Google 로그인은 `noten.im` 도메인 계정만 허용한다.
- Kakao, demo, 공개 회원가입, 일반 사용자 OAuth 자동 가입은 admin에서 허용하지 않는다.
- `changupnote.com` 프론트 세션 쿠키와 admin 세션 쿠키는 서로 읽거나 재사용할 수 없어야 한다.
- admin API는 admin 세션만 신뢰해야 하며, 기존 web session으로는 통과하면 안 된다.

## 현재 상태 요약

2026-07-01 현재 admin surface는 `apps/admin` 별도 Next.js 앱으로 이전되어 있다.

- 운영 콘솔: `apps/admin/src/app/page.tsx`
- 로그인 페이지: `apps/admin/src/app/login/page.tsx`
- admin NextAuth route: `apps/admin/src/app/api/auth/[...nextauth]/route.ts`
- admin API: `apps/admin/src/app/api/admin/**/route.ts`
- live match 운영 도구: `apps/admin/src/app/internal/live-match/page.tsx`, `apps/admin/src/app/api/matches/live/route.ts`
- admin 권한 경계: `apps/admin/src/lib/server/auth/adminSession.ts`

`apps/web`에는 admin page/API route를 남기지 않는다. `apps/web/src/proxy.ts`가 사용자 앱에서 `/admin`, `/internal/live-match` 접근은 `ops.changupnote.com`으로 redirect하고, `/api/admin/*`, `/api/matches/live`는 `admin_moved_to_ops` 404로 닫는다.

Vercel에는 신규 프로젝트 `changupnote-ops`가 생성되었고 production deploy는 준비 상태다.

- Project: `team-coolwithyou/changupnote-ops`
- Production deployment: `dpl_fFFPqisUYCwNp4iMpcydbCoTfYt1`
- Default alias: `https://changupnote-ops.vercel.app`
- Smoke: `/`는 `/login`으로 redirect, `/login`은 200, 로그인 전 `/api/admin/status`와 `/api/matches/live`는 401

`ops.changupnote.com` 커스텀 도메인은 Vercel project domain API로 `changupnote-ops`에 연결했고, Cloudflare DNS/TXT 검증 후 verified 상태가 되었다. Cloudflare DNS에는 `ops.changupnote.com -> cname.vercel-dns.com` CNAME을 추가했고 proxy도 켰다. WAF allowlist expression에도 `ops.changupnote.com`을 포함했다.

로컬 admin 검증용 `dev.ops.changupnote.com`은 Cloudflare DNS에서 기존 `changupnote-dev` tunnel target인 `be924b5d-a8af-4c43-802c-cb000f391255.cfargotunnel.com`으로 CNAME을 추가했다. 로컬 cloudflared ingress config `/Users/ffgg/.cloudflared/changupnote-dev.yml`에는 `dev.ops.changupnote.com -> http://127.0.0.1:4011` rule을 추가했고 tunnel process를 재시작했다. HTTP 요청은 tunnel까지 도달하며, admin dev server가 떠 있지 않으면 502를 반환한다. HTTPS는 현재 Cloudflare edge certificate가 `dev.ops.changupnote.com` 같은 2단계 서브도메인을 커버하지 않아 TLS handshake가 실패한다. Cloudflare SSL certificate에 `dev.ops.changupnote.com`을 추가해야 HTTPS local test URL이 완성된다.

기존 `changupnote.com` web 배포는 아직 이전 admin route를 포함하고 있으므로, Cloudflare WAF에서 legacy web admin 경로를 edge 차단한다. Rule id는 `efe33e603ce3475e80d2f0124c6f9f11`이고 `/admin`, `/internal/live-match`, `/api/admin/*`, `/api/matches/live`를 `changupnote.com`/`www.changupnote.com`에서 block한다.

현재 production endpoint:

- `https://ops.changupnote.com`
- Production deployment: `dpl_fFFPqisUYCwNp4iMpcydbCoTfYt1`
- Default alias: `https://changupnote-ops.vercel.app`
- Smoke: `/`는 로그인 전 `/login`으로 redirect, `/login`은 200, 로그인 전 `/api/admin/status`와 `/api/matches/live`는 401
- Credentials smoke: `sw@ba-ton.kr` owner 계정으로 로그인 후 root 운영 콘솔 200 확인. 임시 비밀번호는 macOS Keychain service `cunote-ops-admin`에 저장했다.
- Web legacy admin smoke: `https://changupnote.com/admin`, `/internal/live-match`, `/api/admin/status`, `/api/matches/live`는 Cloudflare 403으로 닫힌다.

## 목표 아키텍처

### 앱 구조

새 워크스페이스 앱을 추가한다.

```text
apps/
  web/      # changupnote.com 사용자 프론트
  admin/    # ops.changupnote.com 운영자 사이트
packages/
  core/
  contracts/
```

`apps/admin`은 Next.js 앱으로 시작한다. 기존 admin 화면과 API 로직은 복사보다 이동/공유를 우선한다.

권장 분리:

- `apps/admin/src/app/page.tsx`: admin dashboard
- `apps/admin/src/app/login/page.tsx`: admin login
- `apps/admin/src/app/api/auth/[...nextauth]/route.ts`: admin 전용 NextAuth
- `apps/admin/src/app/api/admin/**/route.ts`: 운영 API
- `apps/admin/src/lib/server/auth/adminOptions.ts`: admin 전용 NextAuth 설정
- `apps/admin/src/lib/server/auth/adminSession.ts`: admin 세션 조회
- `apps/admin/src/lib/server/auth/adminGuard.ts`: admin API guard
- `apps/admin/src/features/**`: admin 전용 UI

공유 가능한 서버 로직은 `apps/web`에서 직접 import하지 말고 `packages/core` 또는 새 `packages/admin-core`로 승격한다.

1. DB schema/client처럼 web 앱에 묶인 코드는 우선 `apps/admin`에도 동일 구현을 두고 작게 시작한다.
2. 운영 로직 중 순수 함수/리포트 렌더러부터 `packages/core`로 이동한다.
3. UI 컴포넌트는 초기에 admin 앱 내부에 필요한 것만 복제하고, 공통 디자인 시스템이 필요해지면 별도 패키지로 뺀다.

### 배포 구조

Vercel 프로젝트를 분리한다.

- 기존 프로젝트: `changupnote` → `changupnote.com`, `www.changupnote.com`
- 신규 프로젝트: `changupnote-ops` → `ops.changupnote.com`

초기 배포 결과 `changupnote-ops` 프로젝트, 기본 Vercel production alias, 커스텀 도메인 연결까지 완료되었다. 완료된 순서는 다음과 같다.

1. Vercel project domain API로 `ops.changupnote.com`을 `changupnote-ops` project에 연결한다. 완료.
2. Vercel이 요구한 `_vercel.changupnote.com` TXT 검증 레코드를 Cloudflare에 추가한다. 완료.
3. Cloudflare DNS의 `ops` CNAME을 Vercel target으로 추가한다. 완료.
4. Cloudflare proxy/WAF allowlist에 `ops.changupnote.com`을 포함한다. 완료.
5. Cloudflare WAF에서 기존 web admin route를 차단한다. 완료.
6. `dev.ops.changupnote.com` Cloudflare Tunnel DNS와 local ingress를 등록한다. 완료. 단, HTTPS edge certificate는 별도 보강이 필요하다.
7. Google OAuth production callback과 browser login smoke를 완료한다. Google provider 노출과 OAuth redirect 시작은 확인했지만, 2026-07-01 현재 Google OAuth 서버가 `redirect_uri_mismatch`로 즉시 오류 redirect를 반환한다. `https://ops.changupnote.com/api/auth/callback/google`을 Google Cloud Console의 OAuth client Authorized redirect URI에 등록해야 한다.

운영 정책상 기존 WAF allowlist가 `changupnote.com`, `www.changupnote.com`, `dev.changupnote.com`만 대상으로 한다. admin 도메인을 더 강하게 막으려면 같은 allowlist에 `ops.changupnote.com`을 추가하되, Google OAuth callback과 운영자 IP 정책을 같이 확인한다.

## 인증 설계

### admin 전용 NextAuth

`apps/admin`은 web 앱과 다른 NextAuth 설정을 사용한다.

필수 환경값:

```env
ADMIN_AUTH_URL=https://ops.changupnote.com
ADMIN_AUTH_SECRET=<NEXTAUTH_SECRET과 다른 값>
ADMIN_GOOGLE_CLIENT_ID=
ADMIN_GOOGLE_CLIENT_SECRET=
ADMIN_ALLOWED_GOOGLE_DOMAIN=noten.im
ADMIN_ALLOWED_EMAILS=
ADMIN_ALLOWED_USER_IDS=
ADMIN_SESSION_COOKIE_NAME=__Secure-cunote-admin.session-token
ADMIN_CSRF_COOKIE_NAME=__Host-cunote-admin.csrf-token
```

NextAuth v4를 유지한다면 내부적으로 `NEXTAUTH_URL`을 기대하는 코드가 있으므로 Vercel admin 프로젝트 환경에는 다음 중 하나를 선택한다.

- 단순안: admin 프로젝트의 `NEXTAUTH_URL=https://ops.changupnote.com`, `NEXTAUTH_SECRET=<admin secret>`을 설정한다.
- 명시안: `ADMIN_AUTH_*`를 읽어 `authOptions`를 만들고, 빌드/런타임에서 `NEXTAUTH_URL` fallback을 admin 값으로 주입한다.

중요한 점은 web 프로젝트와 admin 프로젝트의 secret을 절대 공유하지 않는 것이다.

### 쿠키 분리

admin NextAuth에는 별도 쿠키 이름을 명시한다.

```ts
cookies: {
  sessionToken: {
    name: "__Secure-cunote-admin.session-token",
    options: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
    },
  },
  csrfToken: {
    name: "__Host-cunote-admin.csrf-token",
    options: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
    },
  },
}
```

`domain` 옵션은 설정하지 않는다. host-only cookie로 두면 `ops.changupnote.com`에서만 유효하고, `changupnote.com` 프론트가 읽지 못한다.

추가로 secret이 다르기 때문에 같은 이름의 쿠키가 실수로 생겨도 JWT 검증을 공유하지 않는다.

### Google 로그인 제한

Google provider는 admin 전용 client id/secret을 사용한다.

Google OAuth 설정:

- Authorized JavaScript origins: `https://ops.changupnote.com`
- Authorized redirect URI: `https://ops.changupnote.com/api/auth/callback/google`

`hd=noten.im`은 로그인 화면 힌트일 뿐이므로 서버에서 반드시 강제한다.

`signIn` callback 정책:

- provider가 `google`이면 email이 있어야 한다.
- email은 정규화 후 `@noten.im`으로 끝나야 한다.
- 가능하면 Google profile의 `email_verified`가 true인지 확인한다.
- 도메인이 맞아도 `ADMIN_ALLOWED_EMAILS` 또는 DB의 admin allowlist에 없으면 거부한다.

권장 정책은 `noten.im` 도메인 + 명시 allowlist 둘 다 요구하는 것이다. 도메인만으로 열면 퇴사자/테스트 계정 관리가 Google Workspace 설정에 전적으로 의존한다.

### 이메일/패스워드 로그인

admin 이메일/패스워드 로그인은 사용자 프론트의 공개 회원가입과 분리한다.

권장 DB 설계:

```text
admin_users
  id
  email unique
  name
  password_hash nullable
  status active|disabled
  role owner|admin|support|viewer
  last_login_at
  created_at
  updated_at

admin_accounts
  provider
  provider_account_id
  admin_user_id
  created_at
```

초기 MVP에서는 NextAuth JWT session을 사용하고 `admin_sessions` 테이블은 만들지 않는다. 세션 강제 만료/기기 관리가 필요해지는 시점에 DB session으로 바꾼다.

이메일/패스워드 로그인 정책:

- admin login 페이지에는 회원가입 탭을 두지 않는다.
- admin 계정 생성은 seed script 또는 CLI로만 한다.
- password hash는 기존 `hashPassword`/`verifyPassword` 유틸을 재사용할 수 있다.
- `status != active`면 로그인 실패 처리한다.
- 비밀번호 재설정은 첫 릴리스에서는 제외하고, 운영자 CLI 재발급으로 시작한다.

## admin API 경계

`apps/admin`의 API는 `requireAdminSession()`만 사용한다.

금지:

- `getOptionalWebSession()` 사용
- `CUNOTE_AUTH_MODE=mock` 기반 우회
- `CUNOTE_ADMIN_MODE=demo` 기반 운영 접근
- web app의 `/api/auth` 세션을 admin 권한으로 인정

기존 `apps/web/src/lib/server/auth/adminGuard.ts`는 최종적으로 web 앱에서 제거하거나, admin 이전 기간 동안 deprecated로 표시한다.

이전 대상:

- `/api/admin/status`
- `/api/admin/status/legal-readiness`
- `/api/admin/status/saas-readiness`
- `/api/admin/status/release-checklist`
- `/api/admin/flywheel`
- `/api/admin/flywheel/review-queue`
- `/api/admin/flywheel/matching-eval`
- `/api/admin/flywheel/support-tickets/*`
- `/api/admin/flywheel/billing-subscriptions/[companyId]`
- `/internal/live-match`와 `/api/matches/live`

`apps/web`에는 사용자가 접근할 필요 없는 admin API를 남기지 않는다. 마이그레이션 중에는 `410 Gone` 또는 `308` redirect보다 `404/403`로 닫는 편이 안전하다.

## 구현 단계

### 1단계: admin 앱 scaffold

- `apps/admin/package.json` 추가
- `apps/admin/next.config.mjs`, `tsconfig.json`, `postcss.config.mjs`, `components.json` 추가
- `pnpm-workspace.yaml`은 이미 `apps/*`를 포함하므로 변경 불필요
- 최소 `/login`, `/`, `/api/auth/[...nextauth]` 라우트 생성
- `apps/admin` 빌드가 web 앱과 독립적으로 통과하는지 확인

검증:

```bash
pnpm --filter @cunote/admin typecheck
pnpm --filter @cunote/admin build
```

### 2단계: admin auth 구현

- `admin_users`, `admin_accounts` migration 추가
- admin seed/CLI 추가: `pnpm admin:user:create`
- Google provider는 admin 전용 env만 읽게 구성
- Credentials provider는 `admin_users`만 조회
- signIn callback에서 `noten.im` + allowlist + active status 검증
- session callback에 `admin.user.id`, `admin.user.role` 부여
- cookie names와 secret을 web과 다르게 설정

검증:

- `noten.im` Google 계정: 로그인 성공
- 비 `noten.im` Google 계정: 로그인 실패
- admin allowlist에 없는 `noten.im` 계정: 로그인 실패
- admin user table에 없는 이메일/패스워드: 로그인 실패
- 비활성 admin user: 로그인 실패
- `changupnote.com` 프론트 로그인 쿠키만 있는 상태에서 `ops` admin API 401/403
- `ops` admin 로그인 쿠키만 있는 상태에서 web 사용자 API는 로그인으로 인정되지 않음

### 3단계: admin 화면/API 이전

- 기존 `/admin` page를 `apps/admin/src/app/page.tsx`로 이전
- `AdminSupportTicketPanel`, live match console 등 admin UI 이전
- admin runtime/flywheel/support/billing/review/matching eval 서버 로직 이전
- web 앱에 묶인 import alias를 admin 앱 alias로 정리
- 공통 서버 로직은 점진적으로 `packages/core`로 이동

검증:

```bash
pnpm verify:admin-routes
pnpm verify:admin-support-report
pnpm verify:admin-support-email-handoff
pnpm verify:admin-review-queue
pnpm verify:admin-matching-eval
```

위 verifier들은 현재 web 경로를 가정하므로, 3단계에서 `apps/admin` 기준도 검사하도록 업데이트해야 한다.

### 4단계: web 앱에서 admin 제거

- `apps/web/src/app/(admin)/admin` 제거 또는 404 처리
- `apps/web/src/app/internal/live-match` 제거 또는 404 처리
- `apps/web/src/app/api/admin` 제거
- `apps/web/src/app/api/matches/live`가 admin 전용이면 admin 앱으로 이동
- web readiness/report에서 admin URL을 `https://ops.changupnote.com` 기준으로 갱신
- 사용자-facing navigation에는 admin 링크를 계속 노출하지 않는다.

검증:

- `GET https://changupnote.com/admin`은 404 또는 명시적 noindex 차단
- `GET https://changupnote.com/api/admin/status`는 404 또는 403
- `GET https://ops.changupnote.com`은 admin 로그인 전 `/login`으로 이동
- `GET https://ops.changupnote.com/api/admin/status`는 admin 로그인 전 401/403, 로그인 후 200

### 5단계: Vercel/Cloudflare 배포

- Vercel 신규 프로젝트 `changupnote-ops` 생성
- Root directory: `apps/admin`
- Build command: `pnpm --dir ../.. build:packages && pnpm build`
- Install command: 기존 monorepo 기본값 사용
- Production domain: `ops.changupnote.com`
- Env는 web 프로젝트와 분리 등록

필수 env:

```env
NEXTAUTH_URL=https://ops.changupnote.com
NEXTAUTH_SECRET=<admin-only secret>
ADMIN_GOOGLE_CLIENT_ID=
ADMIN_GOOGLE_CLIENT_SECRET=
ADMIN_ALLOWED_GOOGLE_DOMAIN=noten.im
ADMIN_ALLOWED_EMAILS=
DATABASE_URL=
CUNOTE_WEB_DATA_SOURCE=drizzle
```

Cloudflare:

- `ops.changupnote.com` CNAME을 Vercel target으로 추가: 완료
- proxy on 여부 결정: on
- WAF allowlist에 `ops.changupnote.com` 포함: 완료
- legacy web admin route WAF block: 완료
- `tools/cloudflare-ip-allowlist.mjs` host set 갱신: 완료

현재 Vercel production env에 등록된 값:

- `ADMIN_AUTH_URL=https://ops.changupnote.com`
- `NEXTAUTH_URL=https://ops.changupnote.com`
- `ADMIN_AUTH_SECRET`
- `NEXTAUTH_SECRET`
- `ADMIN_ALLOWED_GOOGLE_DOMAIN=noten.im`
- `ADMIN_GOOGLE_CLIENT_ID`
- `ADMIN_GOOGLE_CLIENT_SECRET`
- `DATABASE_URL`
- `CUNOTE_WEB_DATA_SOURCE=drizzle`
- K-Startup/Bizinfo/Anthropic/Popbill 운영 env

아직 등록되지 않은 값:

- `ADMIN_ALLOWED_EMAILS`

### 6단계: cutover

1. staging 또는 preview에서 admin login/provider 검증
2. production `ops.changupnote.com` 연결
3. admin 계정 seed
4. 기존 `/admin` 접근 차단
5. 운영자 북마크/문서의 admin URL을 `ops.changupnote.com`으로 갱신
6. web smoke와 ops smoke를 분리해 CI에 추가

## 테스트/검증 게이트

정적 검증:

- `pnpm typecheck`
- `pnpm --filter @cunote/admin typecheck`
- `pnpm --filter @cunote/admin build`
- admin route verifier를 `apps/admin` 기준으로 업데이트 후 실행
- route policy verifier에서 web/admin 경계 분리 확인
- `pnpm verify:ops-admin-live`로 production ops/web 경계와 Google OAuth redirect URI 확인

HTTP smoke:

- web:
  - `/admin`이 사용자 앱에서 열리지 않는지 확인
  - `/api/admin/status`가 사용자 앱에서 열리지 않는지 확인
  - 기존 사용자 로그인/회원가입/대시보드가 영향 없는지 확인
- ops:
  - 로그인 전 `/` → `/login`
  - 로그인 전 `/api/admin/status` → 401/403
  - Google `noten.im` 로그인 성공
  - Google non-`noten.im` 로그인 실패
  - email/password admin 로그인 성공
  - web session cookie만 주입했을 때 ops 인증 실패
  - ops session cookie만 주입했을 때 web 인증 실패

브라우저 QA:

- desktop/mobile `/login`
- desktop `/` 운영 콘솔
- support ticket panel read/update
- Markdown download links
- live match 내부 검증 도구

## 리스크와 결정 필요 사항

### admin 계정 저장소

권장: `admin_users` 별도 테이블.

대안: 기존 `users` 테이블 + `ADMIN_ALLOWED_EMAILS`.

기존 `users` 재사용은 빠르지만 사용자 가입 계정과 운영자 계정이 같은 identity store에 섞인다. 별도 사이트/별도 세션이라는 목표에는 `admin_users`가 더 맞다.

### Google 도메인 제한

`hd=noten.im`만으로는 부족하다. 반드시 server callback에서 email domain과 allowlist를 검사해야 한다.

### 세션 분리

쿠키 이름만 다르게 하는 것으로 충분하지 않다. 다음 3개를 모두 분리한다.

- host-only cookie
- 별도 cookie name
- 별도 auth secret

### WAF 정책

admin 도메인을 Cloudflare allowlist에 포함하면 보안은 강해지지만, 운영자 IP 변경 때 접근 장애가 생긴다. 초기에는 `noten.im Google + allowlist + strong password`로 열고, 운영 안정화 후 WAF IP 제한을 추가하는 선택지도 있다.

## 완료 기준

이 작업은 다음 상태가 모두 확인되어야 완료다.

- `https://ops.changupnote.com`이 별도 Vercel project 또는 별도 deploy target으로 운영된다.
- admin 로그인 화면에는 Google과 이메일/패스워드만 있다.
- Google 로그인은 `noten.im` 도메인과 admin allowlist를 모두 통과해야 한다.
- admin 이메일/패스워드 로그인은 public user table이 아니라 admin 계정 정책을 따른다.
- `changupnote.com`의 NextAuth 세션으로 `ops.changupnote.com` admin API를 사용할 수 없다.
- `ops.changupnote.com`의 admin 세션으로 `changupnote.com` 사용자 API를 사용할 수 없다.
- 기존 `changupnote.com/admin`과 `changupnote.com/api/admin/*`는 제거되었거나 닫혀 있다.
- CI/verification에 web/admin 경계 검증이 포함되어 있다.

## 구현 진행 상태

2026-07-01 현재 반영됨:

- `apps/admin` 별도 Next.js 앱을 추가했다.
- `@cunote/admin` package script로 `dev`, `build`, `typecheck`, `admin:user:create`를 추가했다.
- admin 전용 NextAuth route `/api/auth/[...nextauth]`를 추가했다.
- admin 전용 login page `/login`과 root 운영 콘솔 shell `/`을 추가했다.
- admin 전용 status API `/api/admin/status`를 추가했다.
- admin 전용 proxy를 추가해 `/login`, `/api/auth/*` 외 route/API는 admin JWT cookie 없이는 접근하지 못하게 했다.
- admin 전용 flywheel API `/api/admin/flywheel`을 추가해 운영 테이블 카운트를 `apps/admin` DB client로 직접 읽는다.
- root 운영 콘솔 `/`에서 flywheel 운영 지표 카운트를 표시한다.
- support ticket 상태/우선순위/SLA/담당자 update API를 `apps/admin`에 추가했다.
- support ticket 공개 답변/내부 메모 message API를 `apps/admin`에 추가했다.
- support ticket 최신 공개 답변 `.eml` email handoff download API를 `apps/admin`에 추가했다.
- billing subscription 수동 update API를 `apps/admin`에 추가했다. admin user id는 web `users` FK에 쓰지 않고 metadata audit에 남긴다.
- legal readiness, SaaS readiness, release checklist Markdown download endpoint를 `apps/admin`에 추가했다.
- review queue 조회와 golden set 승격 API를 `apps/admin`에 추가했다.
- matching eval 조회/쓰기 API를 `apps/admin`에 추가했다.
- support ticket 운영 큐 Markdown report API `/api/admin/flywheel/support-tickets/report`를 `apps/admin`에 추가했다.
- 실사업자 live match 검증 페이지 `/internal/live-match`와 API `/api/matches/live`를 `apps/admin`에 추가했다.
- `apps/web/src/proxy.ts`를 추가해 `changupnote.com/admin`, `/internal/live-match`는 `ops.changupnote.com`으로 보내고, `/api/admin/*`, `/api/matches/live`는 web 도메인에서 404로 닫았다.
- 기존 `apps/web`의 admin page/API route 파일, live-match route 파일, dead admin/live-match feature code, landing의 내부 검증 콘솔 링크를 제거했다.
- `pnpm verify:admin-routes`를 `apps/admin` 보호 경계와 web admin route 제거를 검사하도록 갱신했다.
- Google provider는 `ADMIN_GOOGLE_CLIENT_ID`, `ADMIN_GOOGLE_CLIENT_SECRET`만 사용한다.
- Google login은 server-side callback에서 `ADMIN_ALLOWED_GOOGLE_DOMAIN`, 기본 `noten.im`, email verified, admin 계정 존재 여부를 검사한다.
- email/password login은 `admin_users.password_hash`만 사용하며 공개 회원가입 흐름과 연결하지 않는다.
- admin 세션은 `__Secure-cunote-admin.session-token` 계열 cookie name과 admin auth secret을 사용하도록 분리했다.
- `admin_users`, `admin_accounts`, `admin_role`, `admin_status` migration을 추가했다.
- `pnpm verify:ops-admin`을 추가해 Kakao/demo/web session fallback이 admin 앱에 들어오지 않았는지 정적으로 검사한다.
- `pnpm verify:ops-admin-live`를 추가해 production `ops.changupnote.com`의 로그인 전 경계, Google OAuth redirect URI, Google OAuth 즉시 오류 여부, host-only admin CSRF cookie, web NextAuth cookie 거부, legacy web admin 차단을 확인한다.
- `pnpm verify:ops-admin`을 강화해 Google email verification, active `admin_users` allowlist, host-only admin cookie, admin auth secret 우선순위, public `users` table 미사용을 정적으로 검사한다.
- `pnpm typecheck`, `pnpm --filter @cunote/admin build`, `pnpm --filter @cunote/web build`, `pnpm verify:db-migrations`, `pnpm verify:ops-admin`, `pnpm verify:admin-routes`, `pnpm test`, `git diff --check`가 통과했다.
- Vercel `changupnote-ops` production deployment가 Ready 상태로 올라갔다.
- `https://changupnote-ops.vercel.app` 기준 unauthenticated smoke가 통과했다.
- `https://ops.changupnote.com`이 production alias로 연결되었다.
- Cloudflare `ops.changupnote.com` CNAME, proxy, WAF allowlist 적용을 완료했다.
- Cloudflare `dev.ops.changupnote.com` CNAME과 local cloudflared ingress를 추가했다. HTTP는 tunnel까지 도달하며 admin dev server 미실행 시 502를 반환한다. HTTPS는 Cloudflare edge certificate 보강 전까지 TLS handshake가 실패한다.
- Cloudflare legacy web admin block rule을 추가해 기존 production web의 admin route를 edge에서 닫았다.
- production DB에 `admin_users`, `admin_accounts` migration을 적용했다.
- 초기 owner 계정 `sw@ba-ton.kr`을 생성했고, 임시 비밀번호를 macOS Keychain service `cunote-ops-admin`에 저장했다.
- `https://ops.changupnote.com` 기준 credentials login smoke가 통과했다.
- `pnpm verify:ops-admin-live`는 production에 대해 Google OAuth `redirect_uri_mismatch`를 감지하므로 현재 실패한다. Google Cloud Console callback 등록 후 다시 통과해야 한다.

남은 작업:

- Google Cloud Console에서 admin OAuth client에 `https://ops.changupnote.com/api/auth/callback/google` callback을 등록한다. 현재 `redirect_uri_mismatch`가 재현된다.
  - Project: `sofa-482810`
  - OAuth client id: `867976066774-v33ealvi5p2ekdop52i7moemmnbeidc4.apps.googleusercontent.com`
  - Google Console: `https://console.cloud.google.com/apis/credentials/oauthclient/867976066774-v33ealvi5p2ekdop52i7moemmnbeidc4.apps.googleusercontent.com?project=sofa-482810`
  - Authorized JavaScript origin: `https://ops.changupnote.com`
  - Authorized redirect URI: `https://ops.changupnote.com/api/auth/callback/google`
- 실제 `noten.im` Google 계정으로 browser callback smoke를 수행한다.
- 필요하면 `ADMIN_ALLOWED_EMAILS`를 production env에 등록해 DB admin user 외에 명시 이메일 allowlist도 강제한다.
