import postgres from "postgres";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

const REQUIRED_TABLES = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "app_refresh_tokens",
  "app_devices",
  "notification_settings",
  "companies",
  "user_company",
  "company_profiles",
  "company_enrichment_cache",
  "consents",
  "grants",
  "grant_raw",
  "grant_criteria",
  "source_cursor",
  "dedup_links",
  "match_state",
  "match_events",
  "feedback",
  "extraction_log",
  "golden_set",
  "eval_runs",
] as const;

const RLS_TABLES = [
  "companies",
  "user_company",
  "company_profiles",
  "consents",
  "app_refresh_tokens",
  "app_devices",
  "notification_settings",
  "match_state",
  "match_events",
] as const;

loadMonorepoEnv();

const dryRun = process.argv.includes("--dry-run");
const url = readDatabaseUrl();

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    env: {
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      hasSupabaseDbUrl: Boolean(process.env.SUPABASE_DB_URL),
      hasDirectUrl: Boolean(process.env.DIRECT_URL),
      selected: selectedDatabaseUrlKey(),
    },
    checks: [
      "connectivity",
      "database_identity",
      "drizzle_migration_table",
      "required_tables",
      "rls_flags",
    ],
    requiredTables: REQUIRED_TABLES,
    rlsTables: RLS_TABLES,
  }, null, 2));
} else {
  if (!url) {
    throw new Error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
  }

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const [identity] = await sql<DatabaseIdentity[]>`
      select
        current_database() as database,
        current_user as "currentUser",
        session_user as "sessionUser",
        inet_server_addr()::text as "serverAddress",
        inet_server_port() as "serverPort",
        version() as version
    `;
    const [migrationTable] = await sql<{ tableExists: boolean }[]>`
      select to_regclass('drizzle.__drizzle_migrations') is not null as "tableExists"
    `;
    const migration: MigrationStatus = {
      tableExists: Boolean(migrationTable?.tableExists),
      count: 0,
    };
    if (migration.tableExists) {
      const [migrationCount] = await sql<{ count: number }[]>`
        select count(*)::int as count from drizzle.__drizzle_migrations
      `;
      migration.count = migrationCount?.count ?? 0;
    }
    const tables = await Promise.all(REQUIRED_TABLES.map(async (table) => {
      const [row] = await sql<TableStatus[]>`
        select to_regclass(${`public.${table}`}) is not null as exists
      `;
      return { table, exists: Boolean(row?.exists) };
    }));
    const rls = await Promise.all(RLS_TABLES.map(async (table) => {
      const [row] = await sql<RlsStatus[]>`
        select
          coalesce(relrowsecurity, false) as "rowSecurity",
          coalesce(relforcerowsecurity, false) as "forceRowSecurity"
        from pg_class
        where oid = to_regclass(${`public.${table}`})
      `;
      return {
        table,
        rowSecurity: Boolean(row?.rowSecurity),
        forceRowSecurity: Boolean(row?.forceRowSecurity),
      };
    }));

    const existingTables = new Set(tables.filter((table) => table.exists).map((table) => table.table));
    const missingTables = tables.filter((table) => !table.exists).map((table) => table.table);
    const missingRls = rls
      .filter((table) => existingTables.has(table.table))
      .filter((table) => !table.rowSecurity)
      .map((table) => table.table);
    const result = {
      dryRun: false,
      env: {
        selected: selectedDatabaseUrlKey(),
        target: describeDatabaseUrl(url),
      },
      identity,
      migrations: migration,
      tables,
      rls,
      missingTables,
      missingRls,
      ok: missingTables.length === 0 && missingRls.length === 0,
      nextSteps: nextStepsFor({ missingTables, missingRls, migration }),
    };

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface DatabaseIdentity {
  database: string;
  currentUser: string;
  sessionUser: string;
  serverAddress: string | null;
  serverPort: number | null;
  version: string;
}

interface MigrationStatus {
  tableExists: boolean;
  count: number;
}

interface TableStatus {
  exists: boolean;
}

interface RlsStatus {
  rowSecurity: boolean;
  forceRowSecurity: boolean;
}

function readDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
}

function selectedDatabaseUrlKey(): "DATABASE_URL" | "SUPABASE_DB_URL" | "DIRECT_URL" | null {
  if (process.env.DATABASE_URL) return "DATABASE_URL";
  if (process.env.SUPABASE_DB_URL) return "SUPABASE_DB_URL";
  if (process.env.DIRECT_URL) return "DIRECT_URL";
  return null;
}

function describeDatabaseUrl(value: string) {
  const parsed = new URL(value);
  return {
    protocol: parsed.protocol.replace(":", ""),
    host: parsed.hostname,
    port: parsed.port || null,
    database: parsed.pathname.replace(/^\//, "") || null,
    username: parsed.username || null,
  };
}

function nextStepsFor(input: {
  missingTables: string[];
  missingRls: string[];
  migration: MigrationStatus;
}): string[] {
  if (input.missingTables.length > 0) {
    return [
      "대상 DB가 개발용인지 확인한다.",
      "확인 후 pnpm db:migrate 를 실행한다.",
      "pnpm seed:demo 로 데모 회사/프로필을 생성한다.",
      "pnpm publish:kstartup -- --source=sample 로 샘플 공고를 발행한다.",
      "pnpm publish:bizinfo -- --source=sample 로 기업마당 샘플 공고를 발행한다.",
      "pnpm publish:dedup 으로 중복 링크를 발행한다.",
      "pnpm match:states:refresh -- --write 로 match_state를 갱신한다.",
      "다시 pnpm db:doctor 를 실행한다.",
    ];
  }
  if (!input.migration.tableExists) {
    return [
      "Drizzle migration journal이 없지만 필수 테이블은 존재한다. 대상 DB의 생성 경로를 확인한다.",
    ];
  }
  if (input.missingRls.length > 0) {
    return [
      "RLS가 누락된 테이블이 있다. db/migrations/0003_rls_company_scope.sql 적용 여부를 확인한다.",
      "확인 후 pnpm db:migrate 를 실행한다.",
      "다시 pnpm db:doctor 를 실행한다.",
    ];
  }
  return [];
}
