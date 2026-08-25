import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import {
  approveAuthoringGuideSourceRecovery,
  runApprovedAuthoringGuideSourceRecovery,
} from "./authoring-guide-source-recovery-execution-production";

const SHA256 = /^[a-f0-9]{64}$/u;
const GRANT_USAGE =
  "pnpm lab:authoring-guide:recovery:grant -- --manifest=<sha256> --approved-by=<actor>";
const RUN_USAGE = "pnpm lab:authoring-guide:recovery:run -- --grant=<sha256>";

export type AuthoringGuideSourceRecoveryExecutionCliArgs =
  | { readonly command: "grant"; readonly manifestSha256: string; readonly approvedBy: string }
  | { readonly command: "run"; readonly grantSha256: string };

export function parseAuthoringGuideSourceRecoveryExecutionCliArgs(
  argv: readonly string[],
): AuthoringGuideSourceRecoveryExecutionCliArgs {
  const command = argv[0];
  const args = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
  if (command === "grant") {
    const manifestSha256 = option(args, "--manifest");
    const approvedBy = option(args, "--approved-by");
    if (args.length !== 2 || !SHA256.test(manifestSha256) || approvedBy.trim() === "") {
      throw new Error(GRANT_USAGE);
    }
    return Object.freeze({ command, manifestSha256, approvedBy: approvedBy.trim() });
  }
  if (command === "run") {
    const grantSha256 = option(args, "--grant");
    if (args.length !== 1 || !SHA256.test(grantSha256)) throw new Error(RUN_USAGE);
    return Object.freeze({ command, grantSha256 });
  }
  throw new Error(`${GRANT_USAGE}\n${RUN_USAGE}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  loadMonorepoEnv();
  const args = parseAuthoringGuideSourceRecoveryExecutionCliArgs(argv);
  if (args.command === "grant") {
    const artifact = await approveAuthoringGuideSourceRecovery({
      manifestSha256: args.manifestSha256,
      approvedBy: args.approvedBy,
    });
    process.stdout.write(`${JSON.stringify({
      status: "GRANTED",
      manifestSha256: args.manifestSha256,
      maxRounds: 3,
      externalLlmCallsAuthorized: false,
      analysisJobsAuthorized: false,
      promotionAuthorized: false,
      artifact,
    }, null, 2)}\n`);
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new Error("source recovery 실행이 사용자 신호로 중단됐습니다."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await runApprovedAuthoringGuideSourceRecovery({
      grantSha256: args.grantSha256,
      signal: controller.signal,
      onRound(round) {
        process.stdout.write(`${JSON.stringify({
          status: "ROUND_COMPLETE",
          ...round,
          externalLlmCalls: 0,
          analysisJobsEnqueued: 0,
        })}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({
      status: result.receipt.stopReason === "completed" ? "COMPLETE" : "PARTIAL",
      summary: result.receipt.summary,
      reclassification: result.receipt.reclassification,
      receipt: {
        sha256: result.receiptSha256,
        path: result.receiptPath,
      },
    }, null, 2)}\n`);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await closeCunoteDb();
  }
}

function option(args: readonly string[], name: string): string {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
