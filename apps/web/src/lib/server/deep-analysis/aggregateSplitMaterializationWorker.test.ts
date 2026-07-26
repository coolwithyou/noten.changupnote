import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import type { CunoteDbSession } from "@/lib/server/db/client";
import {
  claimAggregateSplitMaterializationCase,
  failExhaustedAggregateSplitMaterializationLeases,
  resolveAggregateSplitMaterializationPolicy,
} from "./aggregateSplitMaterializationWorker";

const policy = resolveAggregateSplitMaterializationPolicy({});
assert.deepEqual(policy, {
  leaseSeconds: 900,
  maxCasesPerInvocation: 1,
  maxChildInputChars: 800_000,
});
assert.throws(
  () => resolveAggregateSplitMaterializationPolicy({
    AGGREGATE_SPLIT_MAX_CHILD_INPUT_CHARS: "900000",
  }),
  /between 100000 and 800000/,
);

let renderedClaimSql = "";
const claimedCase = {
  id: "33333333-3333-4333-8333-333333333333",
};
const selectChain = {
  from: () => selectChain,
  where: () => selectChain,
  limit: async () => [claimedCase],
};
const db = {
  execute: async (query: SQL) => {
    renderedClaimSql = new PgDialect().sqlToQuery(query).sql;
    return [{ id: claimedCase.id }];
  },
  select: () => selectChain,
} as unknown as CunoteDbSession;
const claimed = await claimAggregateSplitMaterializationCase(db, {
  workerId: "aggregate-split-materialization-worker",
  leaseSeconds: 900,
  now: new Date("2026-07-26T00:00:00.000Z"),
});
assert.equal(claimed?.id, claimedCase.id);
assert.match(renderedClaimSql, /candidate\.status = 'completed'/i);
assert.match(renderedClaimSql, /candidate\.materialization_status = 'pending'/i);
assert.match(renderedClaimSql, /candidate\.materialization_lease_expires_at\s+<=/i);
assert.match(renderedClaimSql, /materialization_attempt_count = materialization_attempt_count \+ 1/i);
assert.match(renderedClaimSql, /FOR UPDATE OF candidate SKIP LOCKED/i);

let renderedExhaustedSql = "";
const exhausted = await failExhaustedAggregateSplitMaterializationLeases({
  execute: async (query: SQL) => {
    renderedExhaustedSql = new PgDialect().sqlToQuery(query).sql;
    return [{ id: claimedCase.id }];
  },
} as unknown as CunoteDbSession, new Date("2026-07-26T00:15:00.000Z"));
assert.deepEqual(exhausted, [{ id: claimedCase.id }]);
assert.match(renderedExhaustedSql, /materialization_status = 'processing'/i);
assert.match(
  renderedExhaustedSql,
  /materialization_attempt_count >= materialization_max_attempts/i,
);
assert.match(renderedExhaustedSql, /materialization_lease_expires_at <=/i);
assert.match(renderedExhaustedSql, /materialization_status = 'failed'/i);

console.log("aggregate split materialization worker tests passed");
