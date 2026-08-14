import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CunoteDb } from "@/lib/server/db/client";
import { createDeepRepairLiveDbLeaseClient } from "./deep-repair-live-db-runtime";

const OWNER = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-08-14T00:00:00.000Z");
const queries: Array<{ sql: string; params: unknown[] }> = [];
const rows = [
  runtimeRow({ mode: "local_subscription", generation: 68, localOwnerId: OWNER }),
  runtimeRow({ mode: "local_subscription", generation: 68, localOwnerId: OWNER }),
  runtimeRow({ mode: "paused", generation: 69 }),
];
const dialect = new PgDialect();
const db = {
  update: () => ({
    set: () => ({
      where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => ({
        returning: async () => {
          queries.push(dialect.sqlToQuery(condition));
          return [rows[queries.length - 1]];
        },
      }),
    }),
  }),
} as unknown as CunoteDb;

const client = createDeepRepairLiveDbLeaseClient({ getDb: () => db });
const acquired = await client.acquire({ ownerId: OWNER, expectedGeneration: 67 });
assert.equal(acquired.generation, 68);

const renewed = await client.renew({ ownerId: OWNER, generation: 68 });
assert.equal(renewed.generation, 68);

await client.release({ ownerId: OWNER, generation: 68 });

assertExactBinding(queries[0]!, ["global", "paused", 67]);
assertExactBinding(queries[1]!, ["global", "local_subscription", OWNER, 68]);
assert.match(queries[1]!.sql, /"local_lease_expires_at" > /);
assertExactBinding(queries[2]!, ["global", "local_subscription", OWNER, 68]);

console.log("deep-repair live DB runtime tests passed");

function assertExactBinding(
  query: { sql: string; params: unknown[] },
  expectedParams: unknown[],
): void {
  for (const expected of expectedParams) {
    assert.equal(
      query.params.some((param) => param === expected),
      true,
      `expected SQL binding ${String(expected)} in ${JSON.stringify(query.params)}`,
    );
  }
}

function runtimeRow(input: {
  mode: "paused" | "local_subscription";
  generation: number;
  localOwnerId?: string;
}) {
  return {
    controlKey: "global",
    mode: input.mode,
    generation: input.generation,
    changedBy: "lab:experiment",
    changeReason: "딥분석 실험 exact authority lease",
    localOwnerId: input.localOwnerId ?? null,
    localLeaseExpiresAt: input.mode === "local_subscription"
      ? new Date(NOW.getTime() + 120_000)
      : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
