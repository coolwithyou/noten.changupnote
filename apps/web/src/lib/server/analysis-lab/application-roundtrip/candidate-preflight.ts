import { createHash } from "node:crypto";
import type {
  RoundtripDocumentFormat,
  RoundtripDocumentRole,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import {
  classifyRoundtripDocument,
  declaredRoundtripFormat,
  likelyApplicationRole,
} from "./core";

const MAX_BATCH_CANDIDATES = 10;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ApplicationRoundtripCandidate {
  readonly sequence: number;
  readonly grantId: string;
  readonly source: "kstartup" | "bizinfo" | "bizinfo_event";
  readonly sourceId: string;
  readonly title: string;
  readonly matchingReadiness: "ready" | "conditional";
  readonly deepReceiptSha256: string;
  readonly deepRunArtifactSha256: string;
}

export interface ApplicationRoundtripSource {
  readonly filename: string;
  readonly storageKey: string | null;
  readonly sha256: string | null;
  readonly bytes: number | null;
}

export interface ApplicationRoundtripProbe {
  readonly detectedFormat: RoundtripDocumentFormat;
  readonly role: RoundtripDocumentRole;
  readonly roleConfidence: number;
  readonly fieldCandidateCount: number;
  readonly llmCandidateCount: number;
  readonly deterministicDecisionCount: number;
}

export type ApplicationRoundtripCandidateStatus =
  | "ready"
  | "not_applicable"
  | "source_unavailable"
  | "review_required";

interface CandidateDocumentResult {
  readonly filename: string;
  readonly sourceSha256: string | null;
  readonly declaredFormat: RoundtripDocumentFormat;
  readonly detectedFormat: RoundtripDocumentFormat | null;
  readonly role: RoundtripDocumentRole | null;
  readonly roleConfidence: number | null;
  readonly fieldCandidateCount: number;
  readonly llmCandidateCount: number;
  readonly deterministicDecisionCount: number;
  readonly selected: boolean;
  readonly error: string | null;
}

export interface ApplicationRoundtripPreflightProposal {
  readonly schema: "application-roundtrip-candidate-proposal-v1";
  readonly preparedAt: string;
  readonly provenance: {
    readonly gitSha: string;
    readonly packageRuntimeSha256: string;
    readonly validatorVersion: string;
  };
  readonly deepExperiment: {
    readonly planSha256: string;
    readonly terminalReceiptSha256: string;
    readonly observationsSha256: string;
    readonly observedCount: number;
  };
  readonly policy: {
    readonly transport: "claude-cli";
    readonly model: "claude-opus-5";
    readonly candidateSelection: "publishable-ready-or-conditional-v1";
    readonly fieldTriage: "ambiguous-only-v1";
    readonly maxCandidates: 10;
  };
  readonly candidates: ReadonlyArray<ApplicationRoundtripCandidate & {
    readonly status: ApplicationRoundtripCandidateStatus;
    readonly documents: readonly CandidateDocumentResult[];
    readonly selectedSourceSha256s: readonly string[];
  }>;
  readonly executionTargets: ReadonlyArray<{
    readonly sequence: number;
    readonly grantId: string;
    readonly deepReceiptSha256: string;
    readonly sourceSha256s: readonly string[];
    readonly fieldCandidateCount: number;
    readonly llmCandidateCount: number;
    readonly deterministicDecisionCount: number;
  }>;
  readonly liveExecutionAuthorized: false;
  readonly proposalSha256: string;
}

interface ApplicationRoundtripCandidatePreflightDependencies {
  readonly now: () => Date;
  readonly readExecutionProvenance: () => Promise<{
    gitSha: string;
    packageRuntimeSha256: string;
    validatorVersion: string;
  }>;
  readonly loadCandidates: (finalReceiptSha256: string) => Promise<{
    planSha256: string;
    observationsSha256: string;
    observedCount: number;
    candidates: readonly ApplicationRoundtripCandidate[];
  }>;
  readonly listAttachments: (candidate: ApplicationRoundtripCandidate) => Promise<readonly ApplicationRoundtripSource[]>;
  readonly readAttachment: (storageKey: string) => Promise<Uint8Array>;
  readonly probeAttachment: (input: {
    filename: string;
    declaredFormat: RoundtripDocumentFormat;
    sourceSha256: string;
    body: Uint8Array;
  }) => Promise<ApplicationRoundtripProbe>;
  readonly writeProposal: (artifact: { sha256: string; bytes: Uint8Array }) => Promise<void>;
}

export interface ApplicationRoundtripCandidatePreflight {
  prepare(input: { finalReceiptSha256: string }): Promise<{
    proposal: ApplicationRoundtripPreflightProposal;
  }>;
}

export function createApplicationRoundtripCandidatePreflight(
  deps: ApplicationRoundtripCandidatePreflightDependencies,
): ApplicationRoundtripCandidatePreflight {
  return {
    async prepare({ finalReceiptSha256 }) {
      assertSha(finalReceiptSha256, "finalReceiptSha256");
      const [source, provenance] = await Promise.all([
        deps.loadCandidates(finalReceiptSha256),
        deps.readExecutionProvenance(),
      ]);
      assertCandidateSet(source.candidates);
      const candidates = [];
      for (const candidate of source.candidates) {
        const documents = await inspectCandidate(candidate, await deps.listAttachments(candidate), deps);
        const selected = documents.filter((document) => document.selected);
        candidates.push({
          ...candidate,
          status: classifyCandidateStatus(documents),
          documents,
          selectedSourceSha256s: selected.flatMap((document) => document.sourceSha256 ? [document.sourceSha256] : []),
        });
      }

      const body = {
        schema: "application-roundtrip-candidate-proposal-v1" as const,
        preparedAt: exactIso(deps.now()),
        provenance: normalizeProvenance(provenance),
        deepExperiment: {
          planSha256: exactSha(source.planSha256, "planSha256"),
          terminalReceiptSha256: finalReceiptSha256,
          observationsSha256: exactSha(source.observationsSha256, "observationsSha256"),
          observedCount: source.observedCount,
        },
        policy: {
          transport: "claude-cli" as const,
          model: "claude-opus-5" as const,
          candidateSelection: "publishable-ready-or-conditional-v1" as const,
          fieldTriage: "ambiguous-only-v1" as const,
          maxCandidates: MAX_BATCH_CANDIDATES as 10,
        },
        candidates,
        executionTargets: candidates.flatMap((candidate) => {
          if (candidate.status !== "ready") return [];
          return [{
            sequence: candidate.sequence,
            grantId: candidate.grantId,
            deepReceiptSha256: candidate.deepReceiptSha256,
            sourceSha256s: candidate.selectedSourceSha256s,
            fieldCandidateCount: sum(candidate.documents, "fieldCandidateCount"),
            llmCandidateCount: sum(candidate.documents, "llmCandidateCount"),
            deterministicDecisionCount: sum(candidate.documents, "deterministicDecisionCount"),
          }];
        }),
        liveExecutionAuthorized: false as const,
      };
      const proposal: ApplicationRoundtripPreflightProposal = Object.freeze({
        ...body,
        proposalSha256: canonicalSha256(body),
      });
      await deps.writeProposal({
        sha256: proposal.proposalSha256,
        bytes: Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`),
      });
      return { proposal };
    },
  };
}

async function inspectCandidate(
  candidate: ApplicationRoundtripCandidate,
  attachments: readonly ApplicationRoundtripSource[],
  deps: ApplicationRoundtripCandidatePreflightDependencies,
): Promise<CandidateDocumentResult[]> {
  const documents: CandidateDocumentResult[] = [];
  for (const attachment of attachments) {
    const declaredFormat = declaredRoundtripFormat(attachment.filename);
    if (!declaredFormat) continue;
    if (!attachment.storageKey || !attachment.sha256 || !SHA256.test(attachment.sha256.toLowerCase())) {
      documents.push(unavailableDocument(attachment.filename, declaredFormat));
      continue;
    }
    const expectedSha256 = attachment.sha256.toLowerCase();
    try {
      const body = await deps.readAttachment(attachment.storageKey);
      const actualSha256 = createHash("sha256").update(body).digest("hex");
      if (actualSha256 !== expectedSha256) throw new Error("DB와 원본 SHA-256 불일치");
      const probe = await deps.probeAttachment({
        filename: attachment.filename,
        declaredFormat,
        sourceSha256: actualSha256,
        body,
      });
      const selected = likelyApplicationRole(probe.role);
      documents.push({
        filename: attachment.filename,
        sourceSha256: actualSha256,
        declaredFormat,
        detectedFormat: probe.detectedFormat,
        role: probe.role,
        roleConfidence: probe.roleConfidence,
        fieldCandidateCount: probe.fieldCandidateCount,
        llmCandidateCount: selected ? probe.llmCandidateCount : 0,
        deterministicDecisionCount: selected ? probe.deterministicDecisionCount : 0,
        selected,
        error: null,
      });
    } catch (error) {
      documents.push({
        ...unavailableDocument(attachment.filename, declaredFormat),
        sourceSha256: expectedSha256,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }
  return documents;
}

function classifyCandidateStatus(documents: readonly CandidateDocumentResult[]): ApplicationRoundtripCandidateStatus {
  if (documents.some((document) => document.selected)) return "ready";
  const filenameNeedsSource = documents.some((document) => {
    if (document.error === null && document.role !== null) return document.role === "unknown";
    const hinted = classifyRoundtripDocument({ filename: document.filename, markdown: "", fields: [], formConfidence: 0 });
    return likelyApplicationRole(hinted.role) || hinted.role === "unknown";
  });
  if (filenameNeedsSource) {
    return documents.some((document) => document.error !== null && document.sourceSha256 !== null)
      ? "review_required"
      : "source_unavailable";
  }
  return "not_applicable";
}

function unavailableDocument(filename: string, declaredFormat: RoundtripDocumentFormat): CandidateDocumentResult {
  return {
    filename,
    sourceSha256: null,
    declaredFormat,
    detectedFormat: null,
    role: null,
    roleConfidence: null,
    fieldCandidateCount: 0,
    llmCandidateCount: 0,
    deterministicDecisionCount: 0,
    selected: false,
    error: "보관 원본이 없습니다.",
  };
}

function assertCandidateSet(candidates: readonly ApplicationRoundtripCandidate[]): void {
  if (candidates.length === 0 || candidates.length > MAX_BATCH_CANDIDATES) {
    throw new Error(`Kordoc 후보는 1~${MAX_BATCH_CANDIDATES}건이어야 합니다.`);
  }
  const grantIds = new Set<string>();
  let previousSequence = -1;
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence <= previousSequence) {
      throw new Error("Kordoc 후보 sequence가 원 실험 순서를 보존하지 않습니다.");
    }
    previousSequence = candidate.sequence;
    if (!candidate.grantId || grantIds.has(candidate.grantId)) throw new Error("Kordoc 후보 grantId가 비었거나 중복입니다.");
    grantIds.add(candidate.grantId);
    assertSha(candidate.deepReceiptSha256, "deepReceiptSha256");
    assertSha(candidate.deepRunArtifactSha256, "deepRunArtifactSha256");
  }
}

function normalizeProvenance(value: {
  gitSha: string;
  packageRuntimeSha256: string;
  validatorVersion: string;
}) {
  if (!/^[a-f0-9]{40}$/u.test(value.gitSha)) throw new Error("gitSha가 full SHA가 아닙니다.");
  assertSha(value.packageRuntimeSha256, "packageRuntimeSha256");
  if (!value.validatorVersion.trim()) throw new Error("validatorVersion이 비었습니다.");
  return value;
}

function exactSha(value: string, label: string): string {
  assertSha(value, label);
  return value;
}

function assertSha(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label}가 SHA-256이 아닙니다.`);
}

function exactIso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("preparedAt이 유효하지 않습니다.");
  return value.toISOString();
}

function sum(
  documents: readonly CandidateDocumentResult[],
  field: "fieldCandidateCount" | "llmCandidateCount" | "deterministicDecisionCount",
): number {
  return documents.reduce((total, document) => total + (document.selected ? document[field] : 0), 0);
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
