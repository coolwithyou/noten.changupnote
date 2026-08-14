import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeepRepairRecoveryFilesystemRepository } from "./deep-repair-recovery-fs";

const SHA = (seed: number): string => seed.toString(16).padStart(64, "0");
const PLAN_SHA = SHA(1);
const APPROVAL_SHA = SHA(2);
const AUTHORITY_SHA = SHA(3);
const ORIGINAL_APPROVAL_SHA = SHA(4);
const RECEIPT_SHA = SHA(5);
const bytes = (value: string): Buffer => Buffer.from(`${value}\n`, "utf8");

const rootDir = await mkdtemp(join(tmpdir(), "deep-repair-recovery-fs-"));
const repository = createDeepRepairRecoveryFilesystemRepository({ rootDir });

assert.throws(
  () => repository.readRecoveryApproval("../escape"),
  /invalid SHA-256 path segment/,
);
await assert.rejects(
  repository.readAttempt({ planSha256: PLAN_SHA, sequence: 30 }),
  /invalid experiment sequence/,
);

assert.equal(await repository.readRecoveryApproval(APPROVAL_SHA), null);
assert.equal(await repository.readAuthority(AUTHORITY_SHA), null);
assert.equal(await repository.readIssuance(ORIGINAL_APPROVAL_SHA), null);
assert.equal(await repository.readPlan(PLAN_SHA), null);
assert.deepEqual(
  await repository.readAttempt({ planSha256: PLAN_SHA, sequence: 0 }),
  { claim: null, resolution: null },
);

const receiptBytes = bytes("recovery-receipt");
await repository.writeRecoveryReceipt(RECEIPT_SHA, receiptBytes);
await repository.writeRecoveryReceipt(RECEIPT_SHA, receiptBytes);
assert.deepEqual(
  Buffer.from((await repository.readRecoveryReceipt(RECEIPT_SHA))!.bytes),
  receiptBytes,
);
await assert.rejects(
  repository.writeRecoveryReceipt(RECEIPT_SHA, bytes("conflict")),
  /immutable artifact conflict/,
);

const key = { planSha256: PLAN_SHA, sequence: 0 };
const claimPath = join(rootDir, "attempts", PLAN_SHA, "00", "claim.json");
await mkdir(join(rootDir, "attempts", PLAN_SHA, "00"), { recursive: true });
await writeFile(claimPath, bytes("claim-winner"));
assert.equal(await repository.claimAttemptResolution(key, bytes("resolution-winner")), true);
assert.equal(await repository.claimAttemptResolution(key, bytes("resolution-loser")), false);
const attempt = await repository.readAttempt(key);
assert.deepEqual(Buffer.from(attempt.claim!.bytes), bytes("claim-winner"));
assert.deepEqual(Buffer.from(attempt.resolution!.bytes), bytes("resolution-winner"));
assert.deepEqual(
  await readFile(claimPath),
  bytes("claim-winner"),
);
assert.deepEqual(
  await readFile(join(rootDir, "attempts", PLAN_SHA, "00", "resolution.json")),
  bytes("resolution-winner"),
);

console.log("deep-repair-recovery-fs tests passed");
