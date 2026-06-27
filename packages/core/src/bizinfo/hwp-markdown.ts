import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { htmlToText } from "./extraction-input.js";

export interface HwpMarkdownConverterStatus {
  available: boolean;
  description: string;
  bin?: string;
  error?: string;
}

export interface HwpMarkdownResult {
  markdown: string;
  converter: string;
  xhtmlBytes: number;
}

export function isHwpFilename(filename: string): boolean {
  return /\.(?:hwp|hwpx)$/i.test(filename);
}

let cachedAutoConverter: {
  bin: string;
  env: NodeJS.ProcessEnv;
  description: string;
} | null = null;

export function detectHwpMarkdownConverter(options: {
  autoInstallPyhwp?: boolean;
  workDir?: string;
} = {}): HwpMarkdownConverterStatus {
  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), "cunote-hwp-status."));
  const cleanup = options.workDir ? false : true;
  try {
    const converter = ensureHwp5Html({
      workDir,
      autoInstallPyhwp: options.autoInstallPyhwp ?? false,
    });
    return {
      available: true,
      description: converter.description,
      bin: converter.bin,
    };
  } catch (error) {
    return {
      available: false,
      description: "hwp5html unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (cleanup) rmSync(workDir, { recursive: true, force: true });
  }
}

export function convertHwpBufferToMarkdown(input: {
  filename: string;
  body: Buffer;
  autoInstallPyhwp?: boolean;
  keepTmp?: boolean;
}): HwpMarkdownResult {
  if (!isHwpFilename(input.filename)) {
    throw new Error(`Unsupported HWP attachment filename: ${input.filename}`);
  }
  if (/\.hwpx$/i.test(input.filename)) return convertHwpxBufferToMarkdown(input);

  const workDir = mkdtempSync(join(tmpdir(), "cunote-hwp-convert."));
  const safeName = sanitizeFilename(input.filename);
  const hwpPath = join(workDir, safeName);
  const xhtmlPath = join(workDir, `${stripExtension(safeName)}.xhtml`);

  try {
    writeFileSync(hwpPath, input.body);
    const converter = ensureHwp5Html({
      workDir,
      autoInstallPyhwp: input.autoInstallPyhwp ?? true,
    });
    convertHwpToXhtml(converter, hwpPath, xhtmlPath);
    const xhtml = readFileSync(xhtmlPath, "utf8");
    return {
      markdown: htmlToText(xhtml),
      converter: converter.description,
      xhtmlBytes: Buffer.byteLength(xhtml),
    };
  } finally {
    if (!input.keepTmp) rmSync(workDir, { recursive: true, force: true });
  }
}

function ensureHwp5Html(options: { workDir: string; autoInstallPyhwp: boolean }): {
  bin: string;
  env: NodeJS.ProcessEnv;
  description: string;
} {
  const explicit = process.env.HWP5HTML_BIN;
  if (explicit && existsSync(explicit)) {
    return { bin: explicit, env: process.env, description: `HWP5HTML_BIN=${explicit}` };
  }

  const pathHit = spawnSync("sh", ["-lc", "command -v hwp5html"], { encoding: "utf8" });
  const pathBin = pathHit.stdout.trim();
  if (pathHit.status === 0 && pathBin) {
    return { bin: pathBin, env: process.env, description: `PATH hwp5html=${pathBin}` };
  }

  if (!options.autoInstallPyhwp) {
    throw new Error("hwp5html not found. Install pyhwp or enable autoInstallPyhwp.");
  }
  if (cachedAutoConverter && existsSync(cachedAutoConverter.bin)) return cachedAutoConverter;

  const pyhwpDir = process.env.CUNOTE_PYHWP_DIR || join(tmpdir(), "cunote-pyhwp-cache");
  const bin = join(pyhwpDir, "bin", "hwp5html");
  if (!existsSync(bin)) {
    const install = spawnSync("python3", ["-m", "pip", "install", "--target", pyhwpDir, "pyhwp"], {
      encoding: "utf8",
    });
    if (install.status !== 0) {
      throw new Error(`pyhwp install failed\n${install.stdout}\n${install.stderr}`);
    }
  }
  if (!existsSync(bin)) throw new Error("pyhwp installed but hwp5html was not found");
  cachedAutoConverter = {
    bin,
    env: { ...process.env, PYTHONPATH: pyhwpDir },
    description: `pyhwp cache=${pyhwpDir}`,
  };
  return cachedAutoConverter;
}

function convertHwpxBufferToMarkdown(input: {
  filename: string;
  body: Buffer;
  keepTmp?: boolean;
}): HwpMarkdownResult {
  const workDir = mkdtempSync(join(tmpdir(), "cunote-hwpx-convert."));
  const safeName = sanitizeFilename(input.filename);
  const hwpxPath = join(workDir, safeName);
  try {
    writeFileSync(hwpxPath, input.body);
    const result = spawnSync("unzip", ["-p", hwpxPath, "Contents/section*.xml"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`hwpx unzip failed\n${result.stdout}\n${result.stderr}`);
    }
    return {
      markdown: xmlToText(result.stdout),
      converter: "hwpx-xml-unzip-v1",
      xhtmlBytes: Buffer.byteLength(result.stdout),
    };
  } finally {
    if (!input.keepTmp) rmSync(workDir, { recursive: true, force: true });
  }
}

function convertHwpToXhtml(
  converter: { bin: string; env: NodeJS.ProcessEnv },
  hwpPath: string,
  xhtmlPath: string,
) {
  const result = spawnSync(converter.bin, ["--html", "--output", xhtmlPath, hwpPath], {
    encoding: "utf8",
    env: converter.env,
  });
  if (result.status !== 0) {
    throw new Error(`hwp5html failed\n${result.stdout}\n${result.stderr}`);
  }
  if (!existsSync(xhtmlPath)) throw new Error("hwp5html did not produce XHTML output");
}

function sanitizeFilename(filename: string): string {
  const name = basename(filename).replace(/[^\w .()[\]{}가-힣ㄱ-ㅎㅏ-ㅣ-]/g, "_");
  return name || "attachment.hwp";
}

function stripExtension(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

function xmlToText(value: string): string {
  return decodeXmlEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}
