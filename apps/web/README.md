# cunote web

Next.js app for the first web/admin/app-api surface.

The implementation slice is core-first:

- `packages/contracts`: shared API and `grant_criteria` contracts.
- `packages/core`: K-Startup normalization and matching logic.
- `db`: Drizzle migrations, RLS policy SQL, and DB smoke tooling.

Current web surface:

- `src/app/page.tsx`: public first screen with stats and business-number teaser input.
- `src/app/dashboard/page.tsx`: protected opportunity map, next question, action queue, company settings, and enrichment controls.
- `src/app/grants/[grantId]/page.tsx`: protected application-prep sheet.
- `src/app/roadmap/page.tsx`: protected roadmap view.
- `src/app/internal/live-match/page.tsx`: internal live match console kept for verification.

Current API surface:

- `src/app/api/web/*`: web BFF routes using session/company access.
- `src/app/api/app/v1/*`: versioned app API with token auth and OpenAPI at `/api/app/v1/openapi.json`.
- `src/app/api/matches/live/route.ts`: internal live verification route.

App client contract:

- `pnpm openapi:export` writes `packages/contracts/generated/app-v1.openapi.json`.
- `pnpm verify:openapi` verifies route coverage, schema expectations, and generated-file sync.
- Flutter codegen should consume the generated JSON or the live `/api/app/v1/openapi.json` endpoint.

Route adapters should stay thin and call `packages/core` use-cases through
`src/lib/server/serviceData.ts`.

Development DB setup is guarded. Run `pnpm db:bootstrap:dev` to inspect the
target and planned write steps. Use `--confirm-dev-db` only after confirming the
selected database is a development database.

## Cloudflare production IP allowlist

`changupnote.com`, `www.changupnote.com`, and `dev.changupnote.com` are
currently proxied through Cloudflare and protected by a zone WAF custom rule.
The rule blocks these hosts unless `ip.src` is in the allowlist.

Current production setting:

- Zone: `changupnote.com` (`2b6743da9feeba07518367807bf6a7c7`)
- WAF phase: `http_request_firewall_custom`
- Ruleset: `changupnote.com IP allowlist`
  (`7f1e1bddf00a42f2b88da2c0cfa33467`)
- Rule: `Block changupnote.com, www, and dev except 125.184.29.37/32, 183.96.140.195/32`
  (`350e2f8e8a964261b035b527a2f56c22`)
- Expression:
  `(http.host in {"changupnote.com" "www.changupnote.com" "dev.changupnote.com"} and not ip.src in {125.184.29.37/32 183.96.140.195/32})`
- DNS records are `proxied=true`:
  - `changupnote.com` A `216.198.79.1`
  - `changupnote.com` A `64.29.17.1`
  - `www.changupnote.com` CNAME `cname.vercel-dns.com`
  - `dev.changupnote.com` CNAME `be924b5d-a8af-4c43-802c-cb000f391255.cfargotunnel.com`

Use the existing `.env` value `CLOUDFLARE_TOKEN`. Do not print the token or
commit any `.env*` file.

Common operations:

```bash
node tools/cloudflare-ip-allowlist.mjs status

# Replace the allowlist.
node tools/cloudflare-ip-allowlist.mjs restrict 125.184.29.37/32 183.96.140.195/32

# Add or remove one IP/CIDR while keeping the rule enabled state.
node tools/cloudflare-ip-allowlist.mjs add 203.0.113.10/32
node tools/cloudflare-ip-allowlist.mjs remove 203.0.113.10/32

# Temporarily open the site without deleting the rule.
node tools/cloudflare-ip-allowlist.mjs disable
node tools/cloudflare-ip-allowlist.mjs enable

# Turn Cloudflare proxying on/off for both hosts.
node tools/cloudflare-ip-allowlist.mjs proxy-on
node tools/cloudflare-ip-allowlist.mjs proxy-off
```

Verification after a change:

```bash
dig +short @1.1.1.1 changupnote.com A
dig +short @1.1.1.1 www.changupnote.com A
dig +short @1.1.1.1 dev.changupnote.com A
curl -I https://changupnote.com
curl -I https://www.changupnote.com
curl -I https://dev.changupnote.com
```

When the WAF rule is enabled, requests from non-allowed IPs should return
Cloudflare `403`. Requests from the allowed IP should return `200` with
`server: cloudflare`.

Cloudflare WAF only protects traffic that reaches Cloudflare. If someone has the
Vercel origin IPs and forces DNS resolution directly to Vercel, the origin can
still answer. For strict origin protection, add a Vercel firewall rule or an app
middleware check that only accepts requests carrying a Cloudflare-injected secret
header.
