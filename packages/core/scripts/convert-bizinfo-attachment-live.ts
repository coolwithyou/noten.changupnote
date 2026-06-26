import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildBizInfoProgramExtractionInput,
  fetchBizInfoPrograms,
  htmlToText,
} from "../src/index.js";

loadDotEnv();

const serviceKey = process.env.BIZINFO_SERVICE_KEY;
if (!serviceKey) {
  console.error("Missing BIZINFO_SERVICE_KEY. Set it in the environment or .env.");
  process.exit(2);
}

const sourceId = readArg("sourceId");
const full = readArg("full") === "true";
const autoInstallPyhwp = readArg("autoInstallPyhwp") !== "false";
const keepTmp = readArg("keepTmp") === "true";

const payload = await fetchBizInfoPrograms({ serviceKey });
const program = sourceId
  ? payload.jsonArray.find((row) => row.pblancId === sourceId)
  : payload.jsonArray.find((row) => {
      const input = buildBizInfoProgramExtractionInput(row);
      return input.metadata.attachments.some((attachment) => isHwpFilename(attachment.filename));
    });

if (!program) {
  throw new Error(sourceId ? `No Bizinfo program found for ${sourceId}` : "No program with .hwp attachment found");
}

const baseInput = buildBizInfoProgramExtractionInput(program);
const attachment = baseInput.metadata.attachments.find((item) => isHwpFilename(item.filename));
if (!attachment?.url) {
  throw new Error(`No downloadable .hwp attachment found for ${program.pblancId}`);
}

const workDir = mkdtempSync(join(tmpdir(), "cunote-bizinfo-hwp."));
const safeName = sanitizeFilename(attachment.filename);
const hwpPath = join(workDir, safeName);
const xhtmlPath = join(workDir, `${stripExtension(safeName)}.xhtml`);

try {
  const downloaded = await downloadFile(attachment.url, hwpPath);
  const hwp5html = ensureHwp5Html({ workDir, autoInstallPyhwp });
  convertHwpToXhtml(hwp5html, hwpPath, xhtmlPath);
  const xhtml = readFileSync(xhtmlPath, "utf8");
  const markdown = htmlToText(xhtml);
  const extractionInput = buildBizInfoProgramExtractionInput(program, {
    attachmentMarkdowns: [{ filename: attachment.filename, markdown, source_uri: attachment.url }],
  });

  console.log(JSON.stringify({
    source_id: extractionInput.source_id,
    title: extractionInput.title,
    attachment: {
      filename: attachment.filename,
      url: attachment.url,
      downloaded_bytes: downloaded.bytes,
      content_type: downloaded.contentType,
    },
    converter: hwp5html.description,
    work_dir: keepTmp ? workDir : null,
    xhtml_bytes: Buffer.byteLength(xhtml),
    converted_text_length: markdown.length,
    extraction_input_length: extractionInput.text.length,
    preview: full
      ? extractionInput.text
      : `${extractionInput.text.slice(0, 1800)}${extractionInput.text.length > 1800 ? "\n..." : ""}`,
  }, null, 2));
} finally {
  if (!keepTmp) rmSync(workDir, { recursive: true, force: true });
}

async function downloadFile(url: string, outputPath: string): Promise<{ bytes: number; contentType: string | null }> {
  const response = await fetch(url, { headers: { accept: "*/*" } });
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error("Attachment download produced an empty file");
  writeFileSync(outputPath, body);
  return { bytes: body.length, contentType: response.headers.get("content-type") };
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
    throw new Error("hwp5html not found. Install pyhwp or run with --autoInstallPyhwp=true.");
  }

  const pyhwpDir = join(options.workDir, "pyhwp");
  const install = spawnSync("python3", ["-m", "pip", "install", "--target", pyhwpDir, "pyhwp"], {
    encoding: "utf8",
  });
  if (install.status !== 0) {
    throw new Error(`pyhwp install failed\n${install.stdout}\n${install.stderr}`);
  }
  const bin = join(pyhwpDir, "bin", "hwp5html");
  if (!existsSync(bin)) throw new Error("pyhwp installed but hwp5html was not found");
  return {
    bin,
    env: { ...process.env, PYTHONPATH: pyhwpDir },
    description: "temporary pyhwp install",
  };
}

function convertHwpToXhtml(
  hwp5html: { bin: string; env: NodeJS.ProcessEnv },
  hwpPath: string,
  xhtmlPath: string,
) {
  const result = spawnSync(hwp5html.bin, ["--html", "--output", xhtmlPath, hwpPath], {
    encoding: "utf8",
    env: hwp5html.env,
  });
  if (result.status !== 0) {
    throw new Error(`hwp5html failed\n${result.stdout}\n${result.stderr}`);
  }
  if (!existsSync(xhtmlPath)) throw new Error("hwp5html did not produce XHTML output");
}

function isHwpFilename(filename: string): boolean {
  return /\.hwp$/i.test(filename);
}

function sanitizeFilename(filename: string): string {
  const name = basename(filename).replace(/[^\w .()[\]{}가-힣ㄱ-ㅎㅏ-ㅣ-]/g, "_");
  return name || "attachment.hwp";
}

function stripExtension(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

function loadDotEnv(path = ".env") {
  try {
    const body = readFileSync(resolve(path), "utf8");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      if (!rawKey) continue;
      const key = rawKey.trim();
      if (process.env[key] !== undefined) continue;
      let value = rest.join("=").trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // .env is optional in CI.
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
