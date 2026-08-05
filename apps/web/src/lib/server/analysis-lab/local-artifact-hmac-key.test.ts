import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME,
  ensureLocalArtifactHmacKey,
} from "./local-artifact-hmac-key";

const root = await mkdtemp(join(tmpdir(), "cunote-shadow-key-"));

try {
  const envPath = join(root, "apps/web/.env.development.local");
  await mkdir(join(root, "apps/web"), { recursive: true });
  await writeFile(envPath, "ANALYSIS_LAB_TRANSPORT=claude-cli");

  const created = await ensureLocalArtifactHmacKey(envPath);
  assert.equal(created.status, "created");
  const createdBody = await readFile(envPath, "utf8");
  assert.match(createdBody, /ANALYSIS_LAB_TRANSPORT=claude-cli\n/);
  const secret = createdBody.match(new RegExp(`${ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME}=([a-f0-9]+)`))?.[1];
  assert.equal(secret?.length, 64);
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);

  const existing = await ensureLocalArtifactHmacKey(envPath);
  assert.equal(existing.status, "existing");
  assert.equal(await readFile(envPath, "utf8"), createdBody, "재실행은 키를 바꾸지 않아야 한다");

  const invalidPath = join(root, "invalid.env");
  await writeFile(invalidPath, `${ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME}=short\n`);
  await assert.rejects(
    () => ensureLocalArtifactHmacKey(invalidPath),
    /32자 이상/,
  );
  assert.match(await readFile(invalidPath, "utf8"), /=short/);

  const duplicatePath = join(root, "duplicate.env");
  await writeFile(
    duplicatePath,
    `${ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME}=${"a".repeat(64)}\n`
      + `${ANALYSIS_LAB_ARTIFACT_HMAC_KEY_NAME}=${"b".repeat(64)}\n`,
  );
  await assert.rejects(
    () => ensureLocalArtifactHmacKey(duplicatePath),
    /중복 정의/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("analysis lab local artifact HMAC key tests: ok");
