import postgres from "postgres";

let cachedSql: postgres.Sql | null = null;

export function getAdminSql(): postgres.Sql {
  if (!cachedSql) {
    cachedSql = postgres(getDatabaseUrl(), { max: getMaxConnections(), prepare: false });
  }
  return cachedSql;
}

export async function closeAdminSql() {
  if (!cachedSql) return;
  await cachedSql.end({ timeout: 5 });
  cachedSql = null;
}

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
  if (!url) {
    throw new Error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
  }
  return url;
}

function getMaxConnections(): number {
  const raw = process.env.CUNOTE_ADMIN_DB_MAX_CONNECTIONS?.trim() ?? process.env.CUNOTE_DB_MAX_CONNECTIONS?.trim();
  if (!raw) return 4;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(Math.max(parsed, 1), 8);
}
