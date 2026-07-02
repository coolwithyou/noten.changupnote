import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { GrantRaw, GrantSource } from "@cunote/contracts";
import {
  buildBizInfoProgramExtractionInput,
  type BizInfoAttachmentMarkdown,
  type BizInfoProgram,
} from "@cunote/core";
import {
  convertHwpBufferToMarkdown,
  isHwpFilename,
} from "@cunote/core/bizinfo/hwp-markdown";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";

export interface GrantAttachmentArchiveBundle {
  attachments: NonNullable<GrantRaw["attachments"]>;
  attachmentMarkdowns: BizInfoAttachmentMarkdown[];
  archivedCount: number;
  convertedCount: number;
  skippedConversionCount: number;
  failureCount: number;
  failures: Array<{ filename: string; url: string | null; message: string }>;
}

/**
 * 변환 서버가 시각 렌더링(pdf/page_image/markdown)할 수 있는 문서 포맷.
 * grant_application_surfaces.format 값과 정합 (계획 8.1~8.2, 마스터 7.3).
 */
export type ConvertibleSurfaceFormat = "hwp" | "hwpx" | "pdf" | "docx";

/**
 * 아카이브된 첨부 파일명에서 변환 대상 포맷을 판정한다.
 * hwp/hwpx/pdf/docx 만 surface + 변환 job 대상. 그 외(zip/xlsx/이미지 등)는 null.
 */
export function detectConvertibleSurfaceFormat(
  filename: string,
): ConvertibleSurfaceFormat | null {
  const ext = extname(filename).toLowerCase();
  if (ext === ".hwp") return "hwp";
  if (ext === ".hwpx") return "hwpx";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  return null;
}

/** 첨부가 변환(시각 렌더링) 대상인지 여부. */
export function isConvertibleAttachment(filename: string): boolean {
  return detectConvertibleSurfaceFormat(filename) !== null;
}

export interface GrantAttachmentArchiveOptions {
  source: GrantSource;
  sourceId: string;
  collectedAt: Date;
  enabled: boolean;
  convertHwp: boolean;
  autoInstallPyhwp: boolean;
  allowFailures: boolean;
  storage: R2ObjectStorage | null;
  fetchImpl?: typeof fetch;
}

interface SourceAttachment {
  filename: string;
  url: string | null;
}

export async function archiveBizInfoProgramAttachments(
  program: BizInfoProgram,
  options: Omit<GrantAttachmentArchiveOptions, "source" | "sourceId">,
): Promise<GrantAttachmentArchiveBundle> {
  const input = buildBizInfoProgramExtractionInput(program);
  return archiveGrantAttachments(input.metadata.attachments, {
    ...options,
    source: "bizinfo",
    sourceId: program.pblancId,
  });
}

export async function archiveGrantAttachments(
  sourceAttachments: SourceAttachment[],
  options: GrantAttachmentArchiveOptions,
): Promise<GrantAttachmentArchiveBundle> {
  if (!options.enabled) {
    return {
      attachments: sourceAttachments.map(toRawAttachment),
      attachmentMarkdowns: [],
      archivedCount: 0,
      convertedCount: 0,
      skippedConversionCount: 0,
      failureCount: 0,
      failures: [],
    };
  }
  if (!options.storage) throw new Error("첨부 아카이브에는 R2 설정이 필요합니다.");

  const attachments: NonNullable<GrantRaw["attachments"]> = [];
  const attachmentMarkdowns: BizInfoAttachmentMarkdown[] = [];
  const failures: Array<{ filename: string; url: string | null; message: string }> = [];
  let archivedCount = 0;
  let convertedCount = 0;
  let skippedConversionCount = 0;

  for (const attachment of sourceAttachments) {
    try {
      const archived = await archiveOneAttachment(attachment, options);
      attachments.push(archived.rawAttachment);
      archivedCount += 1;
      if (archived.failure) failures.push(archived.failure);
      if (archived.markdown) {
        convertedCount += 1;
      attachmentMarkdowns.push(archived.markdown);
      } else if (archived.rawAttachment.conversion?.status === "skipped") {
        skippedConversionCount += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ filename: attachment.filename, url: attachment.url, message });
      if (!options.allowFailures) throw error;
      attachments.push({
        ...toRawAttachment(attachment),
        conversion: {
          status: "failed",
          error: message,
        },
      });
    }
  }

  return {
    attachments,
    attachmentMarkdowns,
    archivedCount,
    convertedCount,
    skippedConversionCount,
    failureCount: failures.length,
    failures,
  };
}

async function archiveOneAttachment(
  attachment: SourceAttachment,
  options: GrantAttachmentArchiveOptions,
): Promise<{
  rawAttachment: NonNullable<GrantRaw["attachments"]>[number];
  markdown: BizInfoAttachmentMarkdown | null;
  failure?: { filename: string; url: string | null; message: string };
}> {
  const originalUrl = attachment.url;
  if (!originalUrl) {
    return {
      rawAttachment: {
        filename: attachment.filename,
        url: null,
        source_uri: null,
        conversion: { status: "skipped" },
      },
      markdown: null,
    };
  }

  const downloaded = await downloadAttachment(originalUrl, options.fetchImpl ?? fetch);
  const contentType = downloaded.contentType ?? inferContentType(attachment.filename);
  const sha256 = sha256Hex(downloaded.body);
  const storageKey = objectKey({
    source: options.source,
    sourceId: options.sourceId,
    filename: attachment.filename,
    sha256,
    kind: "attachments",
  });
  const uploaded = await options.storage!.putObject({
    key: storageKey,
    body: downloaded.body,
    contentType,
  });

  const rawAttachment: NonNullable<GrantRaw["attachments"]>[number] = {
    filename: attachment.filename,
    url: uploaded.url,
    source_uri: originalUrl,
    archive_url: uploaded.url,
    storage_key: uploaded.key,
    content_type: contentType,
    bytes: downloaded.body.length,
    sha256,
    fetched_at: options.collectedAt.toISOString(),
  };

  if (!options.convertHwp || !isHwpFilename(attachment.filename)) {
    rawAttachment.conversion = { status: "skipped" };
    return { rawAttachment, markdown: null };
  }

  let converted: ReturnType<typeof convertHwpBufferToMarkdown>;
  try {
    converted = convertHwpBufferToMarkdown({
      filename: attachment.filename,
      body: downloaded.body,
      autoInstallPyhwp: options.autoInstallPyhwp,
    });
  } catch (error) {
    if (!options.allowFailures) throw error;
    const message = error instanceof Error ? error.message : String(error);
    rawAttachment.conversion = {
      status: "failed",
      error: message,
    };
    return {
      rawAttachment,
      markdown: null,
      failure: { filename: attachment.filename, url: originalUrl, message },
    };
  }
  const markdownBody = renderArchivedMarkdown({
    source: options.source,
    sourceId: options.sourceId,
    filename: attachment.filename,
    originalUrl,
    archiveUrl: uploaded.url,
    markdown: converted.markdown,
  });
  const markdownSha256 = sha256Hex(markdownBody);
  const markdownKey = objectKey({
    source: options.source,
    sourceId: options.sourceId,
    filename: `${stripExtension(attachment.filename)}.md`,
    sha256: markdownSha256,
    kind: "markdown",
  });
  const markdownUpload = await options.storage!.putObject({
    key: markdownKey,
    body: markdownBody,
    contentType: "text/markdown; charset=utf-8",
  });

  rawAttachment.conversion = {
    status: "converted",
    markdown_url: markdownUpload.url,
    markdown_storage_key: markdownUpload.key,
    markdown_sha256: markdownSha256,
    markdown_bytes: Buffer.byteLength(markdownBody),
    converter: converted.converter,
    converted_at: options.collectedAt.toISOString(),
  };

  return {
    rawAttachment,
    markdown: {
      filename: attachment.filename,
      markdown: converted.markdown,
      source_uri: markdownUpload.url,
    },
  };
}

async function downloadAttachment(url: string, fetchImpl: typeof fetch): Promise<{
  body: Buffer;
  contentType: string | null;
}> {
  const response = await fetchImpl(url, { headers: { accept: "*/*" } });
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error("Attachment download produced an empty file");
  return {
    body,
    contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || null,
  };
}

function toRawAttachment(attachment: SourceAttachment): NonNullable<GrantRaw["attachments"]>[number] {
  return {
    filename: attachment.filename,
    url: attachment.url,
    source_uri: attachment.url,
  };
}

function objectKey(input: {
  source: GrantSource;
  sourceId: string;
  filename: string;
  sha256: string;
  kind: "attachments" | "markdown";
}): string {
  return [
    "grant-archive",
    input.source,
    sanitizeKeyPart(input.sourceId),
    input.kind,
    `${input.sha256.slice(0, 16)}-${sanitizeKeyPart(basename(input.filename))}`,
  ].join("/");
}

function renderArchivedMarkdown(input: {
  source: GrantSource;
  sourceId: string;
  filename: string;
  originalUrl: string;
  archiveUrl: string;
  markdown: string;
}): string {
  return [
    "---",
    `source: ${input.source}`,
    `source_id: ${input.sourceId}`,
    `filename: ${input.filename}`,
    `original_url: ${input.originalUrl}`,
    `archive_url: ${input.archiveUrl}`,
    "---",
    "",
    input.markdown,
  ].join("\n");
}

function inferContentType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".hwp") return "application/x-hwp";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".zip") return "application/zip";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

function sanitizeKeyPart(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\w .()[\]{}가-힣ㄱ-ㅎㅏ-ㅣ-]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 180) || "item";
}

function stripExtension(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
