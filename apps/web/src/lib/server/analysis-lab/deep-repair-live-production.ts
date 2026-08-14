import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/features/dev/analysis-lab/contract";
import {
  executePreparedLabAnalysis,
  prepareLabAnalysis,
} from "./analyze";
import { createDeepRepairLiveDbLeaseClient } from "./deep-repair-live-db-runtime";
import {
  createDeepRepairLiveExperiment,
  type DeepRepairCanaryResult,
  type DeepRepairLiveStoredArtifact,
  type DeepRepairLiveTargetExecutor,
} from "./deep-repair-live-experiment";
import { createDeepRepairLiveFilesystemRepository } from "./deep-repair-live-fs";
import { createDeepRepairLiveRuntimeAuthority } from "./deep-repair-live-runtime";
import { verifyCurrentDeepRepairOperationalEvidence } from "./deep-repair-operational-guard";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";
import {
  findMonorepoRoot,
  labRunFilePath,
} from "./run-store";

const LAB_RUN_LOGICAL_PATH = /^spike-out\/analysis-lab\/[A-Za-z0-9._-]*__[A-Za-z0-9._-]*\/run-[0-9TZ.\-]{10,40}(?:-[a-f0-9]{4,8})?\.json$/;

const repository = createDeepRepairLiveFilesystemRepository();
const experiment = createDeepRepairLiveExperiment({
  repository,
  targetExecutor: createExactDeepPrimaryTargetExecutor(),
  runtimeAuthority: createDeepRepairLiveRuntimeAuthority(createDeepRepairLiveDbLeaseClient()),
  readRunArtifact: readExactLabRunArtifact,
  verifyOperationalEvidence: verifyCurrentDeepRepairOperationalEvidence,
  currentExecutionProvenance: readCurrentDeepRepairExecutionProvenance,
});

/** Gate R의 exact authority가 봉인한 deep-primary 한 건만 실행한다. */
export function runApprovedCanary(input: {
  readonly authorityId: string;
  readonly signal: AbortSignal;
}): Promise<DeepRepairCanaryResult> {
  return experiment.runApprovedCanary(input);
}

function createExactDeepPrimaryTargetExecutor(): DeepRepairLiveTargetExecutor {
  return {
    async prepare(input) {
      input.signal.throwIfAborted();
      if (
        input.transport !== "claude-cli"
        || input.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION
        || input.model.trim() === ""
      ) {
        throw new Error("현재 deep-primary 실행 계약과 plan policy가 일치하지 않습니다.");
      }

      const prepared = await prepareLabAnalysis(input.grantId);
      const binding = Object.freeze({
        grantId: prepared.grant.id,
        inputSha256: prepared.input.inputSha256,
        attachmentManifestSha256: prepared.input.attachmentManifestSha256,
      });

      return {
        binding,
        async execute({ signal }) {
          signal.throwIfAborted();
          const run = await executePreparedLabAnalysis(prepared, {
            transport: "claude-cli",
            model: input.model,
            signal,
          });
          const absolutePath = labRunFilePath(run.source, run.sourceId, run.runId);
          const artifactPath = toLogicalLabRunPath(absolutePath);
          const stored = await readExactLabRunArtifact(artifactPath);
          if (stored === null || stored.path !== artifactPath) {
            throw new Error("저장 직후 exact LabRun artifact를 안전한 경로로 다시 읽지 못했습니다.");
          }
          return { artifactPath };
        },
      };
    },
  };
}

function toLogicalLabRunPath(absolutePath: string): string {
  const root = findMonorepoRoot();
  const logicalPath = relative(root, absolutePath).split(sep).join("/");
  if (!isAllowedLabRunLogicalPath(logicalPath)) {
    throw new Error("LabRun 저장 경로가 허용된 repo-relative 범위를 벗어났습니다.");
  }
  return logicalPath;
}

async function readExactLabRunArtifact(path: string): Promise<DeepRepairLiveStoredArtifact | null> {
  if (!isAllowedLabRunLogicalPath(path)) return null;
  const repositoryRoot = findMonorepoRoot();
  const analysisRoot = join(repositoryRoot, "spike-out", "analysis-lab");
  const candidate = resolve(repositoryRoot, path);
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      realpath(analysisRoot),
      realpath(candidate),
    ]);
    if (!isWithin(canonicalRoot, canonicalCandidate)) return null;
    const canonicalRelative = relative(canonicalRoot, canonicalCandidate).split(sep).join("/");
    if (canonicalRelative.split("/")[0] === "experiments") return null;
    return { path, bytes: await readFile(canonicalCandidate) };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isAllowedLabRunLogicalPath(path: string): boolean {
  if (path.includes("\\") || !LAB_RUN_LOGICAL_PATH.test(path)) return false;
  const segments = path.split("/");
  if (segments[2] === "experiments") return false;
  return segments.length === 4
    && segments[0] === "spike-out"
    && segments[1] === "analysis-lab"
    && segments.every((segment) => segment !== "." && segment !== "..");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
