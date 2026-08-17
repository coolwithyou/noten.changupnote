import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createApplicationRoundtripReleaseAdmission,
  type ApplicationRoundtripReceiptArtifact,
} from "./release-admission";

const grantId = "00000000-0000-4000-8000-000000000991";
const deepReceiptSha256 = "d".repeat(64);
const sourceSha256 = "a".repeat(64);
const runArtifactSha256 = "b".repeat(64);
const proposalGitSha = "c".repeat(40);
const policyGitSha = "e".repeat(40);

const proposalBody = {
  schema: "application-roundtrip-candidate-proposal-v1" as const,
  preparedAt: "2026-08-17T12:00:00.000Z",
  provenance: {
    gitSha: proposalGitSha,
    packageRuntimeSha256: "f".repeat(64),
    validatorVersion: "analysis-lab-validator-v1",
  },
  deepExperiment: {
    planSha256: "1".repeat(64),
    terminalReceiptSha256: "2".repeat(64),
    observationsSha256: "3".repeat(64),
    observedCount: 10,
  },
  policy: {
    transport: "claude-cli" as const,
    model: "claude-opus-5" as const,
    candidateSelection: "publishable-ready-or-conditional-v1" as const,
    fieldTriage: "ambiguous-only-v1" as const,
    maxCandidates: 10 as const,
  },
  candidates: [],
  executionTargets: [{
    sequence: 2,
    grantId,
    deepReceiptSha256,
    sourceSha256s: [sourceSha256],
    fieldCandidateCount: 1,
    llmCandidateCount: 1,
    deterministicDecisionCount: 0,
  }],
  liveExecutionAuthorized: false as const,
};
const proposal = {
  ...proposalBody,
  proposalSha256: canonicalSha256(proposalBody),
};

const directBody = {
  schema: "application-roundtrip-canary-receipt-v3" as const,
  proposalSha256: proposal.proposalSha256,
  sequence: 2,
  grantId,
  sourceSha256s: [sourceSha256],
  model: "claude-opus-5" as const,
  transport: "claude-cli" as const,
  status: "complete" as const,
  targetDisposition: "ready" as const,
  cohortVerdict: "CONTINUE" as const,
  reasonCodes: ["ready"] as const,
  failureCode: null,
  runId: "roundtrip-2026-08-17T120001.000Z-abcdef",
  runArtifactPath: "spike-out/analysis-lab/application-roundtrip/test/run/analysis.json",
  runArtifactSha256,
  completedAt: "2026-08-17T12:00:02.000Z",
};
const direct = artifact({
  ...directBody,
  receiptSha256: canonicalSha256(directBody),
});

const directAdmission = createApplicationRoundtripReleaseAdmission({
  listCanaryReceipts: async () => [direct],
  listPolicyReceipts: async () => [],
  readProposal: async () => bytes(proposal),
  isGitAncestor: async (gitSha) => gitSha === proposalGitSha,
});
const admitted = await directAdmission.admit({ grantId, deepReceiptSha256 });
assert.ok(admitted);
assert.equal(admitted.receiptSchema, "application-roundtrip-canary-receipt-v3");
assert.equal(admitted.admissionReceiptSha256, direct.sha256);
assert.equal(admitted.targetDisposition, "ready");
assert.equal(admitted.cohortVerdict, "CONTINUE");
assert.equal(admitted.deepReceiptSha256, deepReceiptSha256);

const heldBody = {
  ...directBody,
  status: "partial" as const,
  targetDisposition: "held" as const,
  reasonCodes: ["unresolved_candidates"] as const,
};
const held = artifact({ ...heldBody, receiptSha256: canonicalSha256(heldBody) });
const heldAdmission = createApplicationRoundtripReleaseAdmission({
  listCanaryReceipts: async () => [held],
  listPolicyReceipts: async () => [],
  readProposal: async () => bytes(proposal),
  isGitAncestor: async () => true,
});
await assert.rejects(
  heldAdmission.admit({ grantId, deepReceiptSha256 }),
  /release 대상이 아닙니다.*held\/CONTINUE/,
  "held target은 다음 sequence 진행과 별개로 release admission에서 제외돼야 한다",
);

const legacyBody = {
  schema: "application-roundtrip-canary-receipt-v2" as const,
  proposalSha256: proposal.proposalSha256,
  sequence: 2,
  grantId,
  sourceSha256s: [sourceSha256],
  model: "claude-opus-5" as const,
  transport: "claude-cli" as const,
  status: "partial" as const,
  failureCode: "partial",
  runId: directBody.runId,
  runArtifactPath: directBody.runArtifactPath,
  runArtifactSha256,
  completedAt: directBody.completedAt,
};
const legacy = artifact({ ...legacyBody, receiptSha256: canonicalSha256(legacyBody) });
const policyBody = {
  schema: "application-roundtrip-canary-policy-receipt-v1" as const,
  policyVersion: "target-isolation-v1" as const,
  policyGitSha,
  parentCanaryReceiptSha256: legacy.sha256,
  proposalSha256: proposal.proposalSha256,
  sequence: 2,
  grantId,
  sourceSha256s: [sourceSha256],
  runId: legacyBody.runId,
  runArtifactSha256,
  originalStatus: "partial" as const,
  targetDisposition: "conditional" as const,
  cohortVerdict: "CONTINUE" as const,
  reasonCodes: ["structural_warnings_suppressed"] as const,
};
const policy = artifact({ ...policyBody, receiptSha256: canonicalSha256(policyBody) });
const policyAdmission = createApplicationRoundtripReleaseAdmission({
  listCanaryReceipts: async () => [legacy],
  listPolicyReceipts: async () => [policy],
  readProposal: async () => bytes(proposal),
  isGitAncestor: async (gitSha) => gitSha === proposalGitSha || gitSha === policyGitSha,
});
const policyAdmitted = await policyAdmission.admit({ grantId, deepReceiptSha256 });
assert.ok(policyAdmitted);
assert.equal(policyAdmitted.receiptSchema, "application-roundtrip-canary-policy-receipt-v1");
assert.equal(policyAdmitted.admissionReceiptSha256, policy.sha256);
assert.equal(policyAdmitted.canaryReceiptSha256, legacy.sha256);
assert.equal(policyAdmitted.policyGitSha, policyGitSha);
assert.equal(policyAdmitted.targetDisposition, "conditional");

console.log("application roundtrip release admission tests: ok");

function artifact(value: { receiptSha256: string }): ApplicationRoundtripReceiptArtifact {
  return { sha256: value.receiptSha256, bytes: bytes(value) };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
