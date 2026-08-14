import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "@/lib/server/db/client";
import { loadAnalysisLabEnv } from "@/lib/server/loadMonorepoEnv";
import { prepareCurrentApplicationRoundtripCandidates } from "./candidate-preflight-production";

const USAGE = "pnpm lab:roundtrip:preflight -- --receipt=<terminal-receipt-sha256>";
const SHA256 = /^[a-f0-9]{64}$/u;

export function parseApplicationRoundtripPreflightArgs(argv: readonly string[]): {
  finalReceiptSha256: string;
} {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length !== 1 || !normalized[0]?.startsWith("--receipt=")) {
    throw new Error(USAGE);
  }
  const finalReceiptSha256 = normalized[0].slice("--receipt=".length);
  if (!SHA256.test(finalReceiptSha256)) throw new Error(USAGE);
  return { finalReceiptSha256 };
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseApplicationRoundtripPreflightArgs(argv);
  loadAnalysisLabEnv();
  try {
    const result = await prepareCurrentApplicationRoundtripCandidates(parsed);
    console.log(JSON.stringify({
      kind: "application-roundtrip-proposal-only",
      liveExecutionAuthorized: false,
      engine: result.engine,
      engineVersion: result.engineVersion,
      proposalSha256: result.proposal.proposalSha256,
      proposalPath: result.proposalPath,
      candidateCount: result.proposal.candidates.length,
      executionTargetCount: result.proposal.executionTargets.length,
      statuses: Object.fromEntries(
        ["ready", "not_applicable", "source_unavailable", "review_required"].map((status) => [
          status,
          result.proposal.candidates.filter((candidate) => candidate.status === status).length,
        ]),
      ),
      executionTargets: result.proposal.executionTargets,
    }, null, 2));
  } finally {
    await closeCunoteDb();
  }
}

const argvEntry = process.argv[1];
if (argvEntry && import.meta.url === pathToFileURL(argvEntry).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
