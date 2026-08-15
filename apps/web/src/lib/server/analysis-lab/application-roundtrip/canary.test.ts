import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createApplicationRoundtripCanaryRunner,
  currentApplicationRoundtripCanaryExecutionBinding,
} from "./canary";
import { parseApplicationRoundtripCanaryArgs } from "./canary-cli";

const proposalSha256 = "a".repeat(64);
const sourceSha256 = "b".repeat(64);
const secondSourceSha256 = "c".repeat(64);
const grantId = "4b752bd0-3213-4794-b9c0-5d287e83daa5";
const proposal = {
  schema: "application-roundtrip-candidate-proposal-v1",
  preparedAt: "2026-08-14T23:18:46.872Z",
  provenance: {
    gitSha: "1".repeat(40),
    packageRuntimeSha256: "2".repeat(64),
    validatorVersion: "analysis-lab-validator-v1",
  },
  deepExperiment: {
    planSha256: "3".repeat(64),
    terminalReceiptSha256: "4".repeat(64),
    observationsSha256: "5".repeat(64),
    observedCount: 10,
  },
  policy: {
    transport: "claude-cli",
    model: "claude-opus-5",
    candidateSelection: "publishable-ready-or-conditional-v1",
    fieldTriage: "ambiguous-only-v1",
    maxCandidates: 10,
  },
  candidates: [],
  executionTargets: [{
    sequence: 7,
    grantId,
    deepReceiptSha256: "6".repeat(64),
    sourceSha256s: [sourceSha256, secondSourceSha256],
    fieldCandidateCount: 44,
    llmCandidateCount: 27,
    deterministicDecisionCount: 17,
  }],
  liveExecutionAuthorized: false,
};

const proposalWithHash = {
  ...proposal,
  proposalSha256: canonicalSha256(proposal),
};
let executeCount = 0;
let storedReceipt: Uint8Array | null = null;
const runner = createApplicationRoundtripCanaryRunner({
  now: () => new Date("2026-08-15T01:00:00.000Z"),
  readProposal: async () => Buffer.from(`${JSON.stringify(proposalWithHash, null, 2)}\n`),
  async executeTarget(input) {
    executeCount += 1;
    assert.deepEqual(currentApplicationRoundtripCanaryExecutionBinding(), {
      proposalSha256: proposalWithHash.proposalSha256,
      sequence: 7,
      grantId,
      sourceSha256s: [sourceSha256, secondSourceSha256],
      model: "claude-opus-5",
      transport: "claude-cli",
    });
    assert.equal(input.grantId, grantId);
    assert.deepEqual(input.sourceSha256s, [sourceSha256, secondSourceSha256]);
    return {
      runId: "roundtrip-2026-08-15T010000.000Z-abcdef",
      artifactPath: "spike-out/analysis-lab/application-roundtrip/bizinfo__x/roundtrip/analysis.json",
      artifactBytes: Buffer.from("exact-run-artifact"),
      transport: "claude-cli",
      requestedModel: "claude-opus-5",
      failureCode: null,
      error: null,
      sourceCount: 2,
      skippedDocumentCount: 0,
      documents: [{
        sourceSha256,
        error: null,
        fieldPlanningStatus: "llm",
        fieldPlanningFailureCode: null,
        adjudicationStatus: "resolved",
        remainingUnresolvedCandidateCount: 0,
        fieldCoverageStatus: "complete",
      }, {
        sourceSha256: secondSourceSha256,
        error: null,
        fieldPlanningStatus: "llm",
        fieldPlanningFailureCode: null,
        adjudicationStatus: "resolved",
        remainingUnresolvedCandidateCount: 0,
        fieldCoverageStatus: "complete",
      }],
    };
  },
  async writeReceipt({ bytes }) {
    storedReceipt = bytes;
  },
});

const result = await runner.run({
  proposalSha256: proposalWithHash.proposalSha256,
  sequence: 7,
  sourceSha256s: [sourceSha256, secondSourceSha256],
  signal: new AbortController().signal,
});
assert.equal(result.status, "complete");
assert.equal(executeCount, 1);
assert.ok(storedReceipt);
assert.equal(currentApplicationRoundtripCanaryExecutionBinding(), null);

await assert.rejects(
  runner.run({
    proposalSha256: proposalWithHash.proposalSha256,
    sequence: 7,
    sourceSha256s: [sourceSha256, "d".repeat(64)],
    signal: new AbortController().signal,
  }),
  /source SHA-256/,
);
assert.equal(executeCount, 1, "source mismatch는 executor/model 호출 전에 닫혀야 한다");

assert.deepEqual(parseApplicationRoundtripCanaryArgs([
  `--proposal=${proposalWithHash.proposalSha256}`,
  "--sequence=7",
  `--sources=${sourceSha256},${secondSourceSha256}`,
]), {
  proposalSha256: proposalWithHash.proposalSha256,
  sequence: 7,
  sourceSha256s: [sourceSha256, secondSourceSha256],
});

console.log("application roundtrip canary tests: ok");

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
