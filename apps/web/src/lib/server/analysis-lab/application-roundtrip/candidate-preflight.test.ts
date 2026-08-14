import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createApplicationRoundtripCandidatePreflight,
  type ApplicationRoundtripCandidate,
} from "./candidate-preflight";

const bodies = new Map([
  ["form", Buffer.from("form-bytes")],
  ["policy", Buffer.from("policy-bytes")],
  ["announcement", Buffer.from("announcement-bytes")],
]);
const candidates: ApplicationRoundtripCandidate[] = [
  candidate(0, "grant-ready", "ready"),
  candidate(1, "grant-not-applicable", "conditional"),
  candidate(2, "grant-source-missing", "conditional"),
];
const stored: Array<{ sha256: string; bytes: Uint8Array }> = [];

const preflight = createApplicationRoundtripCandidatePreflight({
  now: () => new Date("2026-08-15T00:00:00.000Z"),
  readExecutionProvenance: async () => ({
    gitSha: "a".repeat(40),
    packageRuntimeSha256: "b".repeat(64),
    validatorVersion: "deep-analysis-validator-v10",
  }),
  loadCandidates: async () => ({
    planSha256: "c".repeat(64),
    observationsSha256: "d".repeat(64),
    observedCount: 3,
    candidates,
  }),
  listAttachments: async ({ grantId }) => {
    if (grantId === "grant-ready") {
      return [
        attachment("신청서.hwp", "form"),
        attachment("공통 운영요령.hwpx", "policy"),
      ];
    }
    if (grantId === "grant-not-applicable") {
      return [attachment("모집 공고문.hwp", "announcement")];
    }
    return [{
      filename: "공고문 및 신청서.hwp",
      storageKey: null,
      sha256: null,
      bytes: null,
    }];
  },
  readAttachment: async (storageKey) => {
    const body = bodies.get(storageKey);
    if (!body) throw new Error(`missing fixture: ${storageKey}`);
    return body;
  },
  probeAttachment: async ({ filename, body }) => ({
    detectedFormat: filename.endsWith(".hwpx") ? "hwpx" : "hwp",
    role: filename.includes("신청서") ? "application_form" : "announcement",
    roleConfidence: 0.95,
    fieldCandidateCount: body.byteLength,
    llmCandidateCount: filename.includes("신청서") ? 3 : 0,
    deterministicDecisionCount: filename.includes("신청서") ? 7 : body.byteLength,
  }),
  writeProposal: async (artifact) => { stored.push(artifact); },
});

const result = await preflight.prepare({ finalReceiptSha256: "e".repeat(64) });
assert.equal(stored.length, 1, "proposal은 마지막에 한 번만 저장");
assert.equal(result.proposal.proposalSha256, stored[0]?.sha256);
assert.equal(result.proposal.liveExecutionAuthorized, false);
assert.equal(result.proposal.candidates[0]?.status, "ready");
assert.deepEqual(result.proposal.candidates[0]?.selectedSourceSha256s, [sha(bodies.get("form")!)]);
assert.equal(result.proposal.candidates[1]?.status, "not_applicable");
assert.equal(result.proposal.candidates[2]?.status, "source_unavailable");
assert.deepEqual(result.proposal.executionTargets.map((target) => target.grantId), ["grant-ready"]);
assert.equal(result.proposal.executionTargets[0]?.deepReceiptSha256, "0".repeat(64));
assert.equal(result.proposal.executionTargets[0]?.llmCandidateCount, 3);

console.log("application roundtrip candidate preflight tests: ok");

function candidate(
  sequence: number,
  grantId: string,
  matchingReadiness: "ready" | "conditional",
): ApplicationRoundtripCandidate {
  return {
    sequence,
    grantId,
    source: "bizinfo",
    sourceId: `source-${sequence}`,
    title: `공고 ${sequence}`,
    matchingReadiness,
    deepReceiptSha256: String(sequence).repeat(64),
    deepRunArtifactSha256: String(sequence + 3).repeat(64),
  };
}

function attachment(filename: string, storageKey: string) {
  const body = bodies.get(storageKey)!;
  return {
    filename,
    storageKey,
    sha256: sha(body),
    bytes: body.byteLength,
  };
}

function sha(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
