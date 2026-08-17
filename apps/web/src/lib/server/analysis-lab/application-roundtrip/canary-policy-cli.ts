import { pathToFileURL } from "node:url";
import {
  applicationRoundtripCanaryPolicyReceiptPath,
  evaluateLegacyApplicationRoundtripCanaryReceipt,
} from "./canary-policy-production";

const SHA256 = /^[a-f0-9]{64}$/u;
const USAGE = "pnpm lab:roundtrip:policy -- --receipt=<legacy-canary-receipt-sha256>";

export function parseApplicationRoundtripCanaryPolicyArgs(argv: readonly string[]): string {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length !== 1 || !normalized[0]?.startsWith("--receipt=")) throw new Error(USAGE);
  const receiptSha256 = normalized[0].slice("--receipt=".length);
  if (!SHA256.test(receiptSha256)) throw new Error(USAGE);
  return receiptSha256;
}

async function main(argv: readonly string[]): Promise<0 | 2> {
  const receipt = await evaluateLegacyApplicationRoundtripCanaryReceipt(
    parseApplicationRoundtripCanaryPolicyArgs(argv),
  );
  console.log(JSON.stringify({
    kind: "application-roundtrip-canary-policy",
    policyVersion: receipt.policyVersion,
    policyGitSha: receipt.policyGitSha,
    originalStatus: receipt.originalStatus,
    targetDisposition: receipt.targetDisposition,
    cohortVerdict: receipt.cohortVerdict,
    reasonCodes: receipt.reasonCodes,
    receiptSha256: receipt.receiptSha256,
    receiptPath: applicationRoundtripCanaryPolicyReceiptPath(receipt.receiptSha256),
    parentCanaryReceiptSha256: receipt.parentCanaryReceiptSha256,
    proposalSha256: receipt.proposalSha256,
    sequence: receipt.sequence,
    grantId: receipt.grantId,
    runId: receipt.runId,
    runArtifactSha256: receipt.runArtifactSha256,
  }, null, 2));
  return receipt.cohortVerdict === "CONTINUE" ? 0 : 2;
}

const argvEntry = process.argv[1];
if (argvEntry && import.meta.url === pathToFileURL(argvEntry).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error("[lab:roundtrip:policy] 판정 중단:", error instanceof Error ? error.message : error);
      process.exitCode = 2;
    });
}
