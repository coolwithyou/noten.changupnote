import { pathToFileURL } from "node:url";
import { closeCunoteDb } from "../db/client";
import { prepareCurrentDeepRepairProposal } from "./deep-repair-preparation-production";

const USAGE = "pnpm lab:experiment:prepare -- --series=deep-v18\n       pnpm lab:experiment:prepare -- --help";

export type DeepRepairPreparationCliArgs =
  | { readonly kind: "help" }
  | { readonly kind: "prepare"; readonly seriesId: "deep-v18" };

export class DeepRepairPreparationCliUsageError extends Error {
  constructor() {
    super(`허용 인자는 --series=deep-v18 또는 --help 하나뿐입니다.\n${USAGE}`);
    this.name = "DeepRepairPreparationCliUsageError";
  }
}

export class DeepRepairPreparationCliAmbiguousError extends Error {
  readonly code = "proposal_cleanup_ambiguous" as const;

  constructor(readonly proposalPath: string | null, cleanupError: unknown) {
    super(
      `proposal may exist: ${proposalPath ?? "unknown path"} — DB 종료 확인에 실패해 수동 확인이 필요합니다.`,
      { cause: cleanupError },
    );
    this.name = "DeepRepairPreparationCliAmbiguousError";
  }
}

export function deepRepairPreparationCliErrorExitCode(error: unknown): 1 | 2 {
  return error instanceof DeepRepairPreparationCliAmbiguousError ? 2 : 1;
}

export function resolveDeepRepairPreparationCliCleanupFailure(input: {
  readonly primaryError: unknown | null;
  readonly proposalPath: string | null;
  readonly cleanupError: unknown;
}): DeepRepairPreparationCliAmbiguousError | null {
  if (input.primaryError !== null) {
    if (input.primaryError instanceof Error && input.primaryError.cause === undefined) {
      input.primaryError.cause = input.cleanupError;
    }
    return null;
  }
  return new DeepRepairPreparationCliAmbiguousError(input.proposalPath, input.cleanupError);
}

export function parseDeepRepairPreparationCliArgs(
  argv: readonly string[],
): DeepRepairPreparationCliArgs {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length !== 1) throw new DeepRepairPreparationCliUsageError();
  if (normalized[0] === "--help") return { kind: "help" };
  if (normalized[0] === "--series=deep-v18") {
    return { kind: "prepare", seriesId: "deep-v18" };
  }
  throw new DeepRepairPreparationCliUsageError();
}

async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseDeepRepairPreparationCliArgs(argv);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return;
  }

  let primaryError: unknown = null;
  let proposalPath: string | null = null;
  try {
    const result = await prepareCurrentDeepRepairProposal({ seriesId: parsed.seriesId });
    proposalPath = result.proposalPath;
    console.log(JSON.stringify({
      kind: "proposal-only",
      seriesId: parsed.seriesId,
      liveExecutionAuthorized: false,
      targetCount: result.plan.sequence.length,
      firstTarget: result.plan.sequence[0]?.grantId ?? null,
      planSha256: result.plan.planSha256,
      planArtifactSha256: result.planArtifactSha256,
      manifestSha256: result.plan.manifestSha256,
      proposalSha256: result.proposalSha256,
      proposalPath: result.proposalPath,
      seriesMarkerPath: result.seriesMarkerPath,
      cohortArtifacts: result.cohortArtifacts,
    }, null, 2));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await closeCunoteDb();
    } catch (cleanupError) {
      const failure = resolveDeepRepairPreparationCliCleanupFailure({
        primaryError,
        proposalPath,
        cleanupError,
      });
      if (failure) throw failure;
    }
  }
}

const argvEntry = process.argv[1];
if (argvEntry && import.meta.url === pathToFileURL(argvEntry).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = deepRepairPreparationCliErrorExitCode(error);
  });
}
