import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepRepairLiveFilesystemRepository } from "./deep-repair-live-fs";

const SHA = (seed: number): string => seed.toString(16).padStart(64, "0");
const rootDir = await mkdtemp(join(tmpdir(), "cunote-deep-repair-live-fs-"));

try {
  const repository = createDeepRepairLiveFilesystemRepository({ rootDir });
  const authoritySha = SHA(1);
  const planSha = SHA(2);
  const evidenceSha = SHA(3);
  const approvalSha = SHA(9);
  const attemptKey = { planSha256: planSha, sequence: 0 };
  const cohortRelativePath = "spike-out/analysis-lab/experiments/cohorts/wave-1.json";
  const fixtures = [
    [join(rootDir, "authorities", `${authoritySha}.json`), { authority: true }],
    [join(rootDir, "approvals", `${approvalSha}.json`), { approval: true }],
    [join(rootDir, "issued-authorities", `${approvalSha}.json`), { issuance: true }],
    [join(rootDir, "plans", `${planSha}.json`), { plan: true }],
    [join(rootDir, "operational-evidence", `${evidenceSha}.json`), { evidence: true }],
    [join(rootDir, "cohorts", "wave-1.json"), { cohort: true }],
  ] as const;
  for (const [path, value] of fixtures) {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  assert.deepEqual(
    JSON.parse(Buffer.from((await repository.readAuthority(authoritySha))!.bytes).toString("utf8")),
    { authority: true },
  );
  assert.deepEqual(
    JSON.parse(Buffer.from((await repository.readApproval(approvalSha))!.bytes).toString("utf8")),
    { approval: true },
  );
  assert.deepEqual(
    JSON.parse(Buffer.from((await repository.readIssuance(approvalSha))!.bytes).toString("utf8")),
    { issuance: true },
  );
  assert.equal((await repository.readPlan(planSha))?.path, join(rootDir, "plans", `${planSha}.json`));
  assert.ok(await repository.readOperationalEvidence(evidenceSha));
  assert.equal((await repository.readCohort(cohortRelativePath))?.path, cohortRelativePath);
  assert.equal(await repository.readCohort("../../outside.json"), null);
  assert.equal(
    await repository.readCohort("spike-out/analysis-lab/experiments/cohorts/../outside.json"),
    null,
  );
  assert.equal(
    await repository.readCohort("spike-out/analysis-lab/experiments/cohorts/./wave-1.json"),
    null,
  );
  assert.equal(
    await repository.readCohort("spike-out/analysis-lab/experiments/cohorts/nested\\wave-1.json"),
    null,
  );

  const start = {
    schema: "deep-repair-live-start-v1" as const,
    planSha256: planSha,
    parentReceiptSha256: null,
    authoritySha256: authoritySha,
    attemptId: "attempt-1",
    target: { sequence: 0, waveId: "wave-1", grantId: "grant-1" },
    startedAt: "2026-08-14T03:00:00.000Z",
  };
  assert.equal(await repository.claimStart(attemptKey, start), true);
  assert.equal(await repository.claimStart(attemptKey, start), false);
  assert.equal(
    await repository.claimStart(attemptKey, {
      ...start,
      authoritySha256: SHA(9),
      attemptId: "forked-attempt",
    }),
    false,
  );
  assert.ok((await repository.readAttempt(attemptKey))?.start.bytes.byteLength);

  const observationsSha = SHA(4);
  const evaluatorSha = SHA(5);
  const receiptSha = SHA(6);
  await repository.writeObservations(observationsSha, { notices: [] });
  await repository.writeEvaluatorReceipt(evaluatorSha, { receiptSha256: evaluatorSha } as never);
  const receipt = {
    schema: "deep-repair-live-receipt-v1" as const,
    receiptSha256: receiptSha,
    planSha256: planSha,
    manifestSha256: SHA(7),
    parentReceiptSha256: null,
    authoritySha256: authoritySha,
    attemptId: "attempt-1",
    target: { sequence: 0, waveId: "wave-1", grantId: "grant-1" },
    startedAt: "2026-08-14T03:00:00.000Z",
    finishedAt: "2026-08-14T03:01:00.000Z",
    lifecycle: "finished" as const,
    noticeOutcome: "failed" as const,
    promotionEligibility: "not_evaluated" as const,
    runArtifactPath: null,
    runArtifactSha256: null,
    observationsSha256: null,
    evaluatorReceiptSha256: null,
    observedCount: 0,
    gateVerdict: "INVALID" as const,
    nextAction: "stopped" as const,
    failureCode: "fixture",
  };
  await repository.commitTerminal(attemptKey, receiptSha, receipt);
  assert.ok(await repository.readLiveReceipt(receiptSha));
  assert.ok(await repository.readObservations(observationsSha));
  assert.ok(await repository.readEvaluatorReceipt(evaluatorSha));
  assert.ok((await repository.readAttempt(attemptKey))?.terminal);
  await assert.rejects(
    repository.commitTerminal(attemptKey, SHA(8), { ...receipt, receiptSha256: SHA(8) }),
    /immutable artifact conflict/,
  );

  const terminalBytes = await readFile(join(rootDir, "attempts", planSha, "00", "terminal.json"));
  assert.equal(JSON.parse(terminalBytes.toString("utf8")).receiptSha256, receiptSha);
} finally {
  await rm(rootDir, { recursive: true, force: true });
}

console.log("deep-repair-live-fs tests passed");
