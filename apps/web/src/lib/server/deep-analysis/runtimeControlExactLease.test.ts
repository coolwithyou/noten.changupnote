import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CunoteDb } from "@/lib/server/db/client";
import {
  acquireLocalSubscriptionLease,
  DeepAnalysisRuntimeControlError,
  recoverExpiredLocalSubscriptionLease,
  releaseLocalSubscriptionLease,
  renewLocalSubscriptionLease,
} from "./runtimeControl";

const OWNER = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_OWNER = "223e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-08-14T00:00:00.000Z");

{
  const expiredAt = NOW;
  const recoverable = createRuntimeControlDb({
    mode: "local_subscription",
    generation: 68,
    localOwnerId: OWNER,
    localLeaseExpiresAt: expiredAt,
  });
  const recovered = await recoverExpiredLocalSubscriptionLease({
    db: recoverable.db,
    ownerId: OWNER,
    expectedGeneration: 68,
    expectedLeaseExpiresAt: expiredAt,
    changeReason: "deep-v18 exact-next terminal receipt recovery",
    now: NOW,
  });
  assert.equal(recovered.mode, "paused");
  assert.equal(recovered.generation, 69);
  assert.equal(recovered.changedBy, "lab:experiment:recover");
  assert.equal(recovered.changeReason, "deep-v18 exact-next terminal receipt recovery");
  assert.equal(recovered.localOwnerId, null);
  assert.equal(recovered.localLeaseExpiresAt, null);
}

{
  const expiredAt = new Date("2026-08-13T23:59:59.000Z");
  const cases: Array<{
    label: string;
    row: Partial<RuntimeRow>;
    ownerId?: string;
    expectedGeneration?: number;
    expectedLeaseExpiresAt?: Date;
  }> = [
    {
      label: "아직 유효한 lease",
      row: {
        mode: "local_subscription",
        generation: 68,
        localOwnerId: OWNER,
        localLeaseExpiresAt: new Date("2026-08-14T00:00:01.000Z"),
      },
      expectedLeaseExpiresAt: new Date("2026-08-14T00:00:01.000Z"),
    },
    {
      label: "owner 불일치",
      row: {
        mode: "local_subscription",
        generation: 68,
        localOwnerId: OTHER_OWNER,
        localLeaseExpiresAt: expiredAt,
      },
    },
    {
      label: "generation 불일치",
      row: {
        mode: "local_subscription",
        generation: 69,
        localOwnerId: OWNER,
        localLeaseExpiresAt: expiredAt,
      },
    },
    {
      label: "expiry 불일치",
      row: {
        mode: "local_subscription",
        generation: 68,
        localOwnerId: OWNER,
        localLeaseExpiresAt: new Date("2026-08-13T23:59:58.000Z"),
      },
    },
    {
      label: "production API 모드",
      row: {
        mode: "production_api",
        generation: 68,
        localOwnerId: null,
        localLeaseExpiresAt: null,
      },
    },
  ];

  for (const testCase of cases) {
    const blocked = createRuntimeControlDb(testCase.row);
    const before = blocked.current();
    await assert.rejects(
      recoverExpiredLocalSubscriptionLease({
        db: blocked.db,
        ownerId: testCase.ownerId ?? OWNER,
        expectedGeneration: testCase.expectedGeneration ?? 68,
        expectedLeaseExpiresAt: testCase.expectedLeaseExpiresAt ?? expiredAt,
        changeReason: `blocked:${testCase.label}`,
        now: NOW,
      }),
      (error: unknown) => error instanceof DeepAnalysisRuntimeControlError
        && error.code === "runtime_control_conflict",
      testCase.label,
    );
    assert.equal(blocked.current(), before, `${testCase.label}: mutation이 없어야 한다`);
  }
}

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
  if (sql.includes('"local_lease_expires_at" =')
    && !matchesEquality(sql, params, "local_lease_expires_at", row.localLeaseExpiresAt)) {
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
  const expiredMatch = sql.match(/"local_lease_expires_at" <= \$([0-9]+)/);
  if (expiredMatch) {
    const rawThreshold = params[Number(expiredMatch[1]) - 1];
    const threshold = typeof rawThreshold === "string"
      ? new Date(rawThreshold)
      : rawThreshold instanceof Date
        ? rawThreshold
        : null;
    if (threshold === null
      || row.localLeaseExpiresAt === null
      || row.localLeaseExpiresAt > threshold) {
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
  if (match === null) return false;
  const expected = params[Number(match[1]) - 1];
  return expected === (actual instanceof Date ? actual.toISOString() : actual);
}
