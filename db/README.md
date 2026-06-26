# Database

`0001_initial.sql` is the first Postgres schema draft from the design SSOT.

`migrations/` is the Drizzle-owned migration stream generated from
`apps/web/src/lib/server/db/schema.ts`.

Do not apply either migration stream to production until Supabase project, RLS,
and role settings are reviewed. New schema changes should be made in the Drizzle
schema and generated with `pnpm db:generate`.

## Development bootstrap

Use the doctor first. It is read-only and reports the selected database target,
missing tables, missing RLS flags, and the next safe steps.

```bash
pnpm db:doctor
```

The guarded development bootstrap runs the DB-backed vertical slice setup:

1. `pnpm db:doctor`
2. `pnpm db:migrate`
3. `pnpm seed:demo`
4. `pnpm publish:kstartup -- --source=sample`
5. `pnpm publish:bizinfo -- --source=sample`
6. `pnpm db:doctor`
7. `pnpm smoke:db`

By default it is a dry run and does not write:

```bash
pnpm db:bootstrap:dev
```

Only run the write path after confirming the selected target is a development
database:

```bash
pnpm db:bootstrap:dev -- --confirm-dev-db
# or
CUNOTE_DB_BOOTSTRAP_CONFIRM=dev pnpm db:bootstrap:dev
```

`pnpm smoke:db` assumes the demo user/company and sample K-Startup/BizInfo
grants have already been published.
