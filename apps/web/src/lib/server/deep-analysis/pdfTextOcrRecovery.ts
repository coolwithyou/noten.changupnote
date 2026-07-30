import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { upsertDocumentArtifacts } from "@/lib/server/conversion/surfaceConversion";
import {
  objectKey,
  renderArchivedMarkdown,
  type GrantImageOcrAdapter,
} from "@/lib/server/ingestion/grantAttachmentArchive";
import { tesseractGrantImageOcr } from "@/lib/server/ingestion/tesseractImageOcr";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { sha256Hex } from "./sourceRevision";

const execFileAsync = promisify(execFile);
const MIN_EXTRACTED_TEXT_CHARS = 200;
const MIN_OCR_TEXT_CHARS = 20;
const MIN_OCR_CONFIDENCE = 0.6;
// 대용량 통합 공고는 OCR로 밀어붙이지 않고 기존 사람 분리 절차에 남긴다.
const MAX_IMAGE_OCR_PAGES = 20;

export interface PdfTextOcrRecoveryTarget {
  grantId: string;
  source: "kstartup" | "bizinfo";
  sourceId: string;
  opaqueCommitmentSha256: string;
}

export interface PdfTextOcrRecoveryCandidate {
  target: PdfTextOcrRecoveryTarget;
  surfaceId: string;
  title: string;
  sourceUrl: string | null;
  sourceAttachment: string;
  pdfStorageKey: string;
  pdfSha256: string;
  pageCount: number;
  pageImages: Array<{
    page: number;
    storageKey: string;
    sha256: string;
    contentType: string | null;
  }>;
}

export interface PdfTextOcrRecoveryResult {
  candidateCount: number;
  candidatesBySource: Record<"kstartup" | "bizinfo", number>;
  succeededCount: number;
  failedCount: number;
  recoveredCommitments: string[];
  failures: Array<{ opaqueCommitmentSha256: string; error: string }>;
  results: Array<{
    opaqueCommitmentSha256: string;
    mode: "pdftotext_layout" | "page_image_ocr" | "local_render_ocr";
    pageCount: number;
    textChars: number;
    averageConfidence: number | null;
    markdownSha256: string;
  }>;
}

export async function listPdfTextOcrRecoveryCandidates(input: {
  db: CunoteDb;
  targets: readonly PdfTextOcrRecoveryTarget[];
}): Promise<PdfTextOcrRecoveryCandidate[]> {
  if (input.targets.length === 0) return [];
  const targetByGrantId = new Map(
    input.targets.map((target) => [target.grantId, target]),
  );
  const surfaces = await input.db.select({
    id: schema.grantApplicationSurfaces.id,
    grantId: schema.grantApplicationSurfaces.grantId,
    title: schema.grantApplicationSurfaces.title,
    sourceUrl: schema.grantApplicationSurfaces.sourceUrl,
    sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
  }).from(schema.grantApplicationSurfaces).where(and(
    inArray(
      schema.grantApplicationSurfaces.grantId,
      input.targets.map((target) => target.grantId),
    ),
    eq(schema.grantApplicationSurfaces.format, "pdf"),
  ));
  if (surfaces.length === 0) return [];
  const artifacts = await input.db.select({
    surfaceId: schema.documentArtifacts.surfaceId,
    kind: schema.documentArtifacts.kind,
    page: schema.documentArtifacts.page,
    storageKey: schema.documentArtifacts.storageKey,
    sha256: schema.documentArtifacts.sha256,
    contentType: schema.documentArtifacts.contentType,
    metadata: schema.documentArtifacts.metadata,
  }).from(schema.documentArtifacts).where(
    inArray(
      schema.documentArtifacts.surfaceId,
      surfaces.map((surface) => surface.id),
    ),
  ).orderBy(
    asc(schema.documentArtifacts.surfaceId),
    asc(schema.documentArtifacts.page),
  );

  return surfaces.flatMap((surface): PdfTextOcrRecoveryCandidate[] => {
    const target = targetByGrantId.get(surface.grantId);
    const surfaceArtifacts = artifacts.filter(
      (artifact) => artifact.surfaceId === surface.id,
    );
    if (
      !target
      || !surface.sourceAttachment
      || surfaceArtifacts.some((artifact) => artifact.kind === "markdown")
    ) {
      return [];
    }
    const pdfArtifacts = surfaceArtifacts.filter(
      (artifact) => artifact.kind === "pdf",
    );
    if (pdfArtifacts.length !== 1 || !pdfArtifacts[0]?.sha256) return [];
    const pageCount = finitePositiveInteger(
      pdfArtifacts[0].metadata?.pageCount,
    );
    if (pageCount === null) return [];
    const pageImages = surfaceArtifacts
      .filter((artifact) => (
        artifact.kind === "page_image"
        && artifact.page !== null
        && artifact.sha256 !== null
      ))
      .map((artifact) => ({
        page: artifact.page!,
        storageKey: artifact.storageKey,
        sha256: artifact.sha256!,
        contentType: artifact.contentType,
      }))
      .sort((left, right) => left.page - right.page);
    return [{
      target,
      surfaceId: surface.id,
      title: surface.title,
      sourceUrl: surface.sourceUrl,
      sourceAttachment: surface.sourceAttachment,
      pdfStorageKey: pdfArtifacts[0].storageKey,
      pdfSha256: pdfArtifacts[0].sha256,
      pageCount,
      pageImages,
    }];
  });
}

export async function recoverPdfTextOcrCandidates(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  candidates: readonly PdfTextOcrRecoveryCandidate[];
  imageOcr?: GrantImageOcrAdapter;
}): Promise<PdfTextOcrRecoveryResult> {
  const results: PdfTextOcrRecoveryResult["results"] = [];
  const failures: PdfTextOcrRecoveryResult["failures"] = [];
  for (const candidate of input.candidates) {
    try {
      const recovered = await recoverOneCandidate({
        ...input,
        candidate,
      });
      results.push(recovered);
    } catch (error) {
      failures.push({
        opaqueCommitmentSha256:
          candidate.target.opaqueCommitmentSha256,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    candidateCount: input.candidates.length,
    candidatesBySource: {
      kstartup: input.candidates.filter(
        (candidate) => candidate.target.source === "kstartup",
      ).length,
      bizinfo: input.candidates.filter(
        (candidate) => candidate.target.source === "bizinfo",
      ).length,
    },
    succeededCount: results.length,
    failedCount: failures.length,
    recoveredCommitments: results
      .map((result) => result.opaqueCommitmentSha256)
      .sort(),
    failures,
    results,
  };
}

async function recoverOneCandidate(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  candidate: PdfTextOcrRecoveryCandidate;
  imageOcr?: GrantImageOcrAdapter;
}): Promise<PdfTextOcrRecoveryResult["results"][number]> {
  const pdf = await input.storage.getObjectBytes(
    input.candidate.pdfStorageKey,
  );
  if (sha256Hex(pdf.body) !== input.candidate.pdfSha256) {
    throw new Error("PDF artifact SHA-256 mismatch");
  }
  const extracted = await extractPdfTextLayout(pdf.body);
  let mode: PdfTextOcrRecoveryResult["results"][number]["mode"];
  let markdown: string;
  let averageConfidence: number | null = null;
  let converter = "quality-pdftotext-layout-v1";
  if (extracted.length >= MIN_EXTRACTED_TEXT_CHARS) {
    mode = "pdftotext_layout";
    markdown = extracted;
  } else {
    if (input.candidate.pageCount > MAX_IMAGE_OCR_PAGES) {
      throw new Error(
        `PDF has ${input.candidate.pageCount} image pages; OCR cap is `
        + `${MAX_IMAGE_OCR_PAGES} and this notice requires human split review`,
      );
    }
    const images = input.candidate.pageImages.length > 0
      ? await loadVerifiedPageImages({
        storage: input.storage,
        pageCount: input.candidate.pageCount,
        pageImages: input.candidate.pageImages,
      })
      : await renderLocalPdfPages({
        pdf: pdf.body,
        pageCount: input.candidate.pageCount,
      });
    mode = input.candidate.pageImages.length > 0
      ? "page_image_ocr"
      : "local_render_ocr";
    const ocr = await buildPdfPageOcrMarkdown({
      title: input.candidate.title,
      images,
      imageOcr: input.imageOcr ?? tesseractGrantImageOcr,
    });
    markdown = ocr.markdown;
    averageConfidence = ocr.averageConfidence;
    converter = ocr.converter;
  }

  const archiveUrl = input.candidate.sourceUrl
    ?? input.storage.publicUrl(input.candidate.sourceAttachment);
  const markdownBody = renderArchivedMarkdown({
    source: input.candidate.target.source,
    sourceId: input.candidate.target.sourceId,
    filename: input.candidate.title,
    originalUrl: archiveUrl,
    archiveUrl,
    markdown,
  });
  const markdownSha256 = sha256Hex(markdownBody);
  const markdownKey = objectKey({
    source: input.candidate.target.source,
    sourceId: input.candidate.target.sourceId,
    filename: `${input.candidate.title.replace(/\.pdf$/i, "")}.md`,
    sha256: markdownSha256,
    kind: "markdown",
  });
  const uploaded = await input.storage.putObject({
    key: markdownKey,
    body: markdownBody,
    contentType: "text/markdown; charset=utf-8",
  });
  if (sha256Hex(await input.storage.getObjectText(uploaded.key)) !== markdownSha256) {
    throw new Error("Uploaded PDF recovery markdown failed SHA-256 readback");
  }
  await upsertDocumentArtifacts(input.db, input.candidate.surfaceId, [{
    kind: "markdown",
    storageKey: uploaded.key,
    url: uploaded.url,
    sha256: markdownSha256,
    contentType: "text/markdown; charset=utf-8",
    metadata: {
      converter,
      recoveryMode: mode,
      pageCount: input.candidate.pageCount,
      charCount: markdown.length,
      ...(averageConfidence === null ? {} : { averageConfidence }),
    },
  }]);
  return {
    opaqueCommitmentSha256:
      input.candidate.target.opaqueCommitmentSha256,
    mode,
    pageCount: input.candidate.pageCount,
    textChars: markdown.length,
    averageConfidence,
    markdownSha256,
  };
}

export function normalizePdfTextLayout(value: string): string {
  return value
    .split("\f")
    .map((page, index) => {
      const text = page.replace(/[ \t]+$/gm, "").trim();
      return text ? `## Page ${index + 1}\n\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function buildPdfPageOcrMarkdown(input: {
  title: string;
  images: ReadonlyArray<{
    page: number;
    body: Buffer;
    contentType: string | null;
  }>;
  imageOcr: GrantImageOcrAdapter;
}): Promise<{ markdown: string; averageConfidence: number; converter: string }> {
  if (input.images.length === 0) throw new Error("PDF OCR has no page images");
  const pages = [];
  let confidenceTotal = 0;
  const converters = new Set<string>();
  for (const image of input.images) {
    const ocr = await input.imageOcr({
      filename: `${basename(input.title, ".pdf")}-page-${image.page}.png`,
      body: image.body,
      contentType: image.contentType,
    });
    const text = ocr.markdown.trim();
    const confidence = Math.min(1, Math.max(0, ocr.confidence));
    if (confidence < MIN_OCR_CONFIDENCE) {
      throw new Error(
        `PDF page ${image.page} OCR confidence ${confidence.toFixed(3)}`
        + ` is below ${MIN_OCR_CONFIDENCE.toFixed(3)}`,
      );
    }
    if (text.length < MIN_OCR_TEXT_CHARS) {
      throw new Error(`PDF page ${image.page} OCR returned insufficient text`);
    }
    confidenceTotal += confidence;
    converters.add(ocr.converter);
    pages.push(`## Page ${image.page}\n\n${text}`);
  }
  return {
    markdown: pages.join("\n\n"),
    averageConfidence: confidenceTotal / input.images.length,
    converter: [...converters].sort().join("+"),
  };
}

async function extractPdfTextLayout(pdf: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cunote-pdf-text-"));
  const path = join(directory, "input.pdf");
  try {
    await writeFile(path, pdf, { flag: "wx" });
    const { stdout } = await execFileAsync(
      "pdftotext",
      ["-layout", path, "-"],
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return normalizePdfTextLayout(stdout);
  } catch {
    return "";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function loadVerifiedPageImages(input: {
  storage: R2ObjectStorage;
  pageCount: number;
  pageImages: PdfTextOcrRecoveryCandidate["pageImages"];
}): Promise<Array<{ page: number; body: Buffer; contentType: string | null }>> {
  if (
    input.pageImages.length !== input.pageCount
    || input.pageImages.some((image, index) => image.page !== index + 1)
  ) {
    throw new Error("PDF page image set is incomplete");
  }
  return Promise.all(input.pageImages.map(async (image) => {
    const stored = await input.storage.getObjectBytes(image.storageKey);
    if (sha256Hex(stored.body) !== image.sha256) {
      throw new Error(`PDF page ${image.page} image SHA-256 mismatch`);
    }
    return {
      page: image.page,
      body: stored.body,
      contentType: stored.contentType ?? image.contentType,
    };
  }));
}

async function renderLocalPdfPages(input: {
  pdf: Buffer;
  pageCount: number;
}): Promise<Array<{ page: number; body: Buffer; contentType: string | null }>> {
  if (input.pageCount > MAX_IMAGE_OCR_PAGES) {
    throw new Error(
      `PDF has ${input.pageCount} pages without text/page images; local OCR cap is `
      + `${MAX_IMAGE_OCR_PAGES}`,
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "cunote-pdf-render-"));
  const pdfPath = join(directory, "input.pdf");
  const outputPrefix = join(directory, "page");
  try {
    await writeFile(pdfPath, input.pdf, { flag: "wx" });
    await execFileAsync(
      "pdftoppm",
      [
        "-png",
        "-r",
        "160",
        "-f",
        "1",
        "-l",
        String(input.pageCount),
        pdfPath,
        outputPrefix,
      ],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const paths = (await readdir(directory))
      .filter((path) => /^page-\d+\.png$/.test(path))
      .sort((left, right) => pageNumber(left) - pageNumber(right));
    if (paths.length !== input.pageCount) {
      throw new Error("Local PDF renderer produced an incomplete page set");
    }
    return Promise.all(paths.map(async (path) => ({
      page: pageNumber(path),
      body: await readFile(join(directory, path)),
      contentType: "image/png",
    })));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pageNumber(filename: string): number {
  const value = Number(filename.match(/-(\d+)\.png$/)?.[1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid rendered PDF page filename: ${filename}`);
  }
  return value;
}

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    ? value
    : null;
}
