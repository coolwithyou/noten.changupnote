import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import {
  DeepRepairAuthorizationError,
  type DeepRepairAuthorityIssuanceResult,
} from "./deep-repair-authorization";
import { issueApprovedDeepRepairAuthority } from "./deep-repair-authorization-production";

const APPROVAL_OPTION = /^--approval=([a-f0-9]{64})$/u;
const USAGE = "pnpm lab:experiment:issue -- --approval=<64자리 소문자 SHA-256>\n       pnpm lab:experiment:issue -- --help";

export type DeepRepairAuthorizationCliArgs =
  | { readonly kind: "help" }
  | { readonly kind: "issue"; readonly approvalId: string };

export class DeepRepairAuthorizationCliUsageError extends Error {
  constructor() {
    super(`허용 인자는 --approval=<64자리 소문자 SHA-256> 또는 --help 하나뿐입니다.\n${USAGE}`);
    this.name = "DeepRepairAuthorizationCliUsageError";
  }
}

export class DeepRepairAuthorizationCliCleanupError extends Error {
  constructor(
    readonly authorityId: string,
    cleanupError: unknown,
  ) {
    super(
      `authority는 immutable commit됐지만 DB 종료 확인에 실패했습니다: ${authorityId}`,
      { cause: cleanupError },
    );
    this.name = "DeepRepairAuthorizationCliCleanupError";
  }
}

export function parseDeepRepairAuthorizationCliArgs(
  argv: readonly string[],
): DeepRepairAuthorizationCliArgs {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length !== 1) throw new DeepRepairAuthorizationCliUsageError();
  if (normalized[0] === "--help") return { kind: "help" };
  const match = APPROVAL_OPTION.exec(normalized[0] ?? "");
  if (!match) throw new DeepRepairAuthorizationCliUsageError();
  return { kind: "issue", approvalId: match[1]! };
}

export function resolveDeepRepairAuthorizationCliCleanupFailure(input: {
  readonly primaryError: unknown | null;
  readonly result: DeepRepairAuthorityIssuanceResult | null;
  readonly cleanupError: unknown;
}): DeepRepairAuthorizationCliCleanupError | null {
  if (input.primaryError !== null) {
    if (input.primaryError instanceof Error && input.primaryError.cause === undefined) {
      input.primaryError.cause = input.cleanupError;
    }
    return null;
  }
  if (input.result === null) return null;
  return new DeepRepairAuthorizationCliCleanupError(
    input.result.authorityId,
    input.cleanupError,
  );
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseDeepRepairAuthorizationCliArgs(argv);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return;
  }

  loadAnalysisLabEnv();
  const controller = new AbortController();
  let primaryError: unknown | null = null;
  let result: DeepRepairAuthorityIssuanceResult | null = null;
  const abortFromSignal = (name: "SIGINT" | "SIGTERM") => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`${name}으로 authority 발급이 중단됐습니다.`));
    }
  };
  const onSigint = () => abortFromSignal("SIGINT");
  const onSigterm = () => abortFromSignal("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    result = await issueApprovedDeepRepairAuthority({
      approvalId: parsed.approvalId,
      signal: controller.signal,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    try {
      await closeCunoteDb();
    } catch (cleanupError) {
      const failure = resolveDeepRepairAuthorizationCliCleanupFailure({
        primaryError,
        result,
        cleanupError,
      });
      if (failure) throw failure;
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

const argvEntry = process.argv[1];
if (argvEntry !== undefined && import.meta.url === pathToFileURL(argvEntry).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const label = error instanceof DeepRepairAuthorizationCliCleanupError
      ? "authority 발급 후 DB 정리 실패"
      : error instanceof DeepRepairAuthorizationError
        ? `발급 거부 (${error.code})`
        : "발급 실패";
    console.error(
      `[lab:experiment:issue] ${label}:`,
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
