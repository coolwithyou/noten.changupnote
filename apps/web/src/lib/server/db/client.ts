import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type CunoteDb = PostgresJsDatabase<typeof schema>;

let cachedDb: CunoteDb | null = null;
let cachedSql: postgres.Sql | null = null;

export function getCunoteDb(): CunoteDb {
  if (!cachedDb) {
    const url = getDatabaseUrl();
    cachedSql = postgres(url, { max: 1, prepare: false });
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

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
  if (!url) {
    throw new Error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
  }
  return url;
}
