import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDeepRepairAuthorizationFilesystemRepository } from "./deep-repair-authorization-fs";

const SHA = (seed: number): string => seed.toString(16).padStart(64, "0");
const rawSha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const rootDir = await mkdtemp(join(tmpdir(), "cunote-deep-repair-authorization-"));

try {
  const repository = createDeepRepairAuthorizationFilesystemRepository({ rootDir });
  const approvalSha = SHA(1);
  const proposalSha = SHA(2);
  const planSha = SHA(3);
  const receiptSha = SHA(4);
  const cohortPath = "spike-out/analysis-lab/experiments/cohorts/exact.json";
  const fixtures = [
    [join(rootDir, "approvals", `${approvalSha}.json`), Buffer.from("approval\n")],
    [join(rootDir, "series", "deep-v27.json"), Buffer.from("series\n")],
    [join(rootDir, "proposals", `${proposalSha}.json`), Buffer.from("proposal\n")],
    [join(rootDir, "plans", `${planSha}.json`), Buffer.from("plan\n")],
    [join(rootDir, "cohorts", "exact.json"), Buffer.from("cohort\n")],
    [join(rootDir, "receipts", `${receiptSha}.json`), Buffer.from("receipt\n")],
    [join(rootDir, "attempts", planSha, "00", "claim.json"), Buffer.from("start\n")],
    [join(rootDir, "attempts", planSha, "00", "resolution.json"), Buffer.from("terminal\n")],
    [join(rootDir, "attempts", planSha, "00", "resumes", receiptSha, "claim.json"), Buffer.from("resume\n")],
  ] as const;
  for (const [path, bytes] of fixtures) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  assert.equal(Buffer.from((await repository.readApproval(approvalSha))!.bytes).toString(), "approval\n");
  assert.equal(
    (await repository.readSeriesMarker("deep-v27"))?.path,
    "spike-out/analysis-lab/experiments/series/deep-v27.json",
  );
  assert.equal(
    (await repository.readProposal(proposalSha))?.path,
    `spike-out/analysis-lab/experiments/proposals/${proposalSha}.json`,
  );
  assert.ok(await repository.readPlan(planSha));
  assert.equal((await repository.readCohort(cohortPath))?.path, cohortPath);
  assert.equal(await repository.readCohort("../outside.json"), null);
  assert.equal(
    await repository.readCohort("spike-out/analysis-lab/experiments/cohorts/../outside.json"),
    null,
  );
  assert.ok(await repository.readLiveReceipt(receiptSha));
  assert.ok(await repository.readAttemptStart(planSha, 0));
  assert.ok(await repository.readAttemptTerminal(planSha, 0));
  assert.ok(await repository.readResumeAttemptStart(planSha, 0, receiptSha));

  const evidenceBytes = Buffer.from("{\"evidence\":true}\n");
  const evidenceSha = rawSha256(evidenceBytes);
  await repository.writeOperationalEvidence(evidenceSha, evidenceBytes);
  await repository.writeOperationalEvidence(evidenceSha, evidenceBytes);
  assert.deepEqual(
    Buffer.from((await repository.readOperationalEvidence(evidenceSha))!.bytes),
    evidenceBytes,
  );
  await assert.rejects(
    repository.writeOperationalEvidence(evidenceSha, Buffer.from("tampered\n")),
    /raw SHA-256|content address/i,
  );

  const authorityBytes = Buffer.from("{\"authority\":true}\n");
  const authoritySha = rawSha256(authorityBytes);
  await repository.writeAuthority(authoritySha, authorityBytes);
  assert.deepEqual(Buffer.from((await repository.readAuthority(authoritySha))!.bytes), authorityBytes);

  const markerBytes = Buffer.from("{\"issuance\":true}\n");
  assert.equal(await repository.claimIssuance(approvalSha, markerBytes), true);
  assert.equal(await repository.claimIssuance(approvalSha, Buffer.from("conflict\n")), false);
  assert.deepEqual(Buffer.from((await repository.readIssuance(approvalSha))!.bytes), markerBytes);
  assert.deepEqual(
    await readFile(join(rootDir, "issued-authorities", `${approvalSha}.json`)),
    markerBytes,
  );

  const racingApprovalSha = SHA(10);
  const racingMarkers = [
    Buffer.from("{\"authority\":\"first-complete-marker\"}\n"),
    Buffer.from("{\"authority\":\"second-complete-marker\"}\n"),
  ] as const;
  const claims = await Promise.all(
    racingMarkers.map((bytes) => repository.claimIssuance(racingApprovalSha, bytes)),
  );
  assert.deepEqual(claims.sort(), [false, true]);
  const committedRaceMarker = Buffer.from(
    (await repository.readIssuance(racingApprovalSha))!.bytes,
  );
  assert.equal(
    racingMarkers.some((candidate) => Buffer.compare(candidate, committedRaceMarker) === 0),
    true,
    "동시 claim final path에는 한 winner의 완전한 bytes만 보여야 한다",
  );
} finally {
  await rm(rootDir, { recursive: true, force: true });
}

console.log("deep-repair-authorization-fs tests: ok");
