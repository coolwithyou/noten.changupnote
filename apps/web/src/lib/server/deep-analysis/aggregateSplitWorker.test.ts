import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import type { CunoteDbSession } from "@/lib/server/db/client";
import {
  claimApprovedAggregateSplitCase,
  resolveAggregateSplitWorkerPolicy,
} from "./aggregateSplitWorker";

const policy = resolveAggregateSplitWorkerPolicy({});
assert.equal(policy.maxCasesPerInvocation, 1);
assert.equal(policy.maxCostUsd, 12);
assert.equal(policy.maxChildInputChars, 800_000);
assert.throws(
  () => resolveAggregateSplitWorkerPolicy({
    AGGREGATE_SPLIT_MAX_CHILD_INPUT_CHARS: "900000",
  }),
  /between 100000 and 800000/,
  "분리 worker가 일반 딥분석 입력 상한을 우회해 올릴 수 없어야 한다",
);
assert.throws(
  () => resolveAggregateSplitWorkerPolicy({
    AGGREGATE_SPLIT_MODEL: "claude-unknown",
  }),
  /not allowlisted/,
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
const claimed = await claimApprovedAggregateSplitCase(db, {
  workerId: "aggregate-split-worker",
  leaseSeconds: 3_600,
  now: new Date("2026-07-26T00:00:00.000Z"),
});
assert.equal(claimed?.id, claimedCase.id);
assert.match(renderedClaimSql, /FOR UPDATE OF candidate SKIP LOCKED/i);
assert.match(renderedClaimSql, /candidate\.status = 'approved'/i);
assert.match(renderedClaimSql, /candidate\.lease_expires_at <=/i);
assert.match(renderedClaimSql, /attempt_count = attempt_count \+ 1/i);

console.log("aggregate split worker tests passed");
