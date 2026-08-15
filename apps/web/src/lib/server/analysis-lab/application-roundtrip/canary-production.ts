import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { getCunoteDb } from "@/lib/server/db/client";
import { readDeepAnalysisRuntimeAdmissionSnapshot } from "@/lib/server/deep-analysis/runtimeControl";
import { writeImmutableBytesAtomic } from "../immutable-artifact-fs";
import { buildClaudeCliFetch } from "../claude-cli-transport";
import { createDeepRepairLiveDbLeaseClient } from "../deep-repair-live-db-runtime";
import { createDeepRepairLiveRuntimeAuthority } from "../deep-repair-live-runtime";
import { captureCurrentDeepRepairOperationalEvidence } from "../deep-repair-operational-guard";
import { findMonorepoRoot } from "../run-store";
import { runApplicationRoundtripAnalysis } from "./analyze";
import {
  createApplicationRoundtripCanaryRunner,
  type ApplicationRoundtripCanaryExecutionResult,
} from "./canary";
import { buildLabApplicationRoundtripOptions } from "./lab-runner";
import { readRoundtripRunArtifacts } from "./store";

const repositoryRoot = findMonorepoRoot();
const roundtripRoot = join(repositoryRoot, "spike-out", "analysis-lab", "application-roundtrip");
const proposalRoot = join(roundtripRoot, "proposals");
const receiptRoot = join(roundtripRoot, "canary-receipts");
const runtimeAuthority = createDeepRepairLiveRuntimeAuthority(createDeepRepairLiveDbLeaseClient());

const runner = createApplicationRoundtripCanaryRunner({
  now: () => new Date(),
  readProposal: (proposalSha256) => readFile(join(proposalRoot, `${proposalSha256}.json`)),
  executeTarget: executeExactTarget,
  async writeReceipt({ sha256, bytes }) {
    await mkdir(receiptRoot, { recursive: true });
    await writeImmutableBytesAtomic(join(receiptRoot, `${sha256}.json`), bytes);
  },
});

/** 사용자가 승인한 proposal/sequence/source 한 건만 Kordoc으로 실행한다. */
export function runApprovedApplicationRoundtripCanary(input: {
  readonly proposalSha256: string;
  readonly sequence: number;
  readonly sourceSha256s: readonly string[];
  readonly signal: AbortSignal;
}) {
  return runner.run(input);
}

async function executeExactTarget(input: {
  readonly grantId: string;
  readonly sourceSha256s: readonly string[];
  readonly model: "claude-opus-5";
  readonly signal: AbortSignal;
}): Promise<ApplicationRoundtripCanaryExecutionResult> {
  input.signal.throwIfAborted();
  await captureCurrentDeepRepairOperationalEvidence(input.signal);
  const control = await readDeepAnalysisRuntimeAdmissionSnapshot(getCunoteDb());
  if (
    control.mode !== "paused"
    || control.localOwnerId !== null
    || control.localLeaseExpiresAt !== null
    || control.activeDeepLeases !== 0
    || control.activeApplicationLeases !== 0
  ) {
    throw new Error("현재 runtime/운영 queue가 Kordoc 단건 canary를 시작할 안전 상태가 아닙니다.");
  }

  return runtimeAuthority.runExclusive({
    ownerId: randomUUID(),
    expectedGeneration: control.generation,
    signal: input.signal,
  }, async (executionSignal) => {
    executionSignal.throwIfAborted();
    const fetchImpl = buildClaudeCliFetch({
      schedulerKey: `application-roundtrip-canary:${input.grantId}`,
      externalSignal: executionSignal,
    });
    const options = buildLabApplicationRoundtripOptions({
      transport: "claude-cli",
      apiKey: "subscription",
      fetchImpl,
      model: input.model,
    });
    const run = await runApplicationRoundtripAnalysis(input.grantId, {
      ...options,
      candidateConcurrency: 1,
      sourceSha256s: input.sourceSha256s,
    });
    executionSignal.throwIfAborted();
    const artifacts = await readRoundtripRunArtifacts(input.grantId, run.runId);
    if (!artifacts) throw new Error("저장 직후 exact Kordoc run artifact를 읽지 못했습니다.");
    const artifactPath = relative(repositoryRoot, join(artifacts.dir, "analysis.json")).split(sep).join("/");
    const artifactBytes = await readFile(join(artifacts.dir, "analysis.json"));
    const parsed = JSON.parse(artifactBytes.toString("utf8")) as { runId?: unknown; grantId?: unknown };
    if (parsed.runId !== run.runId || parsed.grantId !== input.grantId) {
      throw new Error("저장된 Kordoc run artifact가 실행 결과와 다릅니다.");
    }
    return {
      runId: run.runId,
      artifactPath,
      artifactBytes,
      transport: run.transport ?? "api",
      requestedModel: run.requestedModel ?? null,
      failureCode: run.failureCode ?? null,
      error: run.error,
      sourceCount: run.sourceCount ?? run.documents.length,
      skippedDocumentCount: run.skippedDocumentCount ?? 0,
      documents: run.documents.map((document) => ({
        sourceSha256: document.sourceSha256,
        error: document.error,
        fieldPlanningStatus: document.fieldPlanning.status,
        fieldPlanningFailureCode: document.fieldPlanning.failureCode ?? null,
        adjudicationStatus: document.fieldPlanning.adjudicationStatus ?? null,
        remainingUnresolvedCandidateCount: document.fieldPlanning.remainingUnresolvedCandidateCount ?? 0,
        fieldCoverageStatus: document.fieldCoverage.status,
      })),
    };
  });
}

export function applicationRoundtripCanaryReceiptPath(receiptSha256: string): string {
  return relative(repositoryRoot, join(receiptRoot, `${receiptSha256}.json`)).split(sep).join("/");
}
