import assert from "node:assert/strict";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import { promotionServingSnapshotScope, withPromotionServingReadSnapshot } from "./drizzle";

let receivedConfig: unknown = null;
const session = { marker: "snapshot-session" } as unknown as CunoteDbSession;
const rootClient = {
  transaction: async (
    run: (value: CunoteDbSession) => Promise<unknown>,
    config: unknown,
  ) => {
    receivedConfig = config;
    return run(session);
  },
} as unknown as CunoteDb;

assert.equal(
  await withPromotionServingReadSnapshot(rootClient, async (value) => value === session),
  true,
);
assert.deepEqual(receivedConfig, {
  isolationLevel: "repeatable read",
  accessMode: "read only",
});

let nestedTransactionCalled = false;
const nestedClient = {
  rollback() {
    throw new Error("not called");
  },
  async transaction() {
    nestedTransactionCalled = true;
  },
} as unknown as CunoteDb;
await assert.rejects(
  () => withPromotionServingReadSnapshot(nestedClient, async () => null),
  /top-level database client/,
);
assert.equal(nestedTransactionCalled, false, "savepoint로 isolation 옵션을 잃는 fallback은 허용하지 않는다");

assert.equal(
  promotionServingSnapshotScope(true, ["grant-a"]),
  undefined,
  "promotion admission 필터는 전체 active release 집합을 읽는다",
);
assert.deepEqual(
  promotionServingSnapshotScope(false, ["grant-a", "grant-a", "grant-b"]),
  ["grant-a", "grant-b"],
  "필터를 쓰지 않는 목록은 현재 hydration component로 promotion 조회를 제한한다",
);
assert.deepEqual(
  promotionServingSnapshotScope(undefined, []),
  [],
  "빈 hydration은 release query를 열지 않는다",
);

console.log("promotion serving snapshot transaction contract: ok");
