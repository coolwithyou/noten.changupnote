import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ApplicationRoundtripRun,
  RoundtripDocumentFormat,
  RoundtripFillResult,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { analysisLabDir, findMonorepoRoot } from "../run-store";

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

export interface RoundtripRunArtifacts {
  run: ApplicationRoundtripRun;
  manifest: RoundtripRunManifest;
  dir: string;
}

export interface ExactRoundtripRunArtifacts extends RoundtripRunArtifacts {
  readonly analysisSha256: string;
  readonly manifestSha256: string;
  readonly parsedMarkdown: readonly {
    readonly attachmentId: string;
    readonly sha256: string;
  }[];
  readonly markdownByAttachmentId: ReadonlyMap<string, string>;
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

export function applicationRoundtripDir(repositoryRoot?: string): string {
  return join(repositoryRoot ? join(repositoryRoot, "spike-out", "analysis-lab") : analysisLabDir(), "application-roundtrip");
}

function runDir(source: string, sourceId: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`허용되지 않는 roundtrip runId: ${runId}`);
  return join(applicationRoundtripDir(), `${sanitizeSegment(source)}__${sanitizeSegment(sourceId)}`, runId);
}

/**
 * launch manifest에 SHA를 봉인할 때 쓰는 strict reader다. runId를 암묵적으로 최신 선택하지 않고,
 * 같은 runId가 여러 source group에 있으면 어느 artifact도 임의 채택하지 않는다.
 */
export async function readExactRoundtripRunArtifacts(input: {
  readonly grantId: string;
  readonly runId: string;
  readonly repositoryRoot?: string;
}): Promise<ExactRoundtripRunArtifacts | null> {
  if (!RUN_ID.test(input.runId)) return null;
  let root: string;
  try {
    const repositoryRoot = await realpath(input.repositoryRoot ?? findMonorepoRoot());
    root = await realpathInside(
      repositoryRoot,
      applicationRoundtripDir(repositoryRoot),
      "Kordoc application-roundtrip root",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let groups: string[];
  try {
    groups = await readdir(root);
  } catch {
    return null;
  }
  const matches: ExactRoundtripRunArtifacts[] = [];
  for (const group of groups.sort()) {
    if (!group.includes("__")) continue;
    const dir = join(root, group, input.runId);
    try {
      await lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const exactDir = await realpathInside(root, dir, "Kordoc run directory");
    let analysisBytes: Buffer;
    let manifestBytes: Buffer;
    try {
      [analysisBytes, manifestBytes] = await Promise.all([
        readFile(await realpathInside(root, join(exactDir, "analysis.json"), "Kordoc analysis")),
        readFile(await realpathInside(root, join(exactDir, "manifest.json"), "Kordoc manifest")),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Kordoc exact artifact 일부가 없습니다: ${input.runId}`);
      }
      throw error;
    }
    let run: ApplicationRoundtripRun;
    let manifest: RoundtripRunManifest;
    try {
      run = JSON.parse(analysisBytes.toString("utf8")) as ApplicationRoundtripRun;
      manifest = JSON.parse(manifestBytes.toString("utf8")) as RoundtripRunManifest;
    } catch {
      throw new Error(`Kordoc exact artifact JSON이 손상됐습니다: ${input.runId}`);
    }
    if (
      run.runId !== input.runId
      || manifest.runId !== input.runId
      || run.grantId !== input.grantId
      || manifest.grantId !== input.grantId
    ) {
      throw new Error(`Kordoc exact artifact identity가 요청과 다릅니다: ${input.runId}`);
    }
    if (!Array.isArray(manifest.attachments)) {
      throw new Error(`Kordoc exact manifest attachments가 배열이 아닙니다: ${input.runId}`);
    }
    const markdownEntries = await Promise.all(manifest.attachments.map(async (attachment, index) => {
      if (typeof attachment.attachmentId !== "string" || attachment.attachmentId.trim() === "") {
        throw new Error(`Kordoc exact manifest attachmentId가 잘못됐습니다: ${index}`);
      }
      const markdownPath = await realpathInside(
        root,
        join(exactDir, `${sanitizeSegment(attachment.attachmentId)}.parsed.md`),
        `Kordoc parsed markdown ${index}`,
      );
      const bytes = await readFile(markdownPath);
      return Object.freeze({
        attachmentId: attachment.attachmentId,
        sha256: sha256(bytes),
        markdown: bytes.toString("utf8"),
      });
    }));
    markdownEntries.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
    matches.push({
      run,
      manifest,
      dir: exactDir,
      analysisSha256: sha256(analysisBytes),
      manifestSha256: sha256(manifestBytes),
      parsedMarkdown: Object.freeze(markdownEntries.map(({ attachmentId, sha256: digest }) =>
        Object.freeze({ attachmentId, sha256: digest }))),
      markdownByAttachmentId: new Map(markdownEntries.map(({ attachmentId, markdown }) =>
        [attachmentId, markdown])),
    });
  }
  if (matches.length > 1) {
    throw new Error(`Kordoc exact artifact runId가 여러 source에 중복됐습니다: ${input.runId}`);
  }
  return matches[0] ?? null;
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
): Promise<RoundtripRunArtifacts | null> {
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

/** 관리자 로컬 preview가 현재 원본 SHA와 대조할 수 있도록 최신 순 불변 산출물을 읽는다. */
export async function listRoundtripRunArtifactsForSource(input: {
  grantId: string;
  source: string;
  sourceId: string;
}): Promise<RoundtripRunArtifacts[]> {
  const sourceDir = join(
    applicationRoundtripDir(),
    `${sanitizeSegment(input.source)}__${sanitizeSegment(input.sourceId)}`,
  );
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch {
    return [];
  }
  const artifacts = await Promise.all(entries
    .filter((entry) => RUN_ID.test(entry))
    .map(async (runId): Promise<RoundtripRunArtifacts | null> => {
      const dir = join(sourceDir, runId);
      try {
        const [run, manifest] = await Promise.all([
          readJson<ApplicationRoundtripRun>(join(dir, "analysis.json")),
          readJson<RoundtripRunManifest>(join(dir, "manifest.json")),
        ]);
        if (
          run.runId !== runId
          || manifest.runId !== runId
          || run.grantId !== input.grantId
          || manifest.grantId !== input.grantId
          || run.source !== input.source
          || manifest.source !== input.source
          || run.sourceId !== input.sourceId
          || manifest.sourceId !== input.sourceId
        ) return null;
        return { run, manifest, dir };
      } catch {
        return null;
      }
    }));
  return artifacts
    .filter((item): item is RoundtripRunArtifacts => item !== null)
    .sort((left, right) => right.run.startedAt.localeCompare(left.run.startedAt));
}

/** 재결속 시 불변 분석 JSON과 함께 복제해야 할 파싱 markdown을 모두 읽는다. */
export async function readRoundtripMarkdownByAttachmentId(input: {
  manifest: RoundtripRunManifest;
  dir: string;
}): Promise<Map<string, string>> {
  const entries = await Promise.all(input.manifest.attachments.map(async (attachment) => [
    attachment.attachmentId,
    await readFile(join(input.dir, `${sanitizeSegment(attachment.attachmentId)}.parsed.md`), "utf8"),
  ] as const));
  return new Map(entries);
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function realpathInside(root: string, path: string, label: string): Promise<string> {
  const actual = await realpath(path);
  const relation = relative(root, actual);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label}가 application-roundtrip 저장소 밖을 가리킵니다.`);
  }
  return resolve(actual);
}
