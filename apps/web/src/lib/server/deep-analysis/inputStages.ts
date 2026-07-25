import type {
  DeepAnalysisStageKey,
  DeepAnalysisStageStatus,
} from "@cunote/contracts";
import type { DeepAnalysisInputSeal } from "./inputManifest";

export interface DeepAnalysisInputStageReceiptDraft {
  stage: Extract<
    DeepAnalysisStageKey,
    | "source_fresh"
    | "attachment_inventory_complete"
    | "attachment_archive_complete"
    | "attachment_text_complete"
    | "input_coverage_verified"
    | "input_sealed"
  >;
  status: DeepAnalysisStageStatus;
  evidence: Record<string, unknown>;
}

export function buildDeepAnalysisInputStageReceipts(
  seal: DeepAnalysisInputSeal,
): DeepAnalysisInputStageReceiptDraft[] {
  const blockedFetch = seal.attachments.filter((item) => item.disposition === "blocked_fetch");
  const blockedConversion = seal.attachments.filter(
    (item) => item.disposition === "blocked_conversion",
  );
  const invalidWaiver = seal.blockers.filter((item) => item.code === "invalid_waiver");
  const attachmentEvidence = {
    attachmentManifestSha256: seal.attachmentManifestSha256,
    attachmentCount: seal.attachments.length,
    dispositionCounts: Object.fromEntries(
      [...new Set(seal.attachments.map((item) => item.disposition))]
        .map((disposition) => [
          disposition,
          seal.attachments.filter((item) => item.disposition === disposition).length,
        ]),
    ),
  };
  return [
    {
      stage: "source_fresh",
      status: "passed",
      evidence: { sourceRevisionSha256: seal.sourceRevisionSha256 },
    },
    {
      stage: "attachment_inventory_complete",
      status: "passed",
      evidence: attachmentEvidence,
    },
    {
      stage: "attachment_archive_complete",
      status: blockedFetch.length === 0 ? "passed" : "blocked",
      evidence: {
        ...attachmentEvidence,
        blockedAttachmentIds: blockedFetch.map((item) => item.id),
      },
    },
    {
      stage: "attachment_text_complete",
      status: blockedFetch.length === 0 && blockedConversion.length === 0 ? "passed" : "blocked",
      evidence: {
        ...attachmentEvidence,
        blockedAttachmentIds: [...blockedFetch, ...blockedConversion].map((item) => item.id),
      },
    },
    {
      stage: "input_coverage_verified",
      status:
        blockedFetch.length === 0
        && blockedConversion.length === 0
        && invalidWaiver.length === 0
          ? "passed"
          : "blocked",
      evidence: {
        ...attachmentEvidence,
        invalidWaiverCount: invalidWaiver.length,
      },
    },
    {
      stage: "input_sealed",
      status: seal.sealed ? "passed" : "blocked",
      evidence: {
        inputSha256: seal.inputSha256,
        attachmentManifestSha256: seal.attachmentManifestSha256,
        totalChars: seal.totalChars,
        chunkCount: seal.chunks.length,
        blockerCount: seal.blockers.length,
      },
    },
  ];
}
