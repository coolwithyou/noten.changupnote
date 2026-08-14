import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimImmutableBytesAtomic,
  writeImmutableBytesAtomic,
} from "./immutable-artifact-fs";

const root = await mkdtemp(join(tmpdir(), "cunote-immutable-artifact-"));

try {
  const claimPath = join(root, "attempts", "start.json");
  const contenders = [
    Buffer.alloc(2 * 1024 * 1024, 0x61),
    Buffer.alloc(2 * 1024 * 1024, 0x62),
  ] as const;
  const claims = await Promise.all(
    contenders.map((bytes) => claimImmutableBytesAtomic(claimPath, bytes)),
  );
  assert.deepEqual(claims.sort(), [false, true]);
  const winner = await readFile(claimPath);
  assert.equal(
    contenders.some((candidate) => Buffer.compare(candidate, winner) === 0),
    true,
    "final path에는 한 contender의 완전한 bytes만 보여야 한다",
  );
  assert.deepEqual(
    (await readdir(join(root, "attempts"))).filter((name) => name.endsWith(".tmp")),
    [],
    "CAS 뒤 임시 inode를 남기면 안 된다",
  );

  const immutablePath = join(root, "series", "deep-v18.json");
  const stable = Buffer.from("{\"stable\":true}\n", "utf8");
  await writeImmutableBytesAtomic(immutablePath, stable);
  await writeImmutableBytesAtomic(immutablePath, stable);
  await assert.rejects(
    writeImmutableBytesAtomic(immutablePath, Buffer.from("{\"stable\":false}\n", "utf8")),
    /immutable artifact conflict/,
  );
  assert.deepEqual(await readFile(immutablePath), stable);

  const source = readFileSync(new URL("./immutable-artifact-fs.ts", import.meta.url), "utf8");
  assert.match(source, /await link\(temporaryPath, path\)/);
  assert.doesNotMatch(
    source,
    /writeFile\(path,\s*(?:bytes|desired)/,
    "final immutable path를 writeFile로 먼저 노출하면 안 된다",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("immutable artifact filesystem tests: ok");
