import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CunoteDb, CunoteDbSession } from "@/lib/server/db/client";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  applicationPrecomputeEnqueueExceptionEvent,
  startPrimaryWithApplicationPrecompute,
} from "@/lib/server/deep-analysis/parallelApplicationPrecompute";
import {
  canStartApplicationPrecomputeJob,
  runApplicationPrecomputeWorkerInvocation,
  runWithApplicationPrecomputeLeaseRenewal,
  type ApplicationPrecomputeWorkerDependencies,
} from "./applicationPrecomputeWorker";
import { ApplicationPrecomputeProcessingError } from "./applicationPrecomputeProcessor";
import {
  assertApplicationPrecomputePolicyCanExecute,
  resolveApplicationPrecomputeWorkerPolicy,
} from "./applicationPrecomputePolicy";
import {
  ApplicationPrecomputeLeaseLostError,
  applicationPrecomputeDailySpendUsd,
  claimApplicationPrecomputeJob,
  completeApplicationPrecomputeJob,
  failApplicationPrecomputeJob,
  planApplicationPrecomputeBackfill,
  renewApplicationPrecomputeLease,
  sweepApplicationPrecomputeLeases,
  type ApplicationPrecomputeJob,
} from "./applicationPrecomputeQueue";

// 기본값은 실행·비용 변이를 만들지 않는 observe-only/unconfigured다.
const defaults = resolveApplicationPrecomputeWorkerPolicy({});
assert.equal(defaults.executionMode, "observe_only");
assert.equal(defaults.claimScope, "unconfigured");
assert.equal(defaults.model, "claude-sonnet-5");
assert.equal(defaults.maxJobsPerInvocation, 2);
assert.equal(defaults.maxConcurrentJobs, 1);
assert.equal(defaults.jobCostReserveUsd, 0.5);

assert.equal(canStartApplicationPrecomputeJob({
  spentUsd: 1.49,
  dailyCostCapUsd: 2,
  jobCostReserveUsd: 0.5,
}), true);
assert.equal(canStartApplicationPrecomputeJob({
  spentUsd: 1.51,
  dailyCostCapUsd: 2,
  jobCostReserveUsd: 0.5,
}), false, "다음 job 예약액까지 포함해 일일 상한 전에 멈춰야 한다");

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
  workerId: "worker",
  leaseToken: "22222222-2222-4222-8222-222222222222",
  attemptCount: 1,
  maxAttempts: 3,
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
  dailyCostCapUsd: 2,
  jobCostReserveUsd: 0.5,
  claimGrantIds: [claimedJob.grantId],
});
assert.equal(claimed?.grantId, claimedJob.grantId);
assert.match(renderedClaimSql, /grant_application_precompute_jobs/u);
assert.match(renderedClaimSql, /grant_application_precompute_attempts/u);
assert.match(renderedClaimSql, /charged_cost_usd/u);
assert.match(renderedClaimSql, /cunote:application-precompute:claim/u);
assert.match(renderedClaimSql, /lease_token = gen_random_uuid\(\)/u);
assert.match(renderedClaimSql, /grant_row\.apply_end/u);
assert.match(renderedClaimSql, /candidate\.grant_id = ANY\(ARRAY\[\$\d+\]::uuid\[\]\)/u);
await assert.rejects(
  claimApplicationPrecomputeJob({
    db: claimDb,
    workerId: "worker",
    analysisVersion: bounded.analysisVersion,
    leaseSeconds: 60,
    maxConcurrentJobs: 1,
    dailyCostCapUsd: 2,
    jobCostReserveUsd: 0.5,
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

const leasedJob = {
  ...claimedJob,
  surfaceId: "33333333-3333-4333-8333-333333333333",
  deepAnalysisRunId: null,
  sourceSha256: "a".repeat(64),
  analysisVersion: bounded.analysisVersion,
  status: "leased",
} as unknown as ApplicationPrecomputeJob;

// lease 갱신과 종결은 worker+token으로 fencing하며, 소유권을 잃은 worker는 덮어쓸 수 없다.
let renderedMutationSql = "";
const mutationDb = (rows: Array<Record<string, unknown>>): CunoteDbSession => ({
  execute: async (query: SQL) => {
    renderedMutationSql = new PgDialect().sqlToQuery(query).sql;
    return rows;
  },
}) as unknown as CunoteDbSession;
await assert.rejects(
  renewApplicationPrecomputeLease({
    db: mutationDb([]),
    job: leasedJob,
    leaseSeconds: 60,
  }),
  ApplicationPrecomputeLeaseLostError,
);
assert.match(renderedMutationSql, /status = 'leased'/u);
assert.match(renderedMutationSql, /worker_id = \$\d+/u);
assert.match(renderedMutationSql, /lease_token = \$\d+::uuid/u);

await completeApplicationPrecomputeJob({
  db: mutationDb([{ id: leasedJob.id }]),
  job: leasedJob,
  resultStatus: "complete",
  artifactId: "44444444-4444-4444-8444-444444444444",
  resultSummary: { fieldCount: 3 },
  requestCount: 1,
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.01,
});
assert.match(renderedMutationSql, /owned_job AS MATERIALIZED/u);
assert.match(renderedMutationSql, /FOR UPDATE/u);
assert.match(renderedMutationSql, /grant_application_precompute_attempts/u);
assert.match(renderedMutationSql, /lease_token = \$\d+::uuid/u);

assert.equal(await failApplicationPrecomputeJob({
  db: mutationDb([{ id: leasedJob.id }]),
  job: leasedJob,
  errorCode: "request_timeout",
  errorMessage: "timed out",
  retryable: true,
}), "retry_wait");
assert.match(renderedMutationSql, /greatest\(reserved_cost_usd, actual_cost_usd\)/u);
assert.match(renderedMutationSql, /owned_job AS MATERIALIZED/u);

const sweepResult = await sweepApplicationPrecomputeLeases({
  db: mutationDb([{ retry_wait: 1, dead_letter: 1, canceled: 2 }]),
  analysisVersion: bounded.analysisVersion,
});
assert.deepEqual(sweepResult, { retryWait: 1, deadLetter: 1, canceled: 2 });
assert.match(renderedMutationSql, /FOR UPDATE SKIP LOCKED/u);
assert.match(renderedMutationSql, /lease_expired_after_final_attempt/u);
assert.match(renderedMutationSql, /grant_no_longer_active/u);

await applicationPrecomputeDailySpendUsd(mutationDb([{ spent_usd: "0.5" }]));
assert.match(renderedMutationSql, /FROM grant_application_precompute_attempts/u);
assert.match(renderedMutationSql, /sum\(charged_cost_usd\)/u);

// 실제 invocation 배선을 호출해 sweep→claim→lease renewal→process→fenced complete 순서를 고정한다.
const fakeDb = {} as CunoteDb;
const fakeStorage = {} as R2ObjectStorage;
const invocationPolicy = { ...bounded, maxJobsPerInvocation: 1 };
const invocationEvents: string[] = [];
let completionCount = 0;
const successfulDependencies: Partial<ApplicationPrecomputeWorkerDependencies> = {
  heartbeat: async () => { invocationEvents.push("heartbeat"); },
  sweep: async () => {
    invocationEvents.push("sweep");
    return { retryWait: 0, deadLetter: 0, canceled: 0 };
  },
  claim: async () => {
    invocationEvents.push("claim");
    return leasedJob;
  },
  dailySpend: async () => 0,
  withLeaseRenewal: async (renewalInput) => {
    invocationEvents.push("renew");
    return renewalInput.run();
  },
  process: async () => {
    invocationEvents.push("process");
    return {
      resultStatus: "complete",
      artifactId: "44444444-4444-4444-8444-444444444444",
      summary: { fieldCount: 3 },
      requestCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
    };
  },
  complete: async () => {
    completionCount += 1;
    invocationEvents.push("complete");
  },
  fail: async () => { throw new Error("success path must not fail"); },
};
const successfulInvocation = await runApplicationPrecomputeWorkerInvocation({
  db: fakeDb,
  storage: fakeStorage,
  apiKey: "test-key",
  workerId: "worker",
  serviceRevision: "test",
  policy: invocationPolicy,
  dependencies: successfulDependencies,
});
assert.deepEqual(successfulInvocation, {
  claimed: 1,
  succeeded: 1,
  failed: 0,
  budgetStopped: false,
  lastErrorCode: null,
});
assert.equal(completionCount, 1);
assert.deepEqual(invocationEvents.slice(1, 6), ["sweep", "claim", "heartbeat", "renew", "process"]);
assert.ok(invocationEvents.indexOf("complete") > invocationEvents.indexOf("process"));

let budgetProcessCount = 0;
const budgetInvocation = await runApplicationPrecomputeWorkerInvocation({
  db: fakeDb,
  storage: fakeStorage,
  apiKey: "test-key",
  workerId: "worker",
  serviceRevision: "test",
  policy: invocationPolicy,
  dependencies: {
    ...successfulDependencies,
    claim: async () => null,
    dailySpend: async () => 1.51,
    process: async () => {
      budgetProcessCount += 1;
      throw new Error("budget guard failed");
    },
  },
});
assert.equal(budgetInvocation.budgetStopped, true);
assert.equal(budgetInvocation.claimed, 0);
assert.equal(budgetProcessCount, 0);

let failureCount = 0;
const failedInvocation = await runApplicationPrecomputeWorkerInvocation({
  db: fakeDb,
  storage: fakeStorage,
  apiKey: "test-key",
  workerId: "worker",
  serviceRevision: "test",
  policy: invocationPolicy,
  dependencies: {
    ...successfulDependencies,
    process: async () => {
      throw new ApplicationPrecomputeProcessingError("request_timeout", "timed out", true);
    },
    fail: async () => {
      failureCount += 1;
      return "retry_wait";
    },
  },
});
assert.equal(failedInvocation.failed, 1);
assert.equal(failedInvocation.lastErrorCode, "request_timeout");
assert.equal(failureCount, 1);

let staleFailureCount = 0;
const stolenInvocation = await runApplicationPrecomputeWorkerInvocation({
  db: fakeDb,
  storage: fakeStorage,
  apiKey: "test-key",
  workerId: "worker",
  serviceRevision: "test",
  policy: invocationPolicy,
  dependencies: {
    ...successfulDependencies,
    process: async () => {
      throw new ApplicationPrecomputeLeaseLostError("stolen");
    },
    fail: async () => {
      staleFailureCount += 1;
      return "retry_wait";
    },
  },
});
assert.equal(stolenInvocation.failed, 1);
assert.equal(stolenInvocation.lastErrorCode, "lease_lost");
assert.equal(staleFailureCount, 0, "탈취된 worker는 stale failure도 기록하면 안 된다");

let renewalCount = 0;
const renewalDb = {
  execute: async () => {
    renewalCount += 1;
    return [{ id: leasedJob.id }];
  },
} as unknown as CunoteDb;
const renewedValue = await runWithApplicationPrecomputeLeaseRenewal({
  db: renewalDb,
  job: leasedJob,
  leaseSeconds: 60,
  renewalIntervalMs: 2,
  run: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 12));
    return "renewed";
  },
});
assert.equal(renewedValue, "renewed");
assert.ok(renewalCount >= 3, "처리 시작·처리 중·종결 직전 lease를 갱신해야 한다");

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
assert.equal(applicationPrecomputeEnqueueExceptionEvent({
  runId: "run-id",
  actor: "worker",
  outcome: { result: { enqueued: 1 }, error: null },
}), null);
assert.deepEqual(applicationPrecomputeEnqueueExceptionEvent({
  runId: "run-id",
  actor: "worker",
  outcome: { result: null, error: "queue unavailable" },
}), {
  runId: "run-id",
  exceptionKey: "run-id:application_precompute_enqueue",
  eventType: "opened",
  reasonCode: "application_precompute_enqueue_failed",
  actorType: "system",
  actor: "worker",
  detail: {
    component: "application_precompute_enqueue",
    terminalRoute: "operational_attention",
    error: "queue unavailable",
  },
});

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
assert.ok(
  [...processorSource.matchAll(/applicationPrecomputeObservationError/gu)].length >= 4,
  "primary 성공·실패 모두 enqueue 관제 기록 결과를 stage receipt에 남겨야 한다",
);

const safetyMigration = await readFile(
  `${root}/db/migrations/0068_glamorous_dagger.sql`,
  "utf8",
);
assert.match(safetyMigration, /CREATE TABLE "grant_application_precompute_attempts"/u);
assert.match(
  safetyMigration,
  /0068 migration requires zero leased application precompute jobs/u,
  "migration 중 기존 lease 소유권을 추측해 이관하면 안 된다",
);
assert.match(safetyMigration, /FROM "grant_application_precompute_jobs" job\s+WHERE job\."attempt_count" > 0/u);
assert.match(safetyMigration, /ADD COLUMN "lease_token" uuid/u);
assert.doesNotMatch(
  safetyMigration,
  /grant_aggregate_split_cases[^;]*lease_token/iu,
  "application precompute 안전화가 다른 queue schema를 변경하면 안 된다",
);

console.log("application precompute worker contract tests: ok");
