import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = resolve(process.cwd(), "apps/web/scripts/macos-vision-ocr.swift");

export interface ImageOcrResult {
  text: string;
  averageConfidence: number;
  lineCount: number;
  lines: Array<{ text: string; confidence: number }>;
  provider: "macos_vision";
  converter: "macos-vision-ocr-v1";
}

export async function recognizeImageWithMacosVision(input: {
  filename: string;
  body: Buffer;
  timeoutMs?: number;
}): Promise<ImageOcrResult> {
  if (process.platform !== "darwin") throw new Error("macOS Vision OCR requires darwin");
  if (input.body.length === 0) throw new Error("OCR image is empty");
  if (input.body.length > 20 * 1024 * 1024) throw new Error("OCR image exceeds 20 MiB");
  const directory = await mkdtemp(join(tmpdir(), "cunote-vision-ocr-"));
  const extension = /^\.(?:png|jpe?g)$/i.test(extname(input.filename)) ? extname(input.filename) : ".png";
  const path = join(directory, `input${extension}`);
  try {
    await writeFile(path, input.body, { flag: "wx" });
    const { stdout } = await execFileAsync("swift", [SCRIPT_PATH, path], {
      encoding: "utf8",
      timeout: input.timeoutMs ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseMacosVisionOcrResponse(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function macosVisionGrantImageOcr(input: {
  filename: string;
  body: Buffer;
  contentType: string | null;
}): Promise<{ markdown: string; confidence: number; provider: string; converter: string }> {
  const result = await recognizeImageWithMacosVision({ filename: input.filename, body: input.body });
  return {
    markdown: result.text,
    confidence: result.averageConfidence,
    provider: result.provider,
    converter: result.converter,
  };
}

export function parseMacosVisionOcrResponse(value: string): ImageOcrResult {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  const averageConfidence = finiteUnitNumber(parsed.averageConfidence);
  const lines = Array.isArray(parsed.lines) ? parsed.lines.flatMap((line) => {
    if (!line || typeof line !== "object") return [];
    const candidate = line as Record<string, unknown>;
    const lineText = typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (!lineText) return [];
    return [{ text: lineText, confidence: finiteUnitNumber(candidate.confidence) }];
  }) : [];
  const lineCount = Number.isInteger(parsed.lineCount) ? Number(parsed.lineCount) : lines.length;
  if (!text || lines.length === 0) throw new Error("macOS Vision OCR returned no text");
  return {
    text: text.slice(0, 200_000),
    averageConfidence,
    lineCount,
    lines: lines.slice(0, 5_000),
    provider: "macos_vision",
    converter: "macos-vision-ocr-v1",
  };
}

function finiteUnitNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}
