# cunote web

Next.js app placeholder for the single web/admin/app-api surface.

The first implementation slice is core-first:

- `packages/contracts`: shared API and `grant_criteria` contracts.
- `packages/core`: K-Startup normalization and matching logic.
- `db`: Postgres schema draft.

Next route adapters should stay thin and call `packages/core`.
