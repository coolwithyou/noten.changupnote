import { getAdminSql } from "@/lib/server/db/client";

export async function getCreditSetting(key: string): Promise<unknown> {
  const sql = getAdminSql();
  const rows = await sql<{ value: unknown }[]>`
    SELECT value FROM credit_settings WHERE key = ${key} LIMIT 1
  `;
  if (!rows[0]) return null;
  const v = rows[0].value as Record<string, unknown>;
  return v?.value ?? v;
}

export async function getNumericSetting(key: string, fallback: number): Promise<number> {
  const val = await getCreditSetting(key);
  if (typeof val === "number") return val;
  return fallback;
}
