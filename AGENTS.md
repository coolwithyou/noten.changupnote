## Imported Claude Cowork project instructions

창업노트 서비스를 개발할거야

## Development server

- 개발 서버는 사용자가 직접 띄운다.
- Codex는 명시 요청이 없는 한 `pnpm dev:web`, `pnpm dev`, `next dev` 등 장기 실행 개발 서버를 시작하지 않는다.
- 브라우저 검증이 필요하면 먼저 현재 실행 중인 서버와 포트를 확인하고, 서버가 없으면 사용자에게 실행을 요청한다.

## Cloudflare access control memory

- Production hosts `changupnote.com`, `www.changupnote.com`, and `dev.changupnote.com` are intentionally Cloudflare-proxied.
- Cloudflare zone id: `2b6743da9feeba07518367807bf6a7c7`.
- Current WAF custom ruleset id: `7f1e1bddf00a42f2b88da2c0cfa33467`.
- Current allowlist rule id: `350e2f8e8a964261b035b527a2f56c22`.
- Current allowlist expression: `(http.host in {"changupnote.com" "www.changupnote.com" "dev.changupnote.com"} and not ip.src in {125.184.29.37/32 183.96.140.195/32})`.
- Use `.env` `CLOUDFLARE_TOKEN`; never print or commit the token.
- Use `node tools/cloudflare-ip-allowlist.mjs status` before changing access.
- To open the site quickly, run `node tools/cloudflare-ip-allowlist.mjs disable`.
- To restrict again, run `node tools/cloudflare-ip-allowlist.mjs enable` or `node tools/cloudflare-ip-allowlist.mjs restrict <CIDR...>`.
- To add/remove IPs, run `node tools/cloudflare-ip-allowlist.mjs add <CIDR...>` or `node tools/cloudflare-ip-allowlist.mjs remove <CIDR...>`.
- DNS proxy can be restored with `node tools/cloudflare-ip-allowlist.mjs proxy-on`; turning it off bypasses Cloudflare WAF.
