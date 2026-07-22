import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ApplicationRoundtripRun,
  RoundtripDocumentFormat,
  RoundtripFillResult,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { analysisLabDir } from "../run-store";

export interface RoundtripRunManifest {
  version: 1;
  runId: string;
  grantId: string;
  source: string;
  sourceId: string;
  attachments: Array<{
    attachmentId: string;
    filename: string;
    storageKey: string;
    sourceSha256: string;
    detectedFormat: RoundtripDocumentFormat;
  }>;
}

const RUN_ID = /^roundtrip-[0-9TZ.\-]{10,40}-[a-f0-9]{6}$/;
const FILL_ID = /^fill-[0-9TZ.\-]{10,40}-[a-f0-9]{6}$/;

export function buildRoundtripRunId(now = new Date()): string {
  return `roundtrip-${now.toISOString().replace(/:/g, "")}-${randomBytes(3).toString("hex")}`;
}

export function buildRoundtripFillId(now = new Date()): string {
  return `fill-${now.toISOString().replace(/:/g, "")}-${randomBytes(3).toString("hex")}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._\-]/g, "_");
}

export function applicationRoundtripDir(): string {
  return join(analysisLabDir(), "application-roundtrip");
}

function runDir(source: string, sourceId: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`허용되지 않는 roundtrip runId: ${runId}`);
  return join(applicationRoundtripDir(), `${sanitizeSegment(source)}__${sanitizeSegment(sourceId)}`, runId);
}

export async function saveRoundtripRun(input: {
  run: ApplicationRoundtripRun;
  manifest: RoundtripRunManifest;
  markdownByAttachmentId: Map<string, string>;
}): Promise<void> {
  const dir = runDir(input.run.source, input.run.sourceId, input.run.runId);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeJsonImmutable(join(dir, "analysis.json"), input.run),
    writeJsonImmutable(join(dir, "manifest.json"), input.manifest),
    ...[...input.markdownByAttachmentId].map(([attachmentId, markdown]) =>
      writeFile(join(dir, `${sanitizeSegment(attachmentId)}.parsed.md`), markdown, {
        encoding: "utf8",
        flag: "wx",
      })),
  ]);
}

export async function readRoundtripRunArtifacts(
  grantId: string,
  runId: string,
): Promise<{ run: ApplicationRoundtripRun; manifest: RoundtripRunManifest; dir: string } | null> {
  if (!RUN_ID.test(runId)) return null;
  let groups: string[];
  try {
    groups = await readdir(applicationRoundtripDir());
  } catch {
    return null;
  }
  for (const group of groups) {
    if (!group.includes("__")) continue;
    const dir = join(applicationRoundtripDir(), group, runId);
    try {
      const [run, manifest] = await Promise.all([
        readJson<ApplicationRoundtripRun>(join(dir, "analysis.json")),
        readJson<RoundtripRunManifest>(join(dir, "manifest.json")),
      ]);
      if (run.grantId === grantId && manifest.grantId === grantId) return { run, manifest, dir };
    } catch {
      // 다음 source/sourceId 그룹을 검사한다.
    }
  }
  return null;
}

export async function saveRoundtripFill(input: {
  runDir: string;
  result: RoundtripFillResult;
  request: Record<string, unknown>;
  output: Uint8Array;
}): Promise<void> {
  if (!FILL_ID.test(input.result.fillId)) throw new Error("허용되지 않는 fillId 형식입니다.");
  const dir = join(input.runDir, "fills", input.result.fillId);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeJsonImmutable(join(dir, "request.json"), input.request),
    writeJsonImmutable(join(dir, "result.json"), input.result),
    writeFile(join(dir, `filled.${input.result.outputFormat}`), input.output, { flag: "wx" }),
  ]);
}

export async function readRoundtripFillArtifact(input: {
  grantId: string;
  runId: string;
  fillId: string;
}): Promise<{ result: RoundtripFillResult; body: Buffer } | null> {
  if (!FILL_ID.test(input.fillId)) return null;
  const artifacts = await readRoundtripRunArtifacts(input.grantId, input.runId);
  if (!artifacts) return null;
  const fillDir = join(artifacts.dir, "fills", input.fillId);
  try {
    const result = await readJson<RoundtripFillResult>(join(fillDir, "result.json"));
    if (basename(result.outputFilename) !== result.outputFilename) return null;
    if (result.outputFormat !== "hwp" && result.outputFormat !== "hwpx") return null;
    const body = await readFile(join(fillDir, `filled.${result.outputFormat}`));
    return { result, body };
  } catch {
    return null;
  }
}

async function writeJsonImmutable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
