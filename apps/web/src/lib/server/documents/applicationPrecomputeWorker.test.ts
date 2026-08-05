import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CunoteDbSession } from "@/lib/server/db/client";
import { startPrimaryWithApplicationPrecompute } from "@/lib/server/deep-analysis/parallelApplicationPrecompute";
import {
  assertApplicationPrecomputePolicyCanExecute,
  resolveApplicationPrecomputeWorkerPolicy,
} from "./applicationPrecomputePolicy";
import {
  claimApplicationPrecomputeJob,
  planApplicationPrecomputeBackfill,
} from "./applicationPrecomputeQueue";

// 기본값은 실행·비용 변이를 만들지 않는 observe-only/unconfigured다.
const defaults = resolveApplicationPrecomputeWorkerPolicy({});
assert.equal(defaults.executionMode, "observe_only");
assert.equal(defaults.claimScope, "unconfigured");
assert.equal(defaults.model, "claude-sonnet-5");
assert.equal(defaults.maxJobsPerInvocation, 2);
assert.equal(defaults.maxConcurrentJobs, 1);

assert.throws(
  () => assertApplicationPrecomputePolicyCanExecute({ ...defaults, executionMode: "active" }),
  /requires APPLICATION_PRECOMPUTE_CLAIM_SCOPE/,
);
const bounded = resolveApplicationPrecomputeWorkerPolicy({
  APPLICATION_PRECOMPUTE_WORKER_MODE: "active",
  APPLICATION_PRECOMPUTE_CLAIM_SCOPE: "bounded",
  APPLICATION_PRECOMPUTE_CLAIM_GRANT_IDS: "00000000-0000-4000-8000-000000000001",
});
assert.doesNotThrow(() => assertApplicationPrecomputePolicyCanExecute(bounded));
assert.equal(bounded.claimScope, "bounded");

// 전용 claim은 bounded grant UUID를 PostgreSQL uuid[]로 렌더링하고 별도 lease를 잡는다.
const claimedJob = {
  id: "11111111-1111-4111-8111-111111111111",
  grantId: "00000000-0000-4000-8000-000000000001",
};
let renderedClaimSql = "";
const selectChain = {
  from: () => selectChain,
  where: () => selectChain,
  limit: async () => [claimedJob],
};
const claimDb = {
  execute: async (query: SQL) => {
    renderedClaimSql = new PgDialect().sqlToQuery(query).sql;
    return [{ id: claimedJob.id }];
  },
  select: () => selectChain,
} as unknown as CunoteDbSession;
const claimed = await claimApplicationPrecomputeJob({
  db: claimDb,
  workerId: "worker",
  analysisVersion: bounded.analysisVersion,
  leaseSeconds: 60,
  maxConcurrentJobs: 1,
  claimGrantIds: [claimedJob.grantId],
});
assert.equal(claimed?.grantId, claimedJob.grantId);
assert.match(renderedClaimSql, /grant_application_precompute_jobs/u);
assert.match(renderedClaimSql, /candidate\.grant_id = ANY\(ARRAY\[\$\d+\]::uuid\[\]\)/u);
await assert.rejects(
  claimApplicationPrecomputeJob({
    db: claimDb,
    workerId: "worker",
    analysisVersion: bounded.analysisVersion,
    leaseSeconds: 60,
    maxConcurrentJobs: 1,
    claimGrantIds: [],
  }),
  /claimGrantIds must be omitted/u,
);

// status=open 값이 남아 있어도 실제 apply_end가 지난 surface는 backfill 후보에서 제외한다.
let renderedBackfillSql = "";
const backfillDb = {
  execute: async (query: SQL) => {
    renderedBackfillSql = new PgDialect().sqlToQuery(query).sql;
    return [];
  },
} as unknown as CunoteDbSession;
await planApplicationPrecomputeBackfill({
  db: backfillDb,
  analysisVersion: bounded.analysisVersion,
  limit: 20,
  write: false,
});
assert.match(
  renderedBackfillSql,
  /grant_row\.apply_end IS NULL OR grant_row\.apply_end >= \$\d+::timestamptz/u,
  "stale status만 믿지 않고 실제 마감일을 함께 검사해야 한다",
);

// primary가 Kordoc enqueue 완료를 기다리지 않고 시작·완료할 수 있다.
const starts: string[] = [];
let resolvePrimary!: (value: string) => void;
let resolveApplication!: (value: string) => void;
const primaryGate = new Promise<string>((resolve) => { resolvePrimary = resolve; });
const applicationGate = new Promise<string>((resolve) => { resolveApplication = resolve; });
const parallel = startPrimaryWithApplicationPrecompute({
  startPrimary: () => {
    starts.push("primary");
    return primaryGate;
  },
  startApplication: () => {
    starts.push("application");
    return applicationGate;
  },
});
await Promise.resolve();
assert.deepEqual(new Set(starts), new Set(["primary", "application"]));
resolvePrimary("primary-ok");
assert.equal(await parallel.primary, "primary-ok");
let applicationSettled = false;
void parallel.application.then(() => { applicationSettled = true; });
await Promise.resolve();
assert.equal(applicationSettled, false, "primary는 Kordoc enqueue 종결을 기다리지 않는다");
resolveApplication("application-ok");
assert.deepEqual(await parallel.application, { result: "application-ok", error: null });

const softFailure = startPrimaryWithApplicationPrecompute({
  startPrimary: async () => "primary-still-ok",
  startApplication: async () => { throw new Error("queue unavailable"); },
});
assert.equal(await softFailure.primary, "primary-still-ok");
assert.deepEqual(await softFailure.application, { result: null, error: "queue unavailable" });

// 운영 그래프는 로컬 구독 transport를 import하거나 환경변수로 선택하지 않는다.
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const productionFiles = [
  "apps/web/src/lib/server/deep-analysis/processor.ts",
  "apps/web/src/lib/server/documents/applicationPrecomputePolicy.ts",
  "apps/web/src/lib/server/documents/applicationPrecomputeQueue.ts",
  "apps/web/src/lib/server/documents/applicationPrecomputeProcessor.ts",
  "apps/web/src/lib/server/documents/applicationPrecomputeWorker.ts",
  "apps/web/src/lib/server/documents/applicationPrecomputeWorkerCli.ts",
];
for (const relative of productionFiles) {
  const source = await readFile(`${root}/${relative}`, "utf8");
  assert.doesNotMatch(source, /claude-cli-transport/iu, `${relative}: 구독 transport import 금지`);
  assert.doesNotMatch(source, /ANALYSIS_LAB_TRANSPORT/u, `${relative}: lab transport env 금지`);
}
const processorSource = await readFile(
  `${root}/apps/web/src/lib/server/documents/applicationPrecomputeProcessor.ts`,
  "utf8",
);
assert.match(processorSource, /transport:\s*"api"/u, "운영 Kordoc 호출은 API transport로 고정");

console.log("application precompute worker contract tests: ok");
