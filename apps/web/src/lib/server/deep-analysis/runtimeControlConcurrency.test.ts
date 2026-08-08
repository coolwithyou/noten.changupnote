import assert from "node:assert/strict";
import type { CunoteDb } from "@/lib/server/db/client";
import {
  DeepAnalysisRuntimeControlError,
  runWithLocalSubscriptionLeaseHeartbeat,
} from "./runtimeControl";

const ownerId = "8eb9702b-322d-4f9a-8b99-159916f79f48";
const now = new Date();
const controlRow = {
  controlKey: "global",
  mode: "local_subscription",
  generation: 1,
  changedBy: "test",
  changeReason: "test",
  localOwnerId: ownerId,
  localLeaseExpiresAt: new Date(now.getTime() + 60_000),
  createdAt: now,
  updatedAt: now,
};

const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [controlRow],
      }),
    }),
  }),
} as unknown as CunoteDb;

let markStarted!: () => void;
let finishFirst!: () => void;
const started = new Promise<void>((resolve) => { markStarted = resolve; });
const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
const first = runWithLocalSubscriptionLeaseHeartbeat({
  db,
  ownerId,
  run: async () => {
    markStarted();
    await firstGate;
    return "first";
  },
});
await started;

let secondRunCalled = false;
await assert.rejects(
  runWithLocalSubscriptionLeaseHeartbeat({
    db,
    ownerId,
    run: async () => {
      secondRunCalled = true;
      return "second";
    },
  }),
  (error: unknown) => error instanceof DeepAnalysisRuntimeControlError
    && error.code === "local_analysis_already_running"
    && error.status === 409,
);
assert.equal(secondRunCalled, false, "겹친 요청은 실제 분석 함수를 호출하면 안 된다");

finishFirst();
assert.equal(await first, "first");
assert.equal(
  await runWithLocalSubscriptionLeaseHeartbeat({ db, ownerId, run: async () => "third" }),
  "third",
  "이전 실행이 끝나면 프로세스 락이 해제돼야 한다",
);

console.log("deep-analysis runtime control concurrency tests: ok");
