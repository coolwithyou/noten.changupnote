import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProductUatEnv,
  createProductUatSourceSnapshot,
  findForbiddenSnapshotPaths,
  stopTrackedChild,
  trackChildProcess,
} from "./runtime.mjs";

const scrubbed = createProductUatEnv({ DATABASE_URL: "postgres:///postgres" }, {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DATABASE_URL: "postgres://production.invalid/database",
  SUPABASE_DB_URL: "postgres://production.invalid/supabase",
  ANTHROPIC_API_KEY: "must-not-leak",
  GOOGLE_CLIENT_SECRET: "must-not-leak",
  POPBILL_SECRET_KEY: "must-not-leak",
  R2_SECRET_ACCESS_KEY: "must-not-leak",
});
assert.equal(scrubbed.DATABASE_URL, "postgres:///postgres", "명시 UAT override만 허용한다");
assert.equal(scrubbed.SUPABASE_DB_URL, undefined);
assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
assert.equal(scrubbed.GOOGLE_CLIENT_SECRET, undefined);
assert.equal(scrubbed.POPBILL_SECRET_KEY, undefined);
assert.equal(scrubbed.R2_SECRET_ACCESS_KEY, undefined);
assert.equal(scrubbed.CI, "1");
assert.equal(scrubbed.NEXT_TELEMETRY_DISABLED, "1");

const testRoot = mkdtempSync(join(realpathSync(tmpdir()), "cunote-product-uat-runtime-test-"));
const fixtureRoot = join(testRoot, "fixture-source");
mkdirSync(join(fixtureRoot, "apps", "fixture", "nested"), { recursive: true });
mkdirSync(join(fixtureRoot, ".vercel"));
mkdirSync(join(fixtureRoot, ".git"));
mkdirSync(join(fixtureRoot, "node_modules", "leaked"), { recursive: true });
mkdirSync(join(fixtureRoot, "apps", "fixture", ".next-build"), { recursive: true });
mkdirSync(join(fixtureRoot, "apps", "fixture", "spike-out-private"), { recursive: true });
writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({
  name: "isolated-source-fixture",
  private: true,
  packageManager: "pnpm@10.30.1",
}));
writeFileSync(join(fixtureRoot, "pnpm-lock.yaml"), [
  "lockfileVersion: '9.0'",
  "settings:",
  "  autoInstallPeers: true",
  "  excludeLinksFromLockfile: false",
  "importers:",
  "  .: {}",
  "",
].join("\n"));
writeFileSync(join(fixtureRoot, "apps", "fixture", "safe.txt"), "safe-source\n");
writeFileSync(join(fixtureRoot, ".env"), "DATABASE_URL=production\n");
writeFileSync(join(fixtureRoot, "apps", "fixture", "nested", ".env.local"), "SECRET=production\n");
writeFileSync(join(fixtureRoot, ".vercel", "project.json"), "{}\n");
writeFileSync(join(fixtureRoot, ".git", "config"), "secret\n");
writeFileSync(join(fixtureRoot, "node_modules", "leaked", "index.js"), "leak\n");
writeFileSync(join(fixtureRoot, "apps", "fixture", ".next-build", "server.js"), "leak\n");
writeFileSync(join(fixtureRoot, "apps", "fixture", "spike-out-private", "artifact.json"), "{}\n");

const snapshot = createProductUatSourceSnapshot({
  sourceRoot: fixtureRoot,
  sourceInventory: ["package.json", "pnpm-lock.yaml", "apps/fixture/safe.txt"],
  workspacePackages: [],
  inheritedEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
});
assert.equal(findForbiddenSnapshotPaths(snapshot.snapshotRoot).filter((path) => path !== "node_modules").length, 0);
assert.equal(readFileSync(join(snapshot.snapshotRoot, "apps", "fixture", "safe.txt"), "utf8"), "safe-source\n");
assert.deepEqual(
  snapshot.sourceFiles.map((entry) => entry.path),
  ["apps/fixture/safe.txt", "package.json", "pnpm-lock.yaml"],
  "manifest에는 복사된 안전 소스만 포함한다",
);
assert.match(snapshot.sourceManifestSha256, /^[a-f0-9]{64}$/);
assert.ok(snapshot.snapshotRoot.startsWith(realpathSync(tmpdir())));
assert.throws(
  () => createProductUatSourceSnapshot({
    sourceRoot: fixtureRoot,
    runRoot: join(testRoot, "cunote-product-uat-source-existing"),
    installDependencies: false,
  }),
  /지정하거나 재사용할 수 없습니다/,
);

const externalTarget = join(testRoot, ".env.external");
writeFileSync(externalTarget, "SECRET=outside\n");
symlinkSync(externalTarget, join(fixtureRoot, "apps", "fixture", "external-link"));
assert.throws(
  () => createProductUatSourceSnapshot({
    sourceRoot: fixtureRoot,
    sourceInventory: ["package.json", "pnpm-lock.yaml", "apps/fixture/external-link"],
    installDependencies: false,
  }),
  /symlink는 허용하지 않습니다/,
);
const externalDirectory = join(testRoot, "outside-private");
mkdirSync(externalDirectory);
writeFileSync(join(externalDirectory, "private.txt"), "outside\n");
symlinkSync(externalDirectory, join(fixtureRoot, "apps", "linked"));
assert.throws(
  () => createProductUatSourceSnapshot({
    sourceRoot: fixtureRoot,
    sourceInventory: ["package.json", "pnpm-lock.yaml", "apps/linked/private.txt"],
    installDependencies: false,
  }),
  /symlink는 허용하지 않습니다/,
);
assert.throws(
  () => createProductUatSourceSnapshot({
    sourceRoot: fixtureRoot,
    sourceInventory: ["package.json", "pnpm-lock.yaml", ".env"],
    installDependencies: false,
  }),
  /금지 경로/,
);
for (const envName of [".envsecret", ".envrc"]) {
  writeFileSync(join(fixtureRoot, "apps", "fixture", envName), "SECRET=production\n");
  assert.throws(
    () => createProductUatSourceSnapshot({
      sourceRoot: fixtureRoot,
      sourceInventory: ["package.json", "pnpm-lock.yaml", `apps/fixture/${envName}`],
      installDependencies: false,
    }),
    /금지 경로/,
  );
}
assert.throws(
  () => createProductUatSourceSnapshot({
    sourceRoot: realpathSync(tmpdir()),
    sourceInventory: ["package.json"],
    installDependencies: false,
  }),
  /서로 포함할 수 없습니다/,
);

const missingChild = trackChildProcess(spawn(join(testRoot, "missing-executable"), [], { stdio: "ignore" }));
const missingTermination = await missingChild.termination;
assert.ok(missingTermination.error instanceof Error);
assert.ok(missingChild.spawnError instanceof Error);
await stopTrackedChild(missingChild, 100);

const runningChild = trackChildProcess(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
}));
await once(runningChild.child, "spawn");
await stopTrackedChild(runningChild, 2_000);
assert.equal(runningChild.closed, true);

const stuckProcess = new EventEmitter();
stuckProcess.kill = () => true;
const stuckChild = trackChildProcess(stuckProcess);
await assert.rejects(
  () => stopTrackedChild(stuckChild, 10),
  /SIGKILL 뒤에도 종료되지 않았습니다/,
);

console.log(JSON.stringify({
  ok: true,
  suite: "product-uat-runtime",
  checks: 27,
  sourceManifestSha256: snapshot.sourceManifestSha256,
  retainedFixture: testRoot,
}));
