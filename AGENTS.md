## Imported Claude Cowork project instructions

창업노트 서비스를 개발할거야

## Cloudflare access control memory

- Production hosts `changupnote.com` and `www.changupnote.com` are intentionally Cloudflare-proxied.
- Cloudflare zone id: `2b6743da9feeba07518367807bf6a7c7`.
- Current WAF custom ruleset id: `7f1e1bddf00a42f2b88da2c0cfa33467`.
- Current allowlist rule id: `350e2f8e8a964261b035b527a2f56c22`.
- Current allowlist expression: `(http.host in {"changupnote.com" "www.changupnote.com"} and not ip.src in {125.184.29.37/32})`.
- Use `.env` `CLOUDFLARE_TOKEN`; never print or commit the token.
- Use `node tools/cloudflare-ip-allowlist.mjs status` before changing access.
- To open the site quickly, run `node tools/cloudflare-ip-allowlist.mjs disable`.
- To restrict again, run `node tools/cloudflare-ip-allowlist.mjs enable` or `node tools/cloudflare-ip-allowlist.mjs restrict <CIDR...>`.
- To add/remove IPs, run `node tools/cloudflare-ip-allowlist.mjs add <CIDR...>` or `node tools/cloudflare-ip-allowlist.mjs remove <CIDR...>`.
- DNS proxy can be restored with `node tools/cloudflare-ip-allowlist.mjs proxy-on`; turning it off bypasses Cloudflare WAF.
