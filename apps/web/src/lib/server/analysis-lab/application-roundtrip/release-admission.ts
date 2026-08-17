import { createHash } from "node:crypto";
import type {
  ApplicationRoundtripCanaryCohortVerdict,
  ApplicationRoundtripCanaryReasonCode,
  ApplicationRoundtripCanaryTargetDisposition,
} from "./canary";

const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/u;

export interface ApplicationRoundtripReleaseAdmission {
  readonly receiptSchema:
    | "application-roundtrip-canary-receipt-v3"
    | "application-roundtrip-canary-policy-receipt-v1";
  readonly admissionReceiptSha256: string;
  readonly canaryReceiptSha256: string;
  readonly proposalSha256: string;
  readonly proposalGitSha: string;
  readonly policyGitSha: string | null;
  readonly sequence: number;
  readonly grantId: string;
  readonly deepReceiptSha256: string;
  readonly sourceSha256s: readonly string[];
  readonly runId: string;
  readonly runArtifactPath: string;
  readonly runArtifactSha256: string;
  readonly targetDisposition: "ready" | "conditional";
  readonly cohortVerdict: "CONTINUE";
  readonly reasonCodes: readonly ApplicationRoundtripCanaryReasonCode[];
}

export interface ApplicationRoundtripReceiptArtifact {
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

interface ApplicationRoundtripReleaseAdmissionDependencies {
  readonly listCanaryReceipts: () => Promise<readonly ApplicationRoundtripReceiptArtifact[]>;
  readonly listPolicyReceipts: () => Promise<readonly ApplicationRoundtripReceiptArtifact[]>;
  readonly readProposal: (proposalSha256: string) => Promise<Uint8Array>;
  readonly isGitAncestor: (gitSha: string) => Promise<boolean>;
}

interface CanaryReceiptBinding {
  readonly schema: "application-roundtrip-canary-receipt-v2" | "application-roundtrip-canary-receipt-v3";
  readonly receiptSha256: string;
  readonly proposalSha256: string;
  readonly sequence: number;
  readonly grantId: string;
  readonly sourceSha256s: readonly string[];
  readonly model: "claude-opus-5";
  readonly transport: "claude-cli";
  readonly status: "complete" | "partial" | "failed";
  readonly targetDisposition?: ApplicationRoundtripCanaryTargetDisposition;
  readonly cohortVerdict?: ApplicationRoundtripCanaryCohortVerdict;
  readonly reasonCodes?: readonly ApplicationRoundtripCanaryReasonCode[];
  readonly runId: string;
  readonly runArtifactPath: string;
  readonly runArtifactSha256: string;
}

interface PolicyReceiptBinding {
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

interface ProposalBinding {
  readonly proposalSha256: string;
  readonly provenance: { readonly gitSha: string };
  readonly policy: { readonly model: string; readonly transport: string };
  readonly executionTargets: readonly {
    readonly sequence: number;
    readonly grantId: string;
    readonly deepReceiptSha256: string;
    readonly sourceSha256s: readonly string[];
  }[];
}

/** Kordoc receipt 형식 차이를 숨기고 release가 소비할 exact admission 하나만 반환한다. */
export function createApplicationRoundtripReleaseAdmission(
  deps: ApplicationRoundtripReleaseAdmissionDependencies,
) {
  return {
    async admit(input: {
      readonly grantId: string;
      readonly deepReceiptSha256: string;
    }): Promise<ApplicationRoundtripReleaseAdmission | null> {
      if (!input.grantId.trim()) throw new Error("Kordoc release admission grantId가 비었습니다.");
      assertSha(input.deepReceiptSha256, "deep receipt SHA-256");

      const [canaryArtifacts, policyArtifacts] = await Promise.all([
        deps.listCanaryReceipts(),
        deps.listPolicyReceipts(),
      ]);
      const canaryBySha = new Map(canaryArtifacts.map((artifact) => [artifact.sha256, artifact]));
      const candidates: Array<{
        admission: Omit<ApplicationRoundtripReleaseAdmission, "targetDisposition" | "cohortVerdict"> & {
          readonly targetDisposition: ApplicationRoundtripCanaryTargetDisposition;
          readonly cohortVerdict: ApplicationRoundtripCanaryCohortVerdict;
        };
        readonly sourceGitShas: readonly string[];
      }> = [];

      for (const artifact of canaryArtifacts) {
        const value = parseJsonObject(artifact.bytes, "Kordoc canary receipt");
        if (value.schema !== "application-roundtrip-canary-receipt-v3" || value.grantId !== input.grantId) {
          continue;
        }
        const receipt = parseCanaryReceipt(artifact, "application-roundtrip-canary-receipt-v3");
        const proposal = await parseProposal(deps, receipt.proposalSha256);
        const target = exactProposalTarget(proposal, receipt, input.deepReceiptSha256);
        if (!target) continue;
        candidates.push({
          admission: admissionFrom(receipt, proposal, target.deepReceiptSha256, {
            receiptSchema: "application-roundtrip-canary-receipt-v3",
            admissionReceiptSha256: receipt.receiptSha256,
            canaryReceiptSha256: receipt.receiptSha256,
            policyGitSha: null,
            targetDisposition: receipt.targetDisposition!,
            cohortVerdict: receipt.cohortVerdict!,
            reasonCodes: receipt.reasonCodes!,
          }),
          sourceGitShas: [proposal.provenance.gitSha],
        });
      }

      for (const artifact of policyArtifacts) {
        const value = parseJsonObject(artifact.bytes, "Kordoc policy receipt");
        if (value.schema !== "application-roundtrip-canary-policy-receipt-v1" || value.grantId !== input.grantId) {
          continue;
        }
        const policy = parsePolicyReceipt(artifact);
        const parentArtifact = canaryBySha.get(policy.parentCanaryReceiptSha256);
        if (!parentArtifact) {
          throw new Error(`Kordoc policy receipt의 parent canary가 없습니다: ${input.grantId}`);
        }
        const parent = parseCanaryReceipt(parentArtifact, "application-roundtrip-canary-receipt-v2");
        assertPolicyParentBinding(policy, parent);
        const proposal = await parseProposal(deps, parent.proposalSha256);
        const target = exactProposalTarget(proposal, parent, input.deepReceiptSha256);
        if (!target) continue;
        candidates.push({
          admission: admissionFrom(parent, proposal, target.deepReceiptSha256, {
            receiptSchema: policy.schema,
            admissionReceiptSha256: policy.receiptSha256,
            canaryReceiptSha256: parent.receiptSha256,
            policyGitSha: policy.policyGitSha,
            targetDisposition: policy.targetDisposition,
            cohortVerdict: policy.cohortVerdict,
            reasonCodes: policy.reasonCodes,
          }),
          sourceGitShas: [proposal.provenance.gitSha, policy.policyGitSha],
        });
      }

      if (candidates.length === 0) return null;
      if (candidates.length !== 1) {
        throw new Error(`exact deep receipt에 결속된 Kordoc release admission이 중복입니다: ${input.grantId}`);
      }
      const candidate = candidates[0]!;
      if (
        candidate.admission.cohortVerdict !== "CONTINUE"
        || (candidate.admission.targetDisposition !== "ready"
          && candidate.admission.targetDisposition !== "conditional")
      ) {
        throw new Error(
          `Kordoc receipt가 release 대상이 아닙니다: ${input.grantId}`
            + ` (${candidate.admission.targetDisposition}/${candidate.admission.cohortVerdict})`,
        );
      }
      for (const gitSha of [...new Set(candidate.sourceGitShas)]) {
        if (!await deps.isGitAncestor(gitSha)) {
          throw new Error(`Kordoc receipt 정책 git SHA를 현재 checkout ancestry에서 검증할 수 없습니다: ${gitSha}`);
        }
      }
      return Object.freeze({
        ...candidate.admission,
        targetDisposition: candidate.admission.targetDisposition,
        cohortVerdict: candidate.admission.cohortVerdict,
      }) as ApplicationRoundtripReleaseAdmission;
    },
  };
}

function admissionFrom(
  receipt: CanaryReceiptBinding,
  proposal: ProposalBinding,
  deepReceiptSha256: string,
  policy: {
    readonly receiptSchema: ApplicationRoundtripReleaseAdmission["receiptSchema"];
    readonly admissionReceiptSha256: string;
    readonly canaryReceiptSha256: string;
    readonly policyGitSha: string | null;
    readonly targetDisposition: ApplicationRoundtripCanaryTargetDisposition;
    readonly cohortVerdict: ApplicationRoundtripCanaryCohortVerdict;
    readonly reasonCodes: readonly ApplicationRoundtripCanaryReasonCode[];
  },
) {
  return Object.freeze({
    receiptSchema: policy.receiptSchema,
    admissionReceiptSha256: policy.admissionReceiptSha256,
    canaryReceiptSha256: policy.canaryReceiptSha256,
    proposalSha256: receipt.proposalSha256,
    proposalGitSha: proposal.provenance.gitSha,
    policyGitSha: policy.policyGitSha,
    sequence: receipt.sequence,
    grantId: receipt.grantId,
    deepReceiptSha256,
    sourceSha256s: Object.freeze([...receipt.sourceSha256s]),
    runId: receipt.runId,
    runArtifactPath: receipt.runArtifactPath,
    runArtifactSha256: receipt.runArtifactSha256,
    targetDisposition: policy.targetDisposition,
    cohortVerdict: policy.cohortVerdict,
    reasonCodes: Object.freeze([...policy.reasonCodes]),
  });
}

async function parseProposal(
  deps: ApplicationRoundtripReleaseAdmissionDependencies,
  proposalSha256: string,
): Promise<ProposalBinding> {
  assertSha(proposalSha256, "Kordoc proposal SHA-256");
  const value = parseJsonObject(await deps.readProposal(proposalSha256), "Kordoc proposal");
  const storedSha = value.proposalSha256;
  const provenance = record(value.provenance, "Kordoc proposal provenance");
  const policy = record(value.policy, "Kordoc proposal policy");
  if (
    value.schema !== "application-roundtrip-candidate-proposal-v1"
    || storedSha !== proposalSha256
    || !FULL_GIT_SHA.test(text(provenance.gitSha))
    || policy.model !== "claude-opus-5"
    || policy.transport !== "claude-cli"
    || !Array.isArray(value.executionTargets)
  ) {
    throw new Error("Kordoc proposal release binding 형식이 올바르지 않습니다.");
  }
  const { proposalSha256: _stored, ...body } = value;
  if (canonicalSha256(body) !== proposalSha256) {
    throw new Error("Kordoc proposal canonical SHA-256이 다릅니다.");
  }
  return {
    proposalSha256,
    provenance: { gitSha: text(provenance.gitSha) },
    policy: { model: text(policy.model), transport: text(policy.transport) },
    executionTargets: value.executionTargets.map((entry) => {
      const target = record(entry, "Kordoc proposal target");
      if (
        !Number.isSafeInteger(target.sequence)
        || typeof target.grantId !== "string"
        || !SHA256.test(text(target.deepReceiptSha256))
        || !isShaArray(target.sourceSha256s)
      ) throw new Error("Kordoc proposal target 형식이 올바르지 않습니다.");
      return {
        sequence: Number(target.sequence),
        grantId: target.grantId,
        deepReceiptSha256: text(target.deepReceiptSha256),
        sourceSha256s: target.sourceSha256s,
      };
    }),
  };
}

function exactProposalTarget(
  proposal: ProposalBinding,
  receipt: CanaryReceiptBinding,
  deepReceiptSha256: string,
): ProposalBinding["executionTargets"][number] | null {
  const target = proposal.executionTargets.find((entry) => (
    entry.sequence === receipt.sequence
    && entry.grantId === receipt.grantId
    && entry.deepReceiptSha256 === deepReceiptSha256
  ));
  if (!target) return null;
  if (!sameOrdered(target.sourceSha256s, receipt.sourceSha256s)) {
    throw new Error(`Kordoc proposal와 receipt source 결속이 다릅니다: ${receipt.grantId}`);
  }
  return target;
}

function parseCanaryReceipt(
  artifact: ApplicationRoundtripReceiptArtifact,
  expectedSchema: CanaryReceiptBinding["schema"],
): CanaryReceiptBinding {
  assertSha(artifact.sha256, "Kordoc canary receipt path SHA-256");
  const value = parseJsonObject(artifact.bytes, "Kordoc canary receipt");
  if (
    value.schema !== expectedSchema
    || value.receiptSha256 !== artifact.sha256
    || !SHA256.test(text(value.proposalSha256))
    || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 0
    || typeof value.grantId !== "string"
    || !isShaArray(value.sourceSha256s)
    || value.model !== "claude-opus-5"
    || value.transport !== "claude-cli"
    || !["complete", "partial", "failed"].includes(text(value.status))
    || typeof value.runId !== "string"
    || typeof value.runArtifactPath !== "string"
    || !SHA256.test(text(value.runArtifactSha256))
  ) {
    throw new Error("Kordoc canary receipt 형식이 올바르지 않습니다.");
  }
  const { receiptSha256: _stored, ...body } = value;
  if (canonicalSha256(body) !== artifact.sha256) {
    throw new Error("Kordoc canary receipt canonical SHA-256이 다릅니다.");
  }
  if (expectedSchema === "application-roundtrip-canary-receipt-v3") {
    if (
      !["ready", "conditional", "held", "blocked"].includes(text(value.targetDisposition))
      || !["CONTINUE", "STOP"].includes(text(value.cohortVerdict))
      || !isReasonCodes(value.reasonCodes)
    ) throw new Error("Kordoc v3 canary policy 판정 형식이 올바르지 않습니다.");
  }
  return value as unknown as CanaryReceiptBinding;
}

function parsePolicyReceipt(artifact: ApplicationRoundtripReceiptArtifact): PolicyReceiptBinding {
  assertSha(artifact.sha256, "Kordoc policy receipt path SHA-256");
  const value = parseJsonObject(artifact.bytes, "Kordoc policy receipt");
  if (
    value.schema !== "application-roundtrip-canary-policy-receipt-v1"
    || value.receiptSha256 !== artifact.sha256
    || value.policyVersion !== "target-isolation-v1"
    || !FULL_GIT_SHA.test(text(value.policyGitSha))
    || !SHA256.test(text(value.parentCanaryReceiptSha256))
    || !SHA256.test(text(value.proposalSha256))
    || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 0
    || typeof value.grantId !== "string"
    || !isShaArray(value.sourceSha256s)
    || typeof value.runId !== "string"
    || !SHA256.test(text(value.runArtifactSha256))
    || !["complete", "partial", "failed"].includes(text(value.originalStatus))
    || !["ready", "conditional", "held", "blocked"].includes(text(value.targetDisposition))
    || !["CONTINUE", "STOP"].includes(text(value.cohortVerdict))
    || !isReasonCodes(value.reasonCodes)
  ) throw new Error("Kordoc policy receipt 형식이 올바르지 않습니다.");
  const { receiptSha256: _stored, ...body } = value;
  if (canonicalSha256(body) !== artifact.sha256) {
    throw new Error("Kordoc policy receipt canonical SHA-256이 다릅니다.");
  }
  return value as unknown as PolicyReceiptBinding;
}

function assertPolicyParentBinding(policy: PolicyReceiptBinding, parent: CanaryReceiptBinding): void {
  if (
    policy.parentCanaryReceiptSha256 !== parent.receiptSha256
    || policy.proposalSha256 !== parent.proposalSha256
    || policy.sequence !== parent.sequence
    || policy.grantId !== parent.grantId
    || !sameOrdered(policy.sourceSha256s, parent.sourceSha256s)
    || policy.runId !== parent.runId
    || policy.runArtifactSha256 !== parent.runArtifactSha256
    || policy.originalStatus !== parent.status
  ) throw new Error(`Kordoc policy receipt와 parent canary 결속이 다릅니다: ${policy.grantId}`);
}

function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} JSON을 읽을 수 없습니다.`);
  }
  return record(value, label);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}가 객체가 아닙니다.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isShaArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string" && SHA256.test(entry))
    && new Set(value).size === value.length;
}

function isReasonCodes(value: unknown): value is ApplicationRoundtripCanaryReasonCode[] {
  const allowed = new Set<ApplicationRoundtripCanaryReasonCode>([
    "ready",
    "structural_warnings_suppressed",
    "field_planning_degraded",
    "adjudication_incomplete",
    "unresolved_candidates",
    "document_failure",
    "execution_failure",
  ]);
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string" && allowed.has(entry as ApplicationRoundtripCanaryReasonCode))
    && new Set(value).size === value.length;
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  if (!SHA256.test(value)) throw new Error(`${label} 형식이 올바르지 않습니다.`);
}
