import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApplicationRoundtripCanaryPolicyRunner } from "./canary-policy";
import { parseApplicationRoundtripCanaryPolicyArgs } from "./canary-policy-cli";

const proposalSha256 = "a".repeat(64);
const sourceSha256 = "b".repeat(64);
const runArtifact = Buffer.from(`${JSON.stringify({
  runId: "roundtrip-2026-08-17T055355.046Z-3c5cfa",
  grantId: "50c2a5a7-b57c-4511-9be9-37558fa3d31b",
  transport: "claude-cli",
  requestedModel: "claude-opus-5",
  failureCode: null,
  error: null,
  sourceCount: 1,
  skippedDocumentCount: 0,
  documents: [{
    sourceSha256,
    error: null,
    fieldPlanning: {
      status: "llm",
      failureCode: null,
      adjudicationStatus: "resolved",
      remainingUnresolvedCandidateCount: 0,
    },
    fieldCoverage: { status: "partial" },
  }],
}, null, 2)}\n`);
const parentBody = {
  schema: "application-roundtrip-canary-receipt-v2" as const,
  proposalSha256,
  sequence: 1,
  grantId: "50c2a5a7-b57c-4511-9be9-37558fa3d31b",
  sourceSha256s: [sourceSha256],
  model: "claude-opus-5" as const,
  transport: "claude-cli" as const,
  status: "partial" as const,
  failureCode: "partial",
  runId: "roundtrip-2026-08-17T055355.046Z-3c5cfa",
  runArtifactPath: "spike-out/analysis-lab/application-roundtrip/kstartup__178289/run/analysis.json",
  runArtifactSha256: rawSha256(runArtifact),
  completedAt: "2026-08-17T05:57:22.538Z",
};
const parent = {
  ...parentBody,
  receiptSha256: canonicalSha256(parentBody),
};
const parentBytes = Buffer.from(`${JSON.stringify(parent, null, 2)}\n`);
let storedPolicyReceipt: Uint8Array | null = null;
const runner = createApplicationRoundtripCanaryPolicyRunner({
  readPolicyGitSha: async () => "c".repeat(40),
  readParentReceipt: async () => parentBytes,
  readRunArtifact: async () => runArtifact,
  async writePolicyReceipt({ bytes }) { storedPolicyReceipt = bytes; },
});

const result = await runner.evaluate(parent.receiptSha256);
assert.equal(result.schema, "application-roundtrip-canary-policy-receipt-v1");
assert.equal(result.policyGitSha, "c".repeat(40));
assert.equal(result.parentCanaryReceiptSha256, parent.receiptSha256);
assert.equal(result.originalStatus, "partial");
assert.equal(result.targetDisposition, "conditional");
assert.equal(result.cohortVerdict, "CONTINUE");
assert.deepEqual(result.reasonCodes, ["structural_warnings_suppressed"]);
assert.ok(storedPolicyReceipt);

const tamperedRunner = createApplicationRoundtripCanaryPolicyRunner({
  readPolicyGitSha: async () => "c".repeat(40),
  readParentReceipt: async () => parentBytes,
  readRunArtifact: async () => Buffer.from("tampered"),
  async writePolicyReceipt() { throw new Error("변조 artifact는 쓰기에 도달하면 안 됩니다."); },
});
await assert.rejects(
  tamperedRunner.evaluate(parent.receiptSha256),
  /exact run artifact bytes/,
);

assert.equal(parseApplicationRoundtripCanaryPolicyArgs([
  `--receipt=${parent.receiptSha256}`,
]), parent.receiptSha256);

console.log("application roundtrip canary policy tests: ok");

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
