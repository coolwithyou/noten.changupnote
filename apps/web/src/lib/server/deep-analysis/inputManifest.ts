import type { DeepAnalysisAttachmentDisposition } from "@cunote/contracts";
import {
  buildAttachmentManifestSha256,
  sha256Hex,
  stableJson,
} from "./sourceRevision";

export const DEEP_ANALYSIS_INPUT_SCHEMA = "deep-analysis-input-v1" as const;
export const DEFAULT_DEEP_ANALYSIS_CHUNK_CHARS = 60_000;

export interface DeepAnalysisInputAttachment {
  id: string;
  filename: string;
  sourceUri: string;
  contentType: string | null;
  bytes: number | null;
  storageKey: string | null;
  sha256: string | null;
  conversionStatus: string | null;
  markdownStorageKey: string | null;
  markdownSha256: string | null;
  markdownText: string | null;
  loadError?: string | null;
  waiver?: {
    disposition: "waived_non_text" | "waived_non_material";
    reason: string;
    proofSha256: string;
  };
}

export interface DeepAnalysisInputManifestAttachment {
  id: string;
  filename: string;
  sourceUri: string;
  contentType: string | null;
  bytes: number | null;
  storageKey: string | null;
  sha256: string | null;
  conversionStatus: string | null;
  markdownStorageKey: string | null;
  markdownSha256: string | null;
  disposition: DeepAnalysisAttachmentDisposition;
  dispositionReason: string | null;
  duplicateOf: string | null;
  textChars: number;
  textSha256: string | null;
  chunkIds: string[];
}

export interface DeepAnalysisInputChunk {
  id: string;
  sourceKind: "structured" | "attachment";
  sourceId: string;
  index: number;
  startChar: number;
  endChar: number;
  chars: number;
  sha256: string;
  text: string;
}

export interface DeepAnalysisInputSeal {
  schema: typeof DEEP_ANALYSIS_INPUT_SCHEMA;
  grantId: string;
  sourceRevisionSha256: string;
  attachmentManifestSha256: string;
  inputSha256: string;
  sealed: boolean;
  attachments: DeepAnalysisInputManifestAttachment[];
  chunks: DeepAnalysisInputChunk[];
  blockers: Array<{
    code: "blocked_fetch" | "blocked_conversion" | "blocked_cap" | "invalid_waiver";
    attachmentId: string | null;
    message: string;
  }>;
  totalChars: number;
  inputArtifactBody: string;
}

/**
 * 모든 구조화 필드와 첨부 전문을 손실 없이 chunk manifest로 봉인한다. 입력 상한을 넘으면
 * 잘라 성공시키지 않고 blocked_cap으로 실패한다.
 */
export function sealDeepAnalysisInput(input: {
  grantId: string;
  sourceRevisionSha256: string;
  structuredText: string;
  attachments: DeepAnalysisInputAttachment[];
  chunkChars?: number;
  maxTotalChars?: number;
}): DeepAnalysisInputSeal {
  const chunkChars = input.chunkChars ?? DEFAULT_DEEP_ANALYSIS_CHUNK_CHARS;
  if (!Number.isInteger(chunkChars) || chunkChars < 1_000 || chunkChars > 200_000) {
    throw new Error("chunkChars must be an integer between 1,000 and 200,000");
  }
  const blockers: DeepAnalysisInputSeal["blockers"] = [];
  const chunks: DeepAnalysisInputChunk[] = [];
  chunks.push(...chunkText({
    sourceKind: "structured",
    sourceId: "grant",
    text: input.structuredText,
    chunkChars,
  }));

  const includedByContentHash = new Map<string, string>();
  const attachments: DeepAnalysisInputManifestAttachment[] = [];
  for (const attachment of input.attachments) {
    const base = {
      id: attachment.id,
      filename: attachment.filename,
      sourceUri: attachment.sourceUri,
      contentType: attachment.contentType,
      bytes: attachment.bytes,
      storageKey: attachment.storageKey,
      sha256: attachment.sha256,
      conversionStatus: attachment.conversionStatus,
      markdownStorageKey: attachment.markdownStorageKey,
      markdownSha256: attachment.markdownSha256,
    };
    const duplicateOf = attachment.sha256
      ? includedByContentHash.get(attachment.sha256) ?? null
      : null;
    if (duplicateOf) {
      attachments.push({
        ...base,
        disposition: "duplicate",
        dispositionReason: "동일 원본 SHA-256의 included 첨부가 이미 입력에 존재합니다.",
        duplicateOf,
        textChars: 0,
        textSha256: null,
        chunkIds: [],
      });
      continue;
    }

    if (attachment.waiver) {
      const invalidWaiver = isHwpLike(attachment.filename)
        || !attachment.waiver.reason.trim()
        || !/^[0-9a-f]{64}$/.test(attachment.waiver.proofSha256);
      if (invalidWaiver) {
        blockers.push({
          code: "invalid_waiver",
          attachmentId: attachment.id,
          message: `${attachment.filename}: HWP/HWPX 또는 증거 없는 waiver는 허용되지 않습니다.`,
        });
        attachments.push({
          ...base,
          disposition: "blocked_conversion",
          dispositionReason: "invalid waiver",
          duplicateOf: null,
          textChars: 0,
          textSha256: null,
          chunkIds: [],
        });
      } else {
        attachments.push({
          ...base,
          disposition: attachment.waiver.disposition,
          dispositionReason: attachment.waiver.reason,
          duplicateOf: null,
          textChars: 0,
          textSha256: null,
          chunkIds: [],
        });
      }
      continue;
    }

    if (!attachment.storageKey || !attachment.sha256) {
      blockers.push({
        code: "blocked_fetch",
        attachmentId: attachment.id,
        message: `${attachment.filename}: 원본 archive key/SHA-256이 없습니다.`,
      });
      attachments.push({
        ...base,
        disposition: "blocked_fetch",
        dispositionReason: attachment.loadError ?? "원본 archive 미완료",
        duplicateOf: null,
        textChars: 0,
        textSha256: null,
        chunkIds: [],
      });
      continue;
    }
    if (
      attachment.conversionStatus !== "converted"
      || !attachment.markdownStorageKey
      || !attachment.markdownSha256
      || attachment.markdownText === null
      || attachment.loadError
    ) {
      blockers.push({
        code: "blocked_conversion",
        attachmentId: attachment.id,
        message: `${attachment.filename}: 검증된 첨부 전문이 없습니다.`,
      });
      attachments.push({
        ...base,
        disposition: "blocked_conversion",
        dispositionReason: attachment.loadError ?? "markdown conversion 미완료",
        duplicateOf: null,
        textChars: 0,
        textSha256: null,
        chunkIds: [],
      });
      continue;
    }

    const textSha256 = sha256Hex(attachment.markdownText);
    const attachmentChunks = chunkText({
      sourceKind: "attachment",
      sourceId: attachment.id,
      text: attachment.markdownText,
      chunkChars,
    });
    chunks.push(...attachmentChunks);
    if (attachment.sha256) includedByContentHash.set(attachment.sha256, attachment.id);
    attachments.push({
      ...base,
      disposition: "included",
      dispositionReason: null,
      duplicateOf: null,
      textChars: attachment.markdownText.length,
      textSha256,
      chunkIds: attachmentChunks.map((chunk) => chunk.id),
    });
  }

  const totalChars = chunks.reduce((sum, chunk) => sum + chunk.chars, 0);
  if (input.maxTotalChars !== undefined && totalChars > input.maxTotalChars) {
    blockers.push({
      code: "blocked_cap",
      attachmentId: null,
      message: `전체 입력 ${totalChars}자가 정책 상한 ${input.maxTotalChars}자를 초과합니다.`,
    });
  }
  assertChunkRoundTrip(input.structuredText, chunks, "structured", "grant");
  for (const attachment of input.attachments) {
    if (attachment.markdownText !== null) {
      const manifestAttachment = attachments.find((item) => item.id === attachment.id);
      if (manifestAttachment?.disposition === "included") {
        assertChunkRoundTrip(attachment.markdownText, chunks, "attachment", attachment.id);
      }
    }
  }

  const manifestForHash = {
    schema: DEEP_ANALYSIS_INPUT_SCHEMA,
    grantId: input.grantId,
    sourceRevisionSha256: input.sourceRevisionSha256,
    attachments: attachments.map(({ chunkIds, ...attachment }) => ({ ...attachment, chunkIds })),
    chunks: chunks.map(({ text: _text, ...chunk }) => chunk),
    totalChars,
  };
  const attachmentManifestSha256 = buildAttachmentManifestSha256(
    manifestForHash.attachments,
  );
  const inputArtifactBody = `${stableJson({
    ...manifestForHash,
    attachmentManifestSha256,
    chunks,
  })}\n`;
  const inputSha256 = sha256Hex(inputArtifactBody);
  return {
    schema: DEEP_ANALYSIS_INPUT_SCHEMA,
    grantId: input.grantId,
    sourceRevisionSha256: input.sourceRevisionSha256,
    attachmentManifestSha256,
    inputSha256,
    sealed: blockers.length === 0,
    attachments,
    chunks,
    blockers,
    totalChars,
    inputArtifactBody,
  };
}

function chunkText(input: {
  sourceKind: DeepAnalysisInputChunk["sourceKind"];
  sourceId: string;
  text: string;
  chunkChars: number;
}): DeepAnalysisInputChunk[] {
  if (input.text.length === 0) return [];
  const chunks: DeepAnalysisInputChunk[] = [];
  for (let start = 0, index = 0; start < input.text.length; start += input.chunkChars, index += 1) {
    const text = input.text.slice(start, start + input.chunkChars);
    const endChar = start + text.length;
    chunks.push({
      id: `${input.sourceKind}:${input.sourceId}:${index}`,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      index,
      startChar: start,
      endChar,
      chars: text.length,
      sha256: sha256Hex(text),
      text,
    });
  }
  return chunks;
}

function assertChunkRoundTrip(
  expected: string,
  chunks: DeepAnalysisInputChunk[],
  sourceKind: DeepAnalysisInputChunk["sourceKind"],
  sourceId: string,
): void {
  const reconstructed = chunks
    .filter((chunk) => chunk.sourceKind === sourceKind && chunk.sourceId === sourceId)
    .sort((left, right) => left.index - right.index)
    .map((chunk) => chunk.text)
    .join("");
  if (reconstructed !== expected) {
    throw new Error(`Chunk round-trip failed for ${sourceKind}:${sourceId}`);
  }
}

function isHwpLike(filename: string): boolean {
  return /\.(?:hwp|hwpx)$/i.test(filename);
}
