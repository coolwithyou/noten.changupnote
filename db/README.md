# Database

`0001_initial.sql` is the first Postgres schema draft from the design SSOT.

`migrations/` is the Drizzle-owned migration stream generated from
`apps/web/src/lib/server/db/schema.ts`.

Do not apply either migration stream to production until Supabase project, RLS,
and role settings are reviewed. New schema changes should be made in the Drizzle
schema and generated with `pnpm db:generate`.
