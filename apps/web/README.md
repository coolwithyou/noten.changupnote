# cunote web

Next.js app for the first web/admin/app-api surface.

The first implementation slice is core-first:

- `packages/contracts`: shared API and `grant_criteria` contracts.
- `packages/core`: K-Startup normalization and matching logic.
- `db`: Postgres schema draft.

Current first screen:

- `src/app/page.tsx`: internal live match console.
- `src/app/api/matches/live/route.ts`: thin BFF route that calls `packages/core`.

Next route adapters should stay thin and call `packages/core`.
