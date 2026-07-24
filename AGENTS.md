## Imported Claude Cowork project instructions

창업노트 서비스를 개발할거야

## Development server

- 개발 서버는 사용자가 직접 띄운다.
- Codex는 명시 요청이 없는 한 `pnpm dev:web`, `pnpm dev`, `next dev` 등 장기 실행 개발 서버를 시작하지 않는다.
- 브라우저 검증이 필요하면 먼저 현재 실행 중인 서버와 포트를 확인하고, 서버가 없으면 사용자에게 실행을 요청한다.

## Vercel deployment authentication

- 이 저장소의 Vercel CLI 배포는 저장소 루트의 gitignored `.env.vercel.local`을 인증 정본으로 사용한다.
- `.env.vercel.local`의 `VERCEL_CLI_TOKEN_FULL`을 현재 셸의 `VERCEL_TOKEN`으로 매핑한 뒤 Vercel 명령을 실행한다. 기본 `vercel whoami` 결과나 대화형 로그인 상태만 보고 권한이 없다고 결론내리지 않는다.
- 이 토큰은 `noten-dev` 사용자와 `NOTEN` 팀(팀 slug: `noten`)으로 확인되어야 한다. 명시적인 scope가 필요한 명령에서만 `--scope noten`을 사용한다.
- 토큰 값은 출력·커밋·명령 인자(`--token`)에 직접 넣지 않는다. 셸 환경변수로만 전달한다.
- 배포 전 `.vercel/project.json` 또는 해당 앱의 `.vercel/project.json`을 확인하고, 토큰을 적용한 `vercel whoami`와 `vercel project inspect`로 프로젝트/팀을 검증한다.
- `changupnote` 웹 프로젝트는 모노레포 루트에서 배포한다. Vercel 프로젝트의 Root Directory가 `apps/web`이므로 `apps/web`에서 배포해 `apps/web/apps/web` 경로를 만들지 않는다.
- 프로덕션 배포는 관련 검증과 커밋·push가 끝난 정확한 소스 상태로 수행하고, 배포 URL·프로덕션 alias·라이브 스모크를 확인한다.

## Cloudflare access control memory

- Production hosts `changupnote.com`, `www.changupnote.com`, `dev.changupnote.com`, `ops.changupnote.com`, and `dev.ops.changupnote.com` are intentionally Cloudflare-proxied.
- Cloudflare zone id: `2b6743da9feeba07518367807bf6a7c7`.
- Current WAF custom ruleset id: `7f1e1bddf00a42f2b88da2c0cfa33467`.
- Current allowlist rule id: `350e2f8e8a964261b035b527a2f56c22`.
- Current allowlist expression: `(http.host in {"changupnote.com" "www.changupnote.com" "dev.changupnote.com" "ops.changupnote.com" "dev.ops.changupnote.com"} and not ip.src in {125.184.29.37/32 183.96.140.195/32})`.
- `dev.ops.changupnote.com` DNS CNAME points to the local Cloudflare Tunnel target `be924b5d-a8af-4c43-802c-cb000f391255.cfargotunnel.com`; local ingress is in `/Users/ffgg/.cloudflared/changupnote-dev.yml` and routes to `http://127.0.0.1:4011`.
- Legacy web admin block rule id: `efe33e603ce3475e80d2f0124c6f9f11`.
- Legacy web admin block expression: `(http.host in {"changupnote.com" "www.changupnote.com"} and (starts_with(http.request.uri.path, "/admin") or starts_with(http.request.uri.path, "/internal/live-match") or starts_with(http.request.uri.path, "/api/admin") or http.request.uri.path eq "/api/matches/live"))`.
- Use `.env` `CLOUDFLARE_TOKEN`; never print or commit the token.
- Use `node tools/cloudflare-ip-allowlist.mjs status` before changing access.
- To open the site quickly, run `node tools/cloudflare-ip-allowlist.mjs disable`.
- To restrict again, run `node tools/cloudflare-ip-allowlist.mjs enable` or `node tools/cloudflare-ip-allowlist.mjs restrict <CIDR...>`.
- To add/remove IPs, run `node tools/cloudflare-ip-allowlist.mjs add <CIDR...>` or `node tools/cloudflare-ip-allowlist.mjs remove <CIDR...>`.
- DNS proxy can be restored with `node tools/cloudflare-ip-allowlist.mjs proxy-on`; turning it off bypasses Cloudflare WAF.
