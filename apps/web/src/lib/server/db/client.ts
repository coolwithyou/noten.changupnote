import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type CunoteDb = PostgresJsDatabase<typeof schema>;
export type CunoteDbSession = Pick<CunoteDb, "delete" | "execute" | "insert" | "select" | "update">;

let cachedDb: CunoteDb | null = null;
let cachedSql: postgres.Sql | null = null;

export function getCunoteDb(): CunoteDb {
  if (!cachedDb) {
    const url = getDatabaseUrl();
    cachedSql = postgres(url, { max: getMaxConnections(), prepare: false });
    cachedDb = drizzle(cachedSql, { schema });
  }
  return cachedDb;
}

export async function closeCunoteDb() {
  if (cachedSql) {
    await cachedSql.end({ timeout: 5 });
    cachedSql = null;
    cachedDb = null;
  }
}

export async function withCunoteDbUser<T>(
  db: CunoteDb,
  userId: string,
  run: (session: CunoteDbSession) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${userId}, true)`);
    return run(tx as unknown as CunoteDbSession);
  });
}

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
  if (!url) {
    throw new Error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
  }
  return url;
}

function getMaxConnections(): number {
  const raw = process.env.CUNOTE_DB_MAX_CONNECTIONS?.trim();
  if (!raw) return 4;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(Math.max(parsed, 1), 8);
}
