import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CunoteDb } from "@/lib/server/db/client";
import {
  acquireLocalSubscriptionLease,
  DeepAnalysisRuntimeControlError,
  releaseLocalSubscriptionLease,
  renewLocalSubscriptionLease,
} from "./runtimeControl";

const OWNER = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-08-14T00:00:00.000Z");

{
  const stale = createRuntimeControlDb({ generation: 68 });
  await assert.rejects(
    acquireLocalSubscriptionLease({
      db: stale.db,
      ownerId: OWNER,
      changedBy: "lab:experiment",
      expectedGeneration: 67,
      now: NOW,
    }),
    (error: unknown) => error instanceof DeepAnalysisRuntimeControlError
      && error.code === "runtime_control_conflict",
  );
  assert.equal(stale.current().generation, 68);
  assert.equal(stale.current().mode, "paused");

  const exact = createRuntimeControlDb({ generation: 67 });
  const acquired = await acquireLocalSubscriptionLease({
    db: exact.db,
    ownerId: OWNER,
    changedBy: "lab:experiment",
    expectedGeneration: 67,
    now: NOW,
  });
  assert.equal(acquired.generation, 68);
  assert.equal(acquired.mode, "local_subscription");
  assert.equal(acquired.localOwnerId, OWNER);
}

{
  const activeRow: Partial<RuntimeRow> = {
    mode: "local_subscription",
    generation: 68,
    localOwnerId: OWNER,
    localLeaseExpiresAt: new Date("2026-08-14T00:01:00.000Z"),
  };
  const stale = createRuntimeControlDb(activeRow);
  await assert.rejects(
    releaseLocalSubscriptionLease({
      db: stale.db,
      ownerId: OWNER,
      changedBy: "lab:experiment",
      generation: 67,
      now: NOW,
    }),
    (error: unknown) => error instanceof DeepAnalysisRuntimeControlError
      && error.code === "runtime_control_conflict",
  );
  assert.equal(stale.current().generation, 68);
  assert.equal(stale.current().mode, "local_subscription");

  const exact = createRuntimeControlDb(activeRow);
  const released = await releaseLocalSubscriptionLease({
    db: exact.db,
    ownerId: OWNER,
    changedBy: "lab:experiment",
    generation: 68,
    now: NOW,
  });
  assert.equal(released.generation, 69);
  assert.equal(released.mode, "paused");
  assert.equal(released.localOwnerId, null);
  assert.equal(released.localLeaseExpiresAt, null);
}

{
  const originalExpiry = new Date("2026-08-14T00:01:00.000Z");
  const stale = createRuntimeControlDb({
    mode: "local_subscription",
    generation: 68,
    localOwnerId: OWNER,
    localLeaseExpiresAt: originalExpiry,
  });
  await assert.rejects(
    renewLocalSubscriptionLease({
      db: stale.db,
      ownerId: OWNER,
      generation: 67,
      now: NOW,
    }),
    (error: unknown) => error instanceof DeepAnalysisRuntimeControlError
      && error.code === "runtime_control_conflict",
  );
  assert.equal(stale.current().localLeaseExpiresAt, originalExpiry);

  const exact = createRuntimeControlDb({
    mode: "local_subscription",
    generation: 68,
    localOwnerId: OWNER,
    localLeaseExpiresAt: originalExpiry,
  });
  const renewed = await renewLocalSubscriptionLease({
    db: exact.db,
    ownerId: OWNER,
    generation: 68,
    now: NOW,
  });
  assert.equal(renewed.generation, 68);
  assert.equal(renewed.localLeaseExpiresAt, "2026-08-14T00:02:00.000Z");

  const expired = createRuntimeControlDb({
    mode: "local_subscription",
    generation: 68,
    localOwnerId: OWNER,
    localLeaseExpiresAt: new Date("2026-08-13T23:59:59.000Z"),
  });
  await assert.rejects(
    renewLocalSubscriptionLease({
      db: expired.db,
      ownerId: OWNER,
      generation: 68,
      now: NOW,
    }),
    (error: unknown) => error instanceof DeepAnalysisRuntimeControlError
      && error.code === "runtime_control_conflict",
  );
}

console.log("deep-analysis exact lease tests: ok");

type RuntimeRow = {
  controlKey: string;
  mode: string;
  generation: number;
  changedBy: string;
  changeReason: string | null;
  localOwnerId: string | null;
  localLeaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createRuntimeControlDb(overrides: Partial<RuntimeRow> = {}) {
  let row: RuntimeRow = {
    controlKey: "global",
    mode: "paused",
    generation: 67,
    changedBy: "test",
    changeReason: null,
    localOwnerId: null,
    localLeaseExpiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  const dialect = new PgDialect();
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => ({
          returning: async () => {
            const query = dialect.sqlToQuery(condition);
            if (!matchesExactPredicates(query.sql, query.params, row)) return [];
            row = {
              ...row,
              ...values,
              generation: values.generation === undefined ? row.generation : row.generation + 1,
            } as RuntimeRow;
            return [row];
          },
        }),
      }),
    }),
  } as unknown as CunoteDb;
  return { db, current: () => row };
}

function matchesExactPredicates(sql: string, params: unknown[], row: RuntimeRow): boolean {
  if (!(matchesEquality(sql, params, "control_key", row.controlKey)
    && matchesEquality(sql, params, "mode", row.mode)
    && matchesEquality(sql, params, "generation", row.generation))) {
    return false;
  }
  if (sql.includes('"local_owner_id" =')
    && !matchesEquality(sql, params, "local_owner_id", row.localOwnerId)) {
    return false;
  }
  const expiryMatch = sql.match(/"local_lease_expires_at" > \$([0-9]+)/);
  if (expiryMatch) {
    const rawThreshold = params[Number(expiryMatch[1]) - 1];
    const threshold = rawThreshold instanceof Date
      ? rawThreshold
      : typeof rawThreshold === "string"
        ? new Date(rawThreshold)
        : null;
    if (threshold === null
      || row.localLeaseExpiresAt === null
      || row.localLeaseExpiresAt <= threshold) {
      return false;
    }
  }
  return true;
}

function matchesEquality(
  sql: string,
  params: unknown[],
  column: string,
  actual: unknown,
): boolean {
  const match = sql.match(new RegExp(`"${column}" = \\$([0-9]+)`));
  return match !== null && params[Number(match[1]) - 1] === actual;
}
