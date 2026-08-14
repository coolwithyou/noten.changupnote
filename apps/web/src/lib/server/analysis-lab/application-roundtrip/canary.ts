import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RoundtripFailureCode } from "@/features/dev/analysis-lab/application-roundtrip-contract";
import type { ApplicationRoundtripPreflightProposal } from "./candidate-preflight";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface ApplicationRoundtripCanaryExecutionBinding {
  readonly proposalSha256: string;
  readonly sequence: number;
  readonly grantId: string;
  readonly sourceSha256: string;
  readonly model: "claude-opus-5";
  readonly transport: "claude-cli";
}

const verifiedCanaryExecution = new AsyncLocalStorage<ApplicationRoundtripCanaryExecutionBinding>();

/** transport가 legacy route와 exact proposal-bound canary를 구분하는 read-only capability다. */
export function currentApplicationRoundtripCanaryExecutionBinding(): ApplicationRoundtripCanaryExecutionBinding | null {
  return verifiedCanaryExecution.getStore() ?? null;
}

interface ApplicationRoundtripCanaryDocumentResult {
  readonly sourceSha256: string | null;
  readonly error: string | null;
  readonly fieldPlanningStatus: "llm" | "heuristic_fallback" | "skipped";
  readonly fieldPlanningFailureCode: RoundtripFailureCode | null;
  readonly adjudicationStatus: "not_needed" | "resolved" | "partial" | "failed" | "skipped" | null;
  readonly remainingUnresolvedCandidateCount: number;
  readonly fieldCoverageStatus: "complete" | "partial" | "review_required";
}

export interface ApplicationRoundtripCanaryExecutionResult {
  readonly runId: string;
  readonly artifactPath: string;
  readonly artifactBytes: Uint8Array;
  readonly transport: "api" | "claude-cli";
  readonly requestedModel: string | null;
  readonly failureCode: RoundtripFailureCode | null;
  readonly error: string | null;
  readonly sourceCount: number;
  readonly skippedDocumentCount: number;
  readonly documents: readonly ApplicationRoundtripCanaryDocumentResult[];
}

export interface ApplicationRoundtripCanaryReceipt {
  readonly schema: "application-roundtrip-canary-receipt-v1";
  readonly receiptSha256: string;
  readonly proposalSha256: string;
  readonly sequence: number;
  readonly grantId: string;
  readonly sourceSha256: string;
  readonly model: "claude-opus-5";
  readonly transport: "claude-cli";
  readonly status: "complete" | "partial" | "failed";
  readonly failureCode: string | null;
  readonly runId: string;
  readonly runArtifactPath: string;
  readonly runArtifactSha256: string;
  readonly completedAt: string;
}

interface ApplicationRoundtripCanaryDependencies {
  readonly now: () => Date;
  readonly readProposal: (proposalSha256: string) => Promise<Uint8Array>;
  readonly executeTarget: (input: {
    readonly grantId: string;
    readonly sourceSha256s: readonly string[];
    readonly model: "claude-opus-5";
    readonly signal: AbortSignal;
  }) => Promise<ApplicationRoundtripCanaryExecutionResult>;
  readonly writeReceipt: (artifact: { readonly sha256: string; readonly bytes: Uint8Array }) => Promise<void>;
}

export interface ApplicationRoundtripCanaryRunner {
  run(input: {
    readonly proposalSha256: string;
    readonly sequence: number;
    readonly sourceSha256: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status: ApplicationRoundtripCanaryReceipt["status"];
    readonly receipt: ApplicationRoundtripCanaryReceipt;
  }>;
}

export function createApplicationRoundtripCanaryRunner(
  deps: ApplicationRoundtripCanaryDependencies,
): ApplicationRoundtripCanaryRunner {
  return {
    async run(input) {
      input.signal.throwIfAborted();
      assertSha(input.proposalSha256, "proposal SHA-256");
      assertSha(input.sourceSha256, "source SHA-256");
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
        throw new Error("sequence가 유효하지 않습니다.");
      }

      const proposal = parseProposal(await deps.readProposal(input.proposalSha256), input.proposalSha256);
      const target = proposal.executionTargets.find((candidate) => candidate.sequence === input.sequence);
      if (!target) throw new Error("proposal에 요청한 sequence 실행 대상이 없습니다.");
      if (target.sourceSha256s.length !== 1 || target.sourceSha256s[0] !== input.sourceSha256) {
        throw new Error("proposal의 exact source SHA-256과 실행 요청이 다릅니다.");
      }
      if (proposal.policy.transport !== "claude-cli" || proposal.policy.model !== "claude-opus-5") {
        throw new Error("proposal의 Kordoc transport/model 정책이 현재 canary와 다릅니다.");
      }

      const binding = Object.freeze({
        proposalSha256: input.proposalSha256,
        sequence: input.sequence,
        grantId: target.grantId,
        sourceSha256: input.sourceSha256,
        model: proposal.policy.model,
        transport: proposal.policy.transport,
      });
      const executed = await verifiedCanaryExecution.run(binding, () => deps.executeTarget({
        grantId: target.grantId,
        sourceSha256s: target.sourceSha256s,
        model: proposal.policy.model,
        signal: input.signal,
      }));
      input.signal.throwIfAborted();
      assertExecutionBinding(executed, target.grantId, input.sourceSha256, proposal.policy.model);

      const status = classifyExecution(executed);
      const failureCode = status === "complete"
        ? null
        : executed.failureCode ?? executed.error ?? status;
      const body = {
        schema: "application-roundtrip-canary-receipt-v1" as const,
        proposalSha256: input.proposalSha256,
        sequence: input.sequence,
        grantId: target.grantId,
        sourceSha256: input.sourceSha256,
        model: proposal.policy.model,
        transport: proposal.policy.transport,
        status,
        failureCode,
        runId: executed.runId,
        runArtifactPath: executed.artifactPath,
        runArtifactSha256: rawSha256(executed.artifactBytes),
        completedAt: exactIso(deps.now()),
      };
      const receipt: ApplicationRoundtripCanaryReceipt = Object.freeze({
        ...body,
        receiptSha256: canonicalSha256(body),
      });
      await deps.writeReceipt({
        sha256: receipt.receiptSha256,
        bytes: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
      });
      return { status, receipt };
    },
  };
}

function parseProposal(bytes: Uint8Array, expectedSha256: string): ApplicationRoundtripPreflightProposal {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as ApplicationRoundtripPreflightProposal;
  if (
    value.schema !== "application-roundtrip-candidate-proposal-v1"
    || value.proposalSha256 !== expectedSha256
    || !Array.isArray(value.executionTargets)
  ) {
    throw new Error("Kordoc proposal 형식 또는 경로 binding이 유효하지 않습니다.");
  }
  const { proposalSha256: _storedSha, ...body } = value;
  if (canonicalSha256(body) !== expectedSha256) {
    throw new Error("Kordoc proposal canonical SHA-256이 다릅니다.");
  }
  return value;
}

function assertExecutionBinding(
  executed: ApplicationRoundtripCanaryExecutionResult,
  grantId: string,
  sourceSha256: string,
  model: string,
): void {
  if (!executed.runId || !executed.artifactPath || executed.artifactBytes.byteLength === 0) {
    throw new Error("Kordoc run artifact binding이 비었습니다.");
  }
  if (executed.transport !== "claude-cli" || executed.requestedModel !== model) {
    throw new Error("Kordoc 실행이 승인된 subscription model과 다릅니다.");
  }
  if (
    executed.sourceCount !== 1
    || executed.skippedDocumentCount !== 0
    || executed.documents.length !== 1
    || executed.documents[0]?.sourceSha256 !== sourceSha256
  ) {
    throw new Error(`Kordoc 실행이 ${grantId}의 exact source 한 건과 다릅니다.`);
  }
}

function classifyExecution(
  executed: ApplicationRoundtripCanaryExecutionResult,
): ApplicationRoundtripCanaryReceipt["status"] {
  if (executed.error !== null || executed.failureCode !== null || executed.documents.some((document) => document.error !== null)) {
    return "failed";
  }
  const partial = executed.documents.some((document) =>
    document.fieldPlanningStatus !== "llm"
    || document.fieldPlanningFailureCode !== null
    || document.adjudicationStatus === "partial"
    || document.adjudicationStatus === "failed"
    || document.adjudicationStatus === "skipped"
    || document.remainingUnresolvedCandidateCount > 0
    || document.fieldCoverageStatus !== "complete");
  return partial ? "partial" : "complete";
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

function exactIso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("canary 완료 시각이 유효하지 않습니다.");
  return value.toISOString();
}

function assertSha(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} 형식이 잘못됐습니다.`);
}
