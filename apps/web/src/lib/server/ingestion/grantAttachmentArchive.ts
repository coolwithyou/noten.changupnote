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
import { detectHwpFormat } from "@cunote/core/documents/hwpx-fill";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import {
  extractOfficeContainerMarkdown,
  extractSupportedArchiveEntries,
  isArchiveContainerFilename,
} from "./archiveContainerInspection";

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

/**
 * 첨부 바이트(매직 바이트)로 hwp/hwpx surface 포맷을 확정한다 — 확장자 위장 교정(설계 결정 6).
 *
 * 실측 근거(2026-07-07): `.hwpx` 확장자를 단 hwp 바이너리 위장 파일이 스파이크 14건 중 3건 발견.
 * 확장자만 믿으면 위장 파일에 format="hwpx" surface 를 만들어 하류(변환 잡·HWPX 채움 버튼 플래그)를
 * 오염시킨다. 그래서 바이트가 확보되는 아카이브 시점에 매직 바이트로 확정한다.
 *
 * 판정 정책은 이 함수의 **반환값 의미로 고정**한다(주석 규칙이 아니라 코드 계약):
 *  - 확장자가 hwp/hwpx 계열이 아니면(pdf/docx/비대상) 매직 바이트를 적용하지 않고 확장자 판별을 그대로
 *    돌려준다. (pdf/docx 는 이번 범위 밖이며, docx·xlsx 도 PK zip 이라 매직만으로는 hwpx 와 구분되지
 *    않으므로 hancom 확장자에 한해서만 매직을 적용한다.)
 *  - "hwpx": 바이트 시그니처가 PK(zip 컨테이너) — 진짜 hwpx.
 *  - "hwp":  바이트 시그니처가 CFBF(D0CF11E0) — 구형 hwp 바이너리. 확장자가 `.hwpx` 여도 이쪽이 이긴다.
 *  - null:   확장자는 hwp/hwpx 인데 바이트가 zip 도 CFBF 도 아니라 어느 쪽도 확증되지 않음(정체 불명).
 *            보수적으로 surface 를 만들지 않는다(오염 차단). 확장자가 아예 비대상일 때도 null.
 */
export function detectConvertibleSurfaceFormatFromBytes(
  filename: string,
  body: Buffer,
): ConvertibleSurfaceFormat | null {
  const byExtension = detectConvertibleSurfaceFormat(filename);
  // hwp/hwpx 계열만 매직 바이트로 교정한다(범위 밖은 확장자 판별 유지).
  if (byExtension !== "hwp" && byExtension !== "hwpx") return byExtension;

  const magic = detectHwpFormat(body);
  if (magic === "hwpx") return "hwpx";
  if (magic === "hwp-binary") return "hwp";
  // magic === "unknown": 바이트가 hwp/hwpx 어느 쪽도 확증하지 못함 → 보수적으로 제외.
  return null;
}

/**
 * grant_raw.attachments JSON 에 실어 변환 후크(registerAttachmentConversions)까지 검출 결과를
 * 나르는 런타임 확장 키. contracts 의 attachment 타입 밖이며 grant_raw.attachments(JSONB)에 무해하게
 * 라이딩한다(DB 스키마 변경 없음 — grant_attachment_archives 컬럼은 건드리지 않는다).
 */
export const DETECTED_SURFACE_FORMAT_KEY = "detected_surface_format";

type RawAttachment = NonNullable<GrantRaw["attachments"]>[number];

/** rawAttachment 에 매직 바이트 검출 결과를 실어 둔다(바이트가 확보된 첨부에서만 호출). */
export function attachDetectedSurfaceFormat(
  attachment: RawAttachment,
  detected: ConvertibleSurfaceFormat | null,
): void {
  (attachment as Record<string, unknown>)[DETECTED_SURFACE_FORMAT_KEY] = detected;
}

/**
 * 첨부 JSON 에서 매직 바이트 검출 결과를 읽는다.
 *  - undefined: 바이트 검출을 수행하지 않은 첨부(byte-less 경로) → 호출부는 확장자 폴백(하위호환).
 *  - "hwp"|"hwpx"|"pdf"|"docx": 검출/판별된 포맷.
 *  - null: 바이트 검출을 했으나 변환 대상이 아님(제외).
 */
export function readDetectedSurfaceFormat(
  attachment: unknown,
): ConvertibleSurfaceFormat | null | undefined {
  if (!attachment || typeof attachment !== "object") return undefined;
  if (!(DETECTED_SURFACE_FORMAT_KEY in attachment)) return undefined;
  const value = (attachment as Record<string, unknown>)[DETECTED_SURFACE_FORMAT_KEY];
  if (value === null) return null;
  if (value === "hwp" || value === "hwpx" || value === "pdf" || value === "docx") return value;
  return undefined;
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
  imageOcr?: GrantImageOcrAdapter;
  minImageOcrConfidence?: number;
}

export type GrantImageOcrAdapter = (input: {
  filename: string;
  body: Buffer;
  contentType: string | null;
}) => Promise<{
  markdown: string;
  confidence: number;
  provider: string;
  converter: string;
}>;

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
      const archivedItems = isArchiveContainerFilename(attachment.filename)
        ? await archiveContainerAttachment(attachment, options)
        : [await archiveOneAttachment(attachment, options)];
      for (const archived of archivedItems) {
        attachments.push(archived.rawAttachment);
        archivedCount += 1;
        if (archived.failure) failures.push(archived.failure);
        if (archived.markdown) {
          convertedCount += 1;
          attachmentMarkdowns.push(archived.markdown);
        } else if (archived.rawAttachment.conversion?.status === "skipped") {
          skippedConversionCount += 1;
        }
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
  downloadedInput?: { body: Buffer; contentType: string | null },
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

  const downloaded = downloadedInput ?? await downloadAttachment(originalUrl, options.fetchImpl ?? fetch);
  const contentType = isPlainTextFilename(attachment.filename)
    ? inferContentType(attachment.filename)
    : downloaded.contentType ?? inferContentType(attachment.filename);
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

  // 바이트가 확보된 지점 — 확장자 위장을 매직 바이트로 교정해 surface 포맷을 확정하고,
  // 변환 후크까지 실어 나른다(설계 결정 6). byte-less 폴백 경로에는 이 키가 없어 확장자로 폴백한다.
  attachDetectedSurfaceFormat(
    rawAttachment,
    detectConvertibleSurfaceFormatFromBytes(attachment.filename, downloaded.body),
  );

  let converted: { markdown: string; converter: string; ocrProvider?: string; ocrConfidence?: number };
  try {
    if (isImageFilename(attachment.filename)) {
      if (!options.imageOcr) throw new Error("Image OCR adapter is not configured");
      const ocr = await options.imageOcr({ filename: attachment.filename, body: downloaded.body, contentType });
      const confidence = Math.min(1, Math.max(0, ocr.confidence));
      const minimumConfidence = options.minImageOcrConfidence ?? 0.6;
      const markdown = ocr.markdown.trim();
      if (confidence < minimumConfidence) {
        throw new Error(`Image OCR confidence ${confidence.toFixed(3)} is below ${minimumConfidence.toFixed(3)}`);
      }
      if (markdown.length < 20) throw new Error("Image OCR returned insufficient text");
      converted = {
        markdown,
        converter: ocr.converter,
        ocrProvider: ocr.provider,
        ocrConfidence: confidence,
      };
    } else if (isPlainTextFilename(attachment.filename)) {
      converted = {
        markdown: decodePlainText(downloaded.body),
        converter: "plain-text-v1",
      };
    } else if (/\.(?:xlsx|pptx)$/i.test(attachment.filename)) {
      const markdown = extractOfficeContainerMarkdown(attachment.filename, downloaded.body);
      if (!markdown) throw new Error("Office attachment did not contain extractable text");
      converted = { markdown, converter: "office-openxml-v1" };
    } else if (options.convertHwp && isHwpFilename(attachment.filename)) {
      converted = convertHwpBufferToMarkdown({
        filename: attachment.filename,
        body: downloaded.body,
        autoInstallPyhwp: options.autoInstallPyhwp,
      });
    } else {
      rawAttachment.conversion = { status: "skipped" };
      return { rawAttachment, markdown: null };
    }
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
    ...(converted.ocrProvider ? { ocr_provider: converted.ocrProvider } : {}),
    ...(typeof converted.ocrConfidence === "number" ? { ocr_confidence: converted.ocrConfidence } : {}),
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

type ArchivedAttachmentResult = Awaited<ReturnType<typeof archiveOneAttachment>>;

async function archiveContainerAttachment(
  attachment: SourceAttachment,
  options: GrantAttachmentArchiveOptions,
): Promise<ArchivedAttachmentResult[]> {
  if (!attachment.url) return [await archiveOneAttachment(attachment, options)];
  const downloaded = await downloadAttachment(attachment.url, options.fetchImpl ?? fetch);
  const parent = await archiveOneAttachment(attachment, options, downloaded);
  if (extname(attachment.filename).toLowerCase() !== ".zip") return [parent];
  try {
    const entries = extractSupportedArchiveEntries(attachment.filename, downloaded.body, {
      maxEntries: 10,
      maxEntryBytes: 20 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
    });
    const nested: ArchivedAttachmentResult[] = [];
    for (const [index, entry] of entries.entries()) {
      const nestedFilename = nestedArchiveFilename(attachment.filename, entry.filename, index);
      const nestedSourceUri = `zip:${attachment.url}#${encodeURIComponent(entry.filename)}`;
      nested.push(await archiveOneAttachment({
        filename: nestedFilename,
        url: nestedSourceUri,
      }, options, {
        body: entry.body,
        contentType: inferContentType(entry.filename),
      }));
    }
    return [parent, ...nested];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.allowFailures) throw error;
    parent.rawAttachment.conversion = { status: "failed", error: message };
    parent.failure = { filename: attachment.filename, url: attachment.url, message };
    return [parent];
  }
}

function nestedArchiveFilename(containerFilename: string, entryFilename: string, index: number): string {
  const extension = extname(entryFilename).slice(0, 12);
  const container = stripExtension(basename(containerFilename)).slice(0, 80);
  const entry = stripExtension(basename(entryFilename)).slice(0, 120);
  return `${container}__${String(index + 1).padStart(2, "0")}__${entry}${extension}`;
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
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".hwp") return "application/x-hwp";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".zip") return "application/zip";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

function isPlainTextFilename(filename: string): boolean {
  return extname(filename).toLowerCase() === ".txt";
}

function isImageFilename(filename: string): boolean {
  return /\.(?:png|jpe?g)$/i.test(filename);
}

function decodePlainText(body: Buffer): string {
  if (body.length > 5 * 1024 * 1024) throw new Error("Plain text attachment exceeds 5 MiB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body).replace(/\u0000/g, "").trim();
  if (!text) throw new Error("Plain text attachment is empty");
  return text;
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
