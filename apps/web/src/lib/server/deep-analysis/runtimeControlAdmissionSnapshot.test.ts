import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CunoteDbSession } from "@/lib/server/db/client";
import {
  DeepAnalysisRuntimeControlError,
  readDeepAnalysisRuntimeAdmissionSnapshot,
} from "./runtimeControl";

const OBSERVED_AT = new Date("2026-08-14T03:04:05.678Z");
const CREATED_AT = new Date("2026-08-01T00:00:00.000Z");
const UPDATED_AT = new Date("2026-08-14T03:00:00.000Z");
const dialect = new PgDialect();
let executeCount = 0;
let renderedSql = "";

const db = {
  execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    executeCount += 1;
    renderedSql = dialect.sqlToQuery(query).sql;
    return [{
      control_key: "global",
      mode: "paused",
      generation: 67,
      changed_by: "ops:test",
      change_reason: "Gate R admission snapshot",
      local_owner_id: null,
      local_lease_expires_at: null,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
      database_observed_at: OBSERVED_AT,
      active_deep_leases: 2,
      active_application_leases: 1,
    }];
  },
} as unknown as CunoteDbSession;

const snapshot = await readDeepAnalysisRuntimeAdmissionSnapshot(db);
assert.deepEqual(snapshot, {
  controlKey: "global",
  mode: "paused",
  generation: 67,
  changedBy: "ops:test",
  changeReason: "Gate R admission snapshot",
  localOwnerId: null,
  localLeaseExpiresAt: null,
  createdAt: CREATED_AT.toISOString(),
  updatedAt: UPDATED_AT.toISOString(),
  databaseObservedAt: OBSERVED_AT.toISOString(),
  activeDeepLeases: 2,
  activeApplicationLeases: 1,
});
assert.equal(executeCount, 1, "runtime과 두 lease 수는 한 statement로 읽어야 한다");
assert.equal(
  renderedSql.match(/statement_timestamp\(\)/gu)?.length,
  1,
  "DB 관측시각은 statement 안에서 한 번만 생성해야 한다",
);
assert.match(
  renderedSql,
  /FROM grant_deep_analysis_jobs\s+WHERE status = 'leased'\s+AND lease_expires_at > observed\.database_observed_at/u,
);
assert.match(
  renderedSql,
  /FROM grant_application_precompute_jobs\s+WHERE status = 'leased'\s+AND lease_expires_at > observed\.database_observed_at/u,
);

await assert.rejects(
  readDeepAnalysisRuntimeAdmissionSnapshot({
    execute: async () => [],
  } as unknown as CunoteDbSession),
  (error: unknown) => error instanceof DeepAnalysisRuntimeControlError
    && error.code === "runtime_control_missing"
    && error.status === 503,
);

console.log("deep-analysis runtime admission snapshot tests: ok");
