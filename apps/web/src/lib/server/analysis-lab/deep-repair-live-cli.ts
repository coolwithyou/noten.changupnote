import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import type { DeepRepairCanaryResult } from "./deep-repair-live-experiment";
import { DeepRepairLiveExecutionError } from "./deep-repair-live-experiment";
import { runApprovedCanary } from "./deep-repair-live-production";

const AUTHORITY_OPTION = /^--authority=([a-f0-9]{64})$/;
const USAGE = "pnpm lab:experiment -- --authority=<64자리 소문자 SHA-256>\n       pnpm lab:experiment -- --help";

export type DeepRepairLiveCliArgs =
  | { readonly kind: "help" }
  | { readonly kind: "execute"; readonly authorityId: string };

export class DeepRepairLiveCliUsageError extends Error {
  constructor() {
    super(`허용 인자는 --authority=<64자리 소문자 SHA-256> 또는 --help 하나뿐입니다.\n${USAGE}`);
    this.name = "DeepRepairLiveCliUsageError";
  }
}

export function parseDeepRepairLiveCliArgs(argv: readonly string[]): DeepRepairLiveCliArgs {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length !== 1) throw new DeepRepairLiveCliUsageError();
  if (normalized[0] === "--help") return { kind: "help" };
  const match = AUTHORITY_OPTION.exec(normalized[0] ?? "");
  if (!match) throw new DeepRepairLiveCliUsageError();
  return { kind: "execute", authorityId: match[1]! };
}

export function deepRepairLiveCliExitCode(
  result: Pick<DeepRepairCanaryResult, "kind">,
): 0 | 2 {
  return result.kind === "ambiguous" ? 2 : 0;
}

export function deepRepairLiveCliErrorExitCode(error: unknown): 1 | 2 {
  return error instanceof DeepRepairLiveExecutionError
    && (!error.noModelStarted || error.code === "start_commit_ambiguous")
    ? 2
    : 1;
}

export function resolveDeepRepairLiveCliCleanupFailure(input: {
  readonly primaryError: unknown | null;
  readonly executionRequested: boolean;
  readonly cleanupError: unknown;
}): DeepRepairLiveExecutionError | null {
  if (input.primaryError !== null) {
    if (input.primaryError instanceof Error && input.primaryError.cause === undefined) {
      input.primaryError.cause = input.cleanupError;
    }
    return null;
  }
  return new DeepRepairLiveExecutionError(
    "cli_cleanup_failed",
    `CLI DB 정리에 실패했습니다: ${input.cleanupError instanceof Error ? input.cleanupError.message : String(input.cleanupError)}`,
    !input.executionRequested,
  );
}

async function main(argv: readonly string[]): Promise<0 | 2> {
  const controller = new AbortController();
  let executionRequested = false;
  let primaryError: unknown | null = null;
  const abortFromSignal = (name: "SIGINT" | "SIGTERM") => {
    if (!controller.signal.aborted) controller.abort(new Error(`${name}으로 canary 실행이 중단됐습니다.`));
  };
  const onSigint = () => abortFromSignal("SIGINT");
  const onSigterm = () => abortFromSignal("SIGTERM");

  try {
    const parsed = parseDeepRepairLiveCliArgs(argv);
    if (parsed.kind === "help") {
      console.log(USAGE);
      return 0;
    }

    loadAnalysisLabEnv();
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    executionRequested = true;
    const result = await runApprovedCanary({
      authorityId: parsed.authorityId,
      signal: controller.signal,
    });
    if (result.kind === "ambiguous") {
      console.error("[lab:experiment] 착수 receipt만 확인되어 재실행하지 않습니다. 수동 조사가 필요합니다.");
    } else {
      console.log(JSON.stringify({
        kind: result.kind,
        started: result.started,
        receiptSha256: result.receipt.receiptSha256,
        grantId: result.receipt.target.grantId,
        noticeOutcome: result.receipt.noticeOutcome,
        observedCount: result.receipt.observedCount,
        gateVerdict: result.receipt.gateVerdict,
        nextAction: result.receipt.nextAction,
        promotionEligibility: result.receipt.promotionEligibility,
      }, null, 2));
    }
    return deepRepairLiveCliExitCode(result);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    try {
      await closeCunoteDb();
    } catch (cleanupError) {
      const failure = resolveDeepRepairLiveCliCleanupFailure({
        primaryError,
        executionRequested,
        cleanupError,
      });
      if (failure) throw failure;
    }
  }
}

const argvEntry = process.argv[1];
if (argvEntry !== undefined && import.meta.url === pathToFileURL(argvEntry).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const exitCode = deepRepairLiveCliErrorExitCode(error);
      const label = error instanceof DeepRepairLiveExecutionError
        && error.code === "start_commit_ambiguous"
        ? "착수 receipt 상태 불명"
        : error instanceof DeepRepairLiveExecutionError
            && error.code === "cli_cleanup_failed"
          ? "실행 결과 이후 DB 정리 실패"
        : exitCode === 2
          ? "모델 착수 후 상태 불명"
          : "실행 거부";
      console.error(`[lab:experiment] ${label}:`, error instanceof Error ? error.message : error);
      process.exitCode = exitCode;
    });
}
