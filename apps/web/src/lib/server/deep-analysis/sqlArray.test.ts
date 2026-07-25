import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { postgresUuidArray } from "./sqlArray";

const dialect = new PgDialect();
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const rendered = dialect.sqlToQuery(sql`
  SELECT unnest(${postgresUuidArray(ids)})
`);
assert.match(rendered.sql, /unnest\(ARRAY\[\$1, \$2\]::uuid\[\]\)/);
assert.doesNotMatch(rendered.sql, /\(\$1, \$2\)::uuid\[\]/);
assert.deepEqual(rendered.params, ids);

const empty = dialect.sqlToQuery(sql`
  SELECT unnest(${postgresUuidArray([])})
`);
assert.match(empty.sql, /unnest\(ARRAY\[\]::uuid\[\]\)/);
assert.deepEqual(empty.params, []);

console.log("deep-analysis PostgreSQL array SQL tests passed");
