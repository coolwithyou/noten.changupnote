import { sql, type SQL } from "drizzle-orm";

/**
 * Drizzle raw SQL에 JS 배열을 직접 interpolate하면 PostgreSQL ARRAY가 아니라
 * `($1, $2, ...)` tuple이 된다. ANY/unnest용 배열은 반드시 ARRAY[...]로 렌더링한다.
 */
export function postgresUuidArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${
    sql.join(values.map((value) => sql`${value}`), sql`, `)
  }]::uuid[]`;
}
