import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildBizInfoDraftReviewTask,
  buildKStartupDraftReviewTask,
  parseBizInfoCriteriaDraftJsonl,
  parseKStartupCriteriaDraftJsonl,
  type BizInfoProgram,
  type KStartupAnnouncement,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const source = readSource(readArg("source"));
const inputPath = resolve(readArg("input") ?? `tmp/${source}-llm-drafts.jsonl`);
const outputPath = resolve(readArg("output") ?? `tmp/${source}-llm-review-tasks.jsonl`);
const annotationsPath = resolve(readArg("annotations-output") ?? `tmp/${source}-llm-draft-annotations.jsonl`);
const force = process.argv.includes("--force");
if (!existsSync(inputPath)) throw new Error(`draft input not found: ${inputPath}`);
if (!force && (existsSync(outputPath) || existsSync(annotationsPath))) {
  throw new Error("output exists; use --force to replace review artifacts");
}
const inputText = readFileSync(inputPath, "utf8");
const dataset = source === "kstartup"
  ? parseKStartupCriteriaDraftJsonl(inputText, inputPath)
  : parseBizInfoCriteriaDraftJsonl(inputText, inputPath);
if (dataset.drafts.length === 0) throw new Error(`no successful ${source} criteria drafts to review`);

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<KStartupAnnouncement | BizInfoProgram>({ dialect: "drizzle", client: db });
  const tasks = [];
  for (const draft of dataset.drafts) {
    const entry = await repositories.grants.findGrantById(`${source}:${draft.sourceId}`);
    if (!entry) throw new Error(`current grant not found: ${source}:${draft.sourceId}`);
    tasks.push(source === "kstartup"
      ? buildKStartupDraftReviewTask(entry, draft as import("@cunote/core").KStartupCriteriaDraft)
      : buildBizInfoDraftReviewTask(entry, draft as import("@cunote/core").BizInfoCriteriaDraft));
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(annotationsPath), { recursive: true });
  writeFileSync(outputPath, `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`, "utf8");
  writeFileSync(annotationsPath, `${tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    source,
    draftCount: dataset.drafts.length,
    extractionErrorCount: dataset.errors.length,
    taskCount: tasks.length,
    outputPath,
    annotationsPath,
    operationalReady: false,
    reminder: "annotation templates remain draft until independent reviewer metadata is complete",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function readSource(value: string | undefined): "kstartup" | "bizinfo" {
  if (!value || value === "kstartup") return "kstartup";
  if (value === "bizinfo") return "bizinfo";
  throw new Error("--source must be kstartup|bizinfo");
}
