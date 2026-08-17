import { createHash } from "node:crypto";
import type {
  ApplicationRoundtripRun,
  RoundtripFailureCode,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import {
  classifyApplicationRoundtripCanaryExecution,
  type ApplicationRoundtripCanaryCohortVerdict,
  type ApplicationRoundtripCanaryExecutionResult,
  type ApplicationRoundtripCanaryReasonCode,
  type ApplicationRoundtripCanaryTargetDisposition,
} from "./canary";

const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/u;

interface LegacyApplicationRoundtripCanaryReceipt {
  readonly schema: "application-roundtrip-canary-receipt-v2";
  readonly receiptSha256: string;
  readonly proposalSha256: string;
  readonly sequence: number;
  readonly grantId: string;
  readonly sourceSha256s: readonly string[];
  readonly model: "claude-opus-5";
  readonly transport: "claude-cli";
  readonly status: "complete" | "partial" | "failed";
  readonly failureCode: string | null;
  readonly runId: string;
  readonly runArtifactPath: string;
  readonly runArtifactSha256: string;
  readonly completedAt: string;
}

export interface ApplicationRoundtripCanaryPolicyReceipt {
  readonly schema: "application-roundtrip-canary-policy-receipt-v1";
  readonly receiptSha256: string;
  readonly policyVersion: "target-isolation-v1";
  readonly policyGitSha: string;
  readonly parentCanaryReceiptSha256: string;
  readonly proposalSha256: string;
  readonly sequence: number;
  readonly grantId: string;
  readonly sourceSha256s: readonly string[];
  readonly runId: string;
  readonly runArtifactSha256: string;
  readonly originalStatus: "complete" | "partial" | "failed";
  readonly targetDisposition: ApplicationRoundtripCanaryTargetDisposition;
  readonly cohortVerdict: ApplicationRoundtripCanaryCohortVerdict;
  readonly reasonCodes: readonly ApplicationRoundtripCanaryReasonCode[];
}

interface ApplicationRoundtripCanaryPolicyDependencies {
  readonly readPolicyGitSha: () => Promise<string>;
  readonly readParentReceipt: (sha256: string) => Promise<Uint8Array>;
  readonly readRunArtifact: (binding: {
    readonly grantId: string;
    readonly runId: string;
    readonly artifactPath: string;
  }) => Promise<Uint8Array | null>;
  readonly writePolicyReceipt: (artifact: {
    readonly sha256: string;
    readonly bytes: Uint8Array;
  }) => Promise<void>;
}

/** legacy canary 결과를 재실행 없이 현행 target-isolation 정책에 결속한다. */
export function createApplicationRoundtripCanaryPolicyRunner(
  deps: ApplicationRoundtripCanaryPolicyDependencies,
) {
  return {
    async evaluate(parentCanaryReceiptSha256: string): Promise<ApplicationRoundtripCanaryPolicyReceipt> {
      assertSha(parentCanaryReceiptSha256, "parent canary receipt SHA-256");
      const parent = parseLegacyReceipt(
        await deps.readParentReceipt(parentCanaryReceiptSha256),
        parentCanaryReceiptSha256,
      );
      const artifactBytes = await deps.readRunArtifact({
        grantId: parent.grantId,
        runId: parent.runId,
        artifactPath: parent.runArtifactPath,
      });
      if (artifactBytes === null || rawSha256(artifactBytes) !== parent.runArtifactSha256) {
        throw new Error("parent canary receipt의 exact run artifact bytes를 재검증할 수 없습니다.");
      }
      const execution = projectExecution(parent, artifactBytes);
      const decision = classifyApplicationRoundtripCanaryExecution(execution);
      if (decision.status !== parent.status) {
        throw new Error("legacy receipt status와 현재 run artifact 품질 분류가 일치하지 않습니다.");
      }
      const policyGitSha = await deps.readPolicyGitSha();
      if (!FULL_GIT_SHA.test(policyGitSha)) {
        throw new Error("Kordoc policy source git SHA가 full commit이 아닙니다.");
      }
      const body = {
        schema: "application-roundtrip-canary-policy-receipt-v1" as const,
        policyVersion: "target-isolation-v1" as const,
        policyGitSha,
        parentCanaryReceiptSha256,
        proposalSha256: parent.proposalSha256,
        sequence: parent.sequence,
        grantId: parent.grantId,
        sourceSha256s: parent.sourceSha256s,
        runId: parent.runId,
        runArtifactSha256: parent.runArtifactSha256,
        originalStatus: parent.status,
        targetDisposition: decision.targetDisposition,
        cohortVerdict: decision.cohortVerdict,
        reasonCodes: decision.reasonCodes,
      };
      const receipt = Object.freeze({
        ...body,
        receiptSha256: canonicalSha256(body),
      });
      await deps.writePolicyReceipt({
        sha256: receipt.receiptSha256,
        bytes: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
      });
      return receipt;
    },
  };
}

function parseLegacyReceipt(
  bytes: Uint8Array,
  expectedSha256: string,
): LegacyApplicationRoundtripCanaryReceipt {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as LegacyApplicationRoundtripCanaryReceipt;
  if (
    value.schema !== "application-roundtrip-canary-receipt-v2"
    || value.receiptSha256 !== expectedSha256
    || !SHA256.test(value.proposalSha256)
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || !value.grantId
    || !Array.isArray(value.sourceSha256s)
    || value.sourceSha256s.length === 0
    || value.sourceSha256s.some((sha256) => !SHA256.test(sha256))
    || new Set(value.sourceSha256s).size !== value.sourceSha256s.length
    || value.model !== "claude-opus-5"
    || value.transport !== "claude-cli"
    || !["complete", "partial", "failed"].includes(value.status)
    || !value.runId
    || !value.runArtifactPath
    || !SHA256.test(value.runArtifactSha256)
    || !Number.isFinite(Date.parse(value.completedAt))
  ) {
    throw new Error("legacy Kordoc canary receipt 형식이 올바르지 않습니다.");
  }
  const { receiptSha256: _storedSha256, ...body } = value;
  if (canonicalSha256(body) !== expectedSha256) {
    throw new Error("legacy Kordoc canary receipt canonical SHA-256이 다릅니다.");
  }
  return value;
}

function projectExecution(
  parent: LegacyApplicationRoundtripCanaryReceipt,
  artifactBytes: Uint8Array,
): ApplicationRoundtripCanaryExecutionResult {
  const run = JSON.parse(Buffer.from(artifactBytes).toString("utf8")) as ApplicationRoundtripRun;
  if (
    run.runId !== parent.runId
    || run.grantId !== parent.grantId
    || run.transport !== parent.transport
    || run.requestedModel !== parent.model
    || !Array.isArray(run.documents)
  ) {
    throw new Error("legacy receipt와 Kordoc run artifact provenance가 다릅니다.");
  }
  const actualSourceSha256s = run.documents.flatMap((document) =>
    document.sourceSha256 ? [document.sourceSha256] : []);
  if (
    (run.sourceCount ?? run.documents.length) !== parent.sourceSha256s.length
    || (run.skippedDocumentCount ?? 0) !== 0
    || run.documents.length !== parent.sourceSha256s.length
    || !sameSet(actualSourceSha256s, parent.sourceSha256s)
  ) {
    throw new Error("legacy receipt와 Kordoc run artifact의 exact source 집합이 다릅니다.");
  }
  return {
    runId: run.runId,
    artifactPath: parent.runArtifactPath,
    artifactBytes,
    transport: run.transport ?? "api",
    requestedModel: run.requestedModel ?? null,
    failureCode: (run.failureCode ?? null) as RoundtripFailureCode | null,
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
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function rawSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function assertSha(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} 형식이 잘못됐습니다.`);
}
