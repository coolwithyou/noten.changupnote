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

Route adapters should stay thin and call `packages/core` use-cases through
`src/lib/server/serviceData.ts`.

Development DB setup is guarded. Run `pnpm db:bootstrap:dev` to inspect the
target and planned write steps. Use `--confirm-dev-db` only after confirming the
selected database is a development database.
