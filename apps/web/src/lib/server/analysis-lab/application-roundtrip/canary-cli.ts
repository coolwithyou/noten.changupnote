import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "@/lib/server/db/client";
import { loadAnalysisLabEnv } from "@/lib/server/loadMonorepoEnv";
import {
  applicationRoundtripCanaryReceiptPath,
  runApprovedApplicationRoundtripCanary,
} from "./canary-production";
import type { ApplicationRoundtripCanaryCohortVerdict } from "./canary";

const SHA256 = /^[a-f0-9]{64}$/u;
const USAGE = "pnpm lab:roundtrip:canary -- --proposal=<sha256> --sequence=<n> --sources=<sha256,sha256,...>";

export function parseApplicationRoundtripCanaryArgs(argv: readonly string[]): {
  proposalSha256: string;
  sequence: number;
  sourceSha256s: readonly string[];
} {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length !== 3) throw new Error(USAGE);
  const values = new Map(normalized.map((item) => {
    const split = item.indexOf("=");
    if (split < 0) throw new Error(USAGE);
    return [item.slice(0, split), item.slice(split + 1)];
  }));
  const proposalSha256 = values.get("--proposal") ?? "";
  const sourceSha256s = (values.get("--sources") ?? "").split(",");
  const sequence = Number(values.get("--sequence"));
  if (
    values.size !== 3
    || !SHA256.test(proposalSha256)
    || sourceSha256s.length === 0
    || sourceSha256s.some((sourceSha256) => !SHA256.test(sourceSha256))
    || new Set(sourceSha256s).size !== sourceSha256s.length
    || !Number.isSafeInteger(sequence)
    || sequence < 0
  ) throw new Error(USAGE);
  return { proposalSha256, sequence, sourceSha256s };
}

export function applicationRoundtripCanaryExitCode(
  cohortVerdict: ApplicationRoundtripCanaryCohortVerdict,
): 0 | 2 {
  return cohortVerdict === "CONTINUE" ? 0 : 2;
}

async function main(argv: readonly string[]): Promise<0 | 2> {
  const parsed = parseApplicationRoundtripCanaryArgs(argv);
  loadAnalysisLabEnv();
  const controller = new AbortController();
  const onSigint = () => controller.abort(new Error("SIGINT로 Kordoc canary가 중단됐습니다."));
  const onSigterm = () => controller.abort(new Error("SIGTERM으로 Kordoc canary가 중단됐습니다."));
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const result = await runApprovedApplicationRoundtripCanary({ ...parsed, signal: controller.signal });
    console.log(JSON.stringify({
      kind: "application-roundtrip-canary",
      status: result.status,
      targetDisposition: result.targetDisposition,
      cohortVerdict: result.cohortVerdict,
      reasonCodes: result.receipt.reasonCodes,
      receiptSha256: result.receipt.receiptSha256,
      receiptPath: applicationRoundtripCanaryReceiptPath(result.receipt.receiptSha256),
      proposalSha256: result.receipt.proposalSha256,
      sequence: result.receipt.sequence,
      grantId: result.receipt.grantId,
      sourceSha256s: result.receipt.sourceSha256s,
      runId: result.receipt.runId,
      runArtifactPath: result.receipt.runArtifactPath,
      failureCode: result.receipt.failureCode,
    }, null, 2));
    return applicationRoundtripCanaryExitCode(result.cohortVerdict);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await closeCunoteDb();
  }
}

const argvEntry = process.argv[1];
if (argvEntry && import.meta.url === pathToFileURL(argvEntry).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error("[lab:roundtrip:canary] 실행 중단:", error instanceof Error ? error.message : error);
      process.exitCode = 2;
    });
}
