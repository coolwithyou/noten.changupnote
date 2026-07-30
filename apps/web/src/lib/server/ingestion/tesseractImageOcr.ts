import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { GrantImageOcrAdapter } from "./grantAttachmentArchive";

const execFileAsync = promisify(execFile);
const DEFAULT_LANGUAGES = "kor+eng";

export interface TesseractTsvResult {
  markdown: string;
  confidence: number;
  lineCount: number;
}

/**
 * Cloud Run 안에서 실행되는 로컬 OCR이다. 외부 모델 호출이나 추가 원가가 없으며,
 * PDF 변환기가 페이지 이미지만 만든 이미지형 공고의 마지막 텍스트 복구 수단으로 쓴다.
 */
export const tesseractGrantImageOcr: GrantImageOcrAdapter = async (input) => {
  const directory = await mkdtemp(join(tmpdir(), "cunote-tesseract-"));
  const extension = safeImageExtension(input.filename, input.contentType);
  const imagePath = join(directory, `input${extension}`);
  try {
    await writeFile(imagePath, input.body, { flag: "wx" });
    const { stdout } = await execFileAsync(
      "tesseract",
      [
        imagePath,
        "stdout",
        "-l",
        process.env.TESSERACT_OCR_LANGUAGES?.trim() || DEFAULT_LANGUAGES,
        "--psm",
        "6",
        "tsv",
      ],
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const parsed = parseTesseractTsv(stdout);
    return {
      markdown: parsed.markdown,
      confidence: parsed.confidence,
      provider: "tesseract",
      converter: `tesseract-ocr-v1/${process.env.TESSERACT_OCR_LANGUAGES?.trim() || DEFAULT_LANGUAGES}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export function parseTesseractTsv(tsv: string): TesseractTsvResult {
  const rows = tsv.split(/\r?\n/);
  const header = rows.shift()?.split("\t") ?? [];
  const indexes = {
    page: header.indexOf("page_num"),
    block: header.indexOf("block_num"),
    paragraph: header.indexOf("par_num"),
    line: header.indexOf("line_num"),
    confidence: header.indexOf("conf"),
    text: header.indexOf("text"),
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error("Tesseract TSV header is incomplete");
  }

  const lines = new Map<string, string[]>();
  const confidences: number[] = [];
  for (const row of rows) {
    if (!row.trim()) continue;
    const cells = row.split("\t");
    const text = cells[indexes.text]?.trim();
    if (!text) continue;
    const confidence = Number(cells[indexes.confidence]);
    if (Number.isFinite(confidence) && confidence >= 0) {
      confidences.push(Math.min(100, confidence) / 100);
    }
    const key = [
      cells[indexes.page],
      cells[indexes.block],
      cells[indexes.paragraph],
      cells[indexes.line],
    ].join(":");
    lines.set(key, [...(lines.get(key) ?? []), text]);
  }
  const markdown = [...lines.values()]
    .map((words) => words.join(" "))
    .join("\n")
    .trim();
  if (!markdown) throw new Error("Tesseract OCR returned no text");
  return {
    markdown,
    confidence: confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : 0,
    lineCount: lines.size,
  };
}

function safeImageExtension(filename: string, contentType: string | null): string {
  const extension = extname(filename).toLowerCase();
  if (/^\.(png|jpe?g|webp|tiff?|bmp)$/.test(extension)) return extension;
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/tiff") return ".tiff";
  return ".png";
}
