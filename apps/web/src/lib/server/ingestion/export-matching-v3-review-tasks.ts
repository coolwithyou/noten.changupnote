import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildMatchingV3GrantReviewTask,
  normalizeKStartupPayload,
  type KStartupApiResponse,
  type MatchingV3GrantReviewTask,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

interface SeedManifest {
  schemaVersion: string;
  sourceFixture: string;
  grantSelection: Array<{ source: "kstartup" | "bizinfo"; sourceId: string; status: string }>;
}

loadMonorepoEnv();

const workspaceRoot = findWorkspaceRoot();
const manifestPath = resolveWorkspacePath(
  workspaceRoot,
  readArg("manifest") ?? "packages/core/golden/matching-v3/seed-manifest.json",
);
const outputPath = resolveWorkspacePath(
  workspaceRoot,
  readArg("output") ?? "tmp/matching-v3-review-tasks.jsonl",
);
const annotationOutputPath = resolveWorkspacePath(
  workspaceRoot,
  readArg("annotations-output") ?? "tmp/matching-v3-draft-grants.jsonl",
);
const force = process.argv.includes("--force");
const stdout = process.argv.includes("--stdout");

if (!stdout && !force) {
  const existing = [outputPath, annotationOutputPath].filter(existsSync);
  if (existing.length > 0) {
    throw new Error(`출력 파일이 이미 있습니다. 덮어쓰려면 --force를 사용하세요: ${existing.join(", ")}`);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SeedManifest;
const samplePath = resolveWorkspacePath(workspaceRoot, manifest.sourceFixture);
const sample = JSON.parse(readFileSync(samplePath, "utf8")) as KStartupApiResponse;
const sampleEntries = normalizeKStartupPayload(sample, {
  asOf: new Date("2026-07-12T00:00:00.000+09:00"),
  collectedAt: new Date("2026-07-12T00:00:00.000+09:00"),
});
const sampleBySourceId = new Map(sampleEntries.map((entry) => [entry.grant.source_id, entry]));
const db = getCunoteDb();

try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const tasks: MatchingV3GrantReviewTask[] = [];
  const missing: string[] = [];

  for (const selection of manifest.grantSelection) {
    if (selection.source === "kstartup") {
      const entry = sampleBySourceId.get(selection.sourceId);
      if (!entry) {
        missing.push(`${selection.source}:${selection.sourceId}`);
        continue;
      }
      tasks.push(buildMatchingV3GrantReviewTask(entry, { sourceFixture: manifest.sourceFixture }));
      continue;
    }

    const entry = await repositories.grants.findGrantById(`${selection.source}:${selection.sourceId}`);
    if (!entry) {
      missing.push(`${selection.source}:${selection.sourceId}`);
      continue;
    }
    tasks.push(buildMatchingV3GrantReviewTask(entry));
  }

  if (missing.length > 0) {
    throw new Error(`seed 공고를 찾지 못했습니다: ${missing.join(", ")}`);
  }

  const jsonl = `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`;
  if (stdout) {
    process.stdout.write(jsonl);
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    mkdirSync(dirname(annotationOutputPath), { recursive: true });
    writeFileSync(outputPath, jsonl, "utf8");
    writeFileSync(
      annotationOutputPath,
      `${tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`,
      "utf8",
    );
    console.log(JSON.stringify({
      ok: true,
      schemaVersion: manifest.schemaVersion,
      output: relativePath(workspaceRoot, outputPath),
      annotationOutput: relativePath(workspaceRoot, annotationOutputPath),
      taskCount: tasks.length,
      bySource: histogram(tasks.map((task) => task.source)),
      byReadiness: histogram(tasks.map((task) => task.readiness)),
      warningCounts: histogram(tasks.flatMap((task) => task.warnings)),
      annotationTemplateCount: tasks.filter((task) => task.annotationTemplate.labelStatus === "draft").length,
      reminder: "annotationTemplate은 예측 초안이며 reviewer 확정 전 평가에 포함하지 않습니다.",
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function findWorkspaceRoot(): string {
  let current = process.cwd();
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("workspace root를 찾지 못했습니다.");
    current = parent;
  }
}

function resolveWorkspacePath(workspaceRoot: string, value: string): string {
  return isAbsolute(value) ? value : resolve(workspaceRoot, value);
}

function relativePath(workspaceRoot: string, value: string): string {
  return value.startsWith(`${workspaceRoot}/`) ? value.slice(workspaceRoot.length + 1) : value;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function histogram(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
