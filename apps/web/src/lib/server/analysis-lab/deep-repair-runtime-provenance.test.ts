import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  computeDeepRepairPackageRuntimeSha256,
  readCurrentDeepRepairExecutionProvenance,
} from "./deep-repair-runtime-provenance";

const execFileAsync = promisify(execFile);
const TRANSITIVE_EXECUTION_PATHS = [
  "apps/web/src/lib/server/loadMonorepoEnv.ts",
  "apps/web/src/lib/server/db/client.ts",
  "apps/web/src/lib/server/db/schema.ts",
  "apps/web/src/lib/server/chat/grounding.ts",
  "apps/web/src/lib/server/storage/r2ObjectStorage.ts",
  "apps/web/src/lib/server/archive/grantArchiveData.ts",
  "apps/web/src/lib/server/archive/grantArchiveSearch.ts",
] as const;

const root = await mkdtemp(join(tmpdir(), "cunote-runtime-provenance-"));
try {
  for (const name of ["contracts", "core"]) {
    await mkdir(join(root, "packages", name, "dist", "nested"), { recursive: true });
    await writeFile(join(root, "packages", name, "package.json"), JSON.stringify({ name: `@cunote/${name}` }));
    await writeFile(join(root, "packages", name, "dist", "index.js"), `export const name = ${JSON.stringify(name)};\n`);
    await writeFile(join(root, "packages", name, "dist", "nested", "value.js"), `export const value = 1;\n`);
    await writeFile(join(root, "packages", name, "dist", "ignored.test.js"), "throw new Error('ignored');\n");
    await writeFile(join(root, "packages", name, "dist", "index.d.ts"), "export declare const name: string;\n");
  }

  const first = await computeDeepRepairPackageRuntimeSha256(root);
  const second = await computeDeepRepairPackageRuntimeSha256(root);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first, "같은 runtime bytes는 같은 digest");

  await writeFile(join(root, "packages", "core", "dist", "ignored.test.js"), "changed but ignored\n");
  await writeFile(join(root, "packages", "contracts", "dist", "index.d.ts"), "changed but ignored\n");
  assert.equal(await computeDeepRepairPackageRuntimeSha256(root), first);

  await writeFile(join(root, "packages", "core", "dist", "nested", "value.js"), "export const value = 2;\n");
  const runtimeChanged = await computeDeepRepairPackageRuntimeSha256(root);
  assert.notEqual(runtimeChanged, first, "실제 dist JS가 바뀌면 digest가 바뀐다");

  await writeFile(join(root, "packages", "contracts", "package.json"), JSON.stringify({ name: "changed" }));
  assert.notEqual(await computeDeepRepairPackageRuntimeSha256(root), runtimeChanged, "resolution package.json도 봉인한다");

  await assert.rejects(
    readCurrentDeepRepairExecutionProvenance({
      repositoryRoot: root,
      readGitState: async () => ({ gitSha: "1".repeat(40), trackedClean: false }),
    }),
    /커밋되지 않은 변경/,
  );
  const exact = await readCurrentDeepRepairExecutionProvenance({
    repositoryRoot: root,
    readGitState: async () => ({ gitSha: "1".repeat(40), trackedClean: true }),
  });
  assert.equal(exact.gitSha, "1".repeat(40));
  assert.match(exact.packageRuntimeSha256, /^[a-f0-9]{64}$/);

  for (const [index, path] of TRANSITIVE_EXECUTION_PATHS.entries()) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `export const stable${index} = true;\n`);
  }
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Cunote Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@cunote.local"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });

  await readCurrentDeepRepairExecutionProvenance({ repositoryRoot: root });
  for (const [index, path] of TRANSITIVE_EXECUTION_PATHS.entries()) {
    const absolutePath = join(root, path);
    await writeFile(absolutePath, `export const dirty${index} = true;\n`);
    await assert.rejects(
      readCurrentDeepRepairExecutionProvenance({ repositoryRoot: root }),
      /커밋되지 않은 변경/,
      `${path} drift는 formal provenance를 거부해야 한다`,
    );
    await writeFile(absolutePath, `export const stable${index} = true;\n`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("deep-repair-runtime-provenance tests passed");
