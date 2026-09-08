import assert from "node:assert/strict";
import { join } from "node:path";
import {
  completeFixtureActionBeforeClose,
  parseSourceCorrectionFixtureArgs,
  validateSourceCorrectionFixtureRuntime,
} from "./source-correction-fixture";

const lifecycle: string[] = [];
let finishSecondQuery!: () => void;
const secondQuery = new Promise<void>((resolve) => {
  finishSecondQuery = resolve;
});
const pendingAction = completeFixtureActionBeforeClose(async () => {
  lifecycle.push("query:one");
  await secondQuery;
  lifecycle.push("query:two");
  return "inspected";
}, async () => {
  lifecycle.push("close");
});
await Promise.resolve();
assert.deepEqual(lifecycle, ["query:one"], "두 번째 query가 끝나기 전에는 연결을 닫지 않습니다");
finishSecondQuery();
assert.equal(await pendingAction, "inspected");
assert.deepEqual(lifecycle, ["query:one", "query:two", "close"]);

const runtimeRoot = "/private/var/folders/fixture/T/cunote-product-uat-pg-Ab12";
const markerPath = join(runtimeRoot, ".cunote-product-uat-owner.json");
const marker = JSON.stringify({
    schema: "cunote-product-uat-runtime-owner-v1",
    id: "70000000-0000-4000-8000-000000000001",
  });
const env = {
  PGHOST: runtimeRoot,
  PGUSER: "postgres",
  DATABASE_URL: "postgres:///postgres",
  CUNOTE_PRODUCT_UAT_RUNTIME_ROOT: runtimeRoot,
};
const stat = (path: string, markerMode = 0o600) => ({
  isDirectory: () => path === runtimeRoot,
  isFile: () => path === markerPath,
  isSymbolicLink: () => false,
  mode: path === runtimeRoot ? 0o700 : markerMode,
  uid: 501,
});
const fixtureFs = (markerMode = 0o600) => ({
  lstatSyncImpl: (path: string) => stat(path, markerMode),
  readFileSyncImpl: (path: string) => {
    assert.equal(path, markerPath);
    return marker;
  },
  realpathSyncImpl: (path: string) => path,
  getuidImpl: () => 501,
});

assert.deepEqual(parseSourceCorrectionFixtureArgs(["--action=seed"]), { action: "seed" });
assert.deepEqual(parseSourceCorrectionFixtureArgs(["--action=advance"]), { action: "advance" });
assert.deepEqual(parseSourceCorrectionFixtureArgs(["--action=inspect"]), { action: "inspect" });
assert.throws(() => parseSourceCorrectionFixtureArgs([]), /하나가 필요/);
assert.throws(() => parseSourceCorrectionFixtureArgs(["--action=update"]), /AssertionError/);
assert.equal(validateSourceCorrectionFixtureRuntime(env, fixtureFs()).runtimeRoot, runtimeRoot);
assert.throws(() => validateSourceCorrectionFixtureRuntime(
  { ...env, DATABASE_URL: "postgres://external/db" }, fixtureFs(),
));
assert.throws(() => validateSourceCorrectionFixtureRuntime(env, fixtureFs(0o644)));
assert.equal(validateSourceCorrectionFixtureRuntime(env, fixtureFs()).socket, runtimeRoot);
console.log("source-correction-fixture.test.ts: all assertions passed");
