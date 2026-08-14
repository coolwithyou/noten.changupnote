import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { DeepRepairRecoveryError } from "./deep-repair-recovery";
import {
  inspectDeepRepairRecovery,
  recoverApprovedDeepRepairAttempt,
} from "./deep-repair-recovery-production";

const INSPECT_OPTION = /^--inspect=([a-f0-9]{64})$/u;
const APPROVAL_OPTION = /^--approval=([a-f0-9]{64})$/u;
const USAGE = [
  "pnpm lab:experiment:recover -- --inspect=<64자리 소문자 SHA-256>",
  "       pnpm lab:experiment:recover -- --approval=<64자리 소문자 SHA-256>",
  "       pnpm lab:experiment:recover -- --help",
].join("\n");

export type DeepRepairRecoveryCliOperation = "inspect" | "recover";

export type DeepRepairRecoveryCliArgs =
  | { readonly kind: "help" }
  | { readonly kind: "inspect"; readonly authorityId: string }
  | { readonly kind: "recover"; readonly approvalId: string };

export class DeepRepairRecoveryCliUsageError extends Error {
  constructor() {
    super(
      `허용 인자는 --inspect=<64자리 소문자 SHA-256>, --approval=<64자리 소문자 SHA-256>, --help 중 하나뿐입니다.\n${USAGE}`,
    );
    this.name = "DeepRepairRecoveryCliUsageError";
  }
}

export class DeepRepairRecoveryCliCleanupError extends Error {
  constructor(
    readonly operation: DeepRepairRecoveryCliOperation,
    cleanupError: unknown,
  ) {
    super(
      operation === "recover"
        ? "복구 결과가 commit됐을 수 있지만 DB 종료 확인에 실패했습니다. inspect로 상태를 다시 확인하세요."
        : "읽기 전용 inspect 뒤 DB 종료 확인에 실패했습니다.",
      { cause: cleanupError },
    );
    this.name = "DeepRepairRecoveryCliCleanupError";
  }
}

export function parseDeepRepairRecoveryCliArgs(
  argv: readonly string[],
): DeepRepairRecoveryCliArgs {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length !== 1) throw new DeepRepairRecoveryCliUsageError();
  if (normalized[0] === "--help") return { kind: "help" };
  const inspectMatch = INSPECT_OPTION.exec(normalized[0] ?? "");
  if (inspectMatch) return { kind: "inspect", authorityId: inspectMatch[1]! };
  const approvalMatch = APPROVAL_OPTION.exec(normalized[0] ?? "");
  if (approvalMatch) return { kind: "recover", approvalId: approvalMatch[1]! };
  throw new DeepRepairRecoveryCliUsageError();
}

export function resolveDeepRepairRecoveryCliCleanupFailure(input: {
  readonly primaryError: unknown | null;
  readonly operation: DeepRepairRecoveryCliOperation;
  readonly cleanupError: unknown;
}): DeepRepairRecoveryCliCleanupError | null {
  if (input.primaryError !== null) {
    if (input.primaryError instanceof Error && input.primaryError.cause === undefined) {
      input.primaryError.cause = input.cleanupError;
    }
    return null;
  }
  return new DeepRepairRecoveryCliCleanupError(input.operation, input.cleanupError);
}

export function deepRepairRecoveryCliErrorExitCode(error: unknown): 1 | 2 {
  if (error instanceof DeepRepairRecoveryCliCleanupError) {
    return error.operation === "recover" ? 2 : 1;
  }
  if (
    error instanceof DeepRepairRecoveryError
    && (
      error.code === "runtime_recovery_failed"
      || error.code === "receipt_commit_failed"
      || error.code === "attempt_conflict"
    )
  ) {
    return 2;
  }
  return 1;
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseDeepRepairRecoveryCliArgs(argv);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return;
  }

  loadAnalysisLabEnv();
  const controller = new AbortController();
  const operation = parsed.kind;
  let primaryError: unknown | null = null;
  const abortFromSignal = (name: "SIGINT" | "SIGTERM") => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`${name}으로 attempt recovery가 중단됐습니다.`));
    }
  };
  const onSigint = () => abortFromSignal("SIGINT");
  const onSigterm = () => abortFromSignal("SIGTERM");

  if (operation === "recover") {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }
  try {
    const result = parsed.kind === "inspect"
      ? await inspectDeepRepairRecovery({ authorityId: parsed.authorityId })
      : await recoverApprovedDeepRepairAttempt({
          approvalId: parsed.approvalId,
          signal: controller.signal,
        });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (operation === "recover") {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
    try {
      await closeCunoteDb();
    } catch (cleanupError) {
      const failure = resolveDeepRepairRecoveryCliCleanupFailure({
        primaryError,
        operation,
        cleanupError,
      });
      if (failure) throw failure;
    }
  }
}

const argvEntry = process.argv[1];
if (argvEntry !== undefined && import.meta.url === pathToFileURL(argvEntry).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const exitCode = deepRepairRecoveryCliErrorExitCode(error);
    const label = error instanceof DeepRepairRecoveryCliCleanupError
      ? error.operation === "recover"
        ? "복구 뒤 DB 정리 실패"
        : "inspect 뒤 DB 정리 실패"
      : error instanceof DeepRepairRecoveryError
        ? `복구 거부 (${error.code})`
        : "복구 실패";
    console.error(
      `[lab:experiment:recover] ${label}:`,
      error instanceof Error ? error.message : error,
    );
    process.exitCode = exitCode;
  });
}
