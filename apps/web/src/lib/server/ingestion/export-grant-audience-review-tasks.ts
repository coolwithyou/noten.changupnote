import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  classifyGrantAudience,
  resolveGrantExtractionManifest,
  type GrantAudienceAnnotation,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const outputPath = resolve(readArg("output") ?? "tmp/grant-audience-review-tasks.jsonl");
const annotationsPath = resolve(readArg("annotations-output") ?? "tmp/grant-audience-draft-annotations.jsonl");
const scanLimit = boundedInteger(readArg("scanLimit"), 2_000, 1, 2_000);
const force = process.argv.includes("--force");
if (!force && (existsSync(outputPath) || existsSync(annotationsPath))) {
  throw new Error("audience review output exists; use --force to replace generated drafts");
}

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ limit: scanLimit, asOf: new Date() });
  const candidates = grants.map((entry) => {
    const classification = classifyGrantAudience({
      source: entry.grant.source,
      title: entry.grant.title,
      payload: entry.raw.payload,
    });
    const grantId = `${entry.grant.source}:${entry.grant.source_id}`;
    const sourceRevision = resolveGrantExtractionManifest(entry).revision;
    const annotationTemplate: GrantAudienceAnnotation = {
      recordType: "grant_audience_annotation",
      schemaVersion: "grant-audience-v1",
      grantId,
      source: entry.grant.source,
      sourceId: entry.grant.source_id,
      title: entry.grant.title,
      sourceRevision,
      expectedAudience: "unknown",
      labelStatus: "draft",
      annotatorId: null,
      annotatedAt: null,
      reviewerId: null,
      reviewedAt: null,
      note: "",
    };
    return {
      recordType: "grant_audience_review_task" as const,
      schemaVersion: "grant-audience-review-task-v1" as const,
      grantId,
      source: entry.grant.source,
      sourceId: entry.grant.source_id,
      title: entry.grant.title,
      sourceRevision,
      targetSummary: targetSummary(entry.grant.source, entry.raw.payload),
      predictedAudience: classification.audience,
      confidence: classification.confidence,
      stage: classification.stage,
      safeToExcludeFromBusinessMatching: classification.safeToExcludeFromBusinessMatching,
      signals: classification.signals,
      annotationTemplate,
    };
  });
  const selected = stratifiedSelection(candidates);
  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(annotationsPath), { recursive: true });
  writeFileSync(outputPath, `${selected.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  writeFileSync(annotationsPath, `${selected.map((item) => JSON.stringify(item.annotationTemplate)).join("\n")}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    writeMode: false,
    matchingFilterEnabled: false,
    scannedGrantCount: grants.length,
    taskCount: selected.length,
    predictedAudienceCounts: histogram(selected.map((item) => item.predictedAudience)),
    sourceCounts: histogram(selected.map((item) => item.source)),
    outputPath,
    annotationsPath,
    nextGate: "two-person review then individual precision >= 0.95",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function stratifiedSelection<T extends {
  grantId: string;
  title: string;
  predictedAudience: "company" | "individual" | "mixed" | "unknown";
}>(items: T[]): T[] {
  const sorted = [...items].sort((left, right) => left.grantId.localeCompare(right.grantId));
  const individual = sorted.filter((item) => item.predictedAudience === "individual").slice(0, 40);
  const mixed = sorted.filter((item) => item.predictedAudience === "mixed").slice(0, 10);
  const unknown = sorted.filter((item) => item.predictedAudience === "unknown").slice(0, 40);
  const traps = sorted.filter((item) =>
    item.predictedAudience === "company" && /청년|학생|교육|양성|공모전|대회|인턴|아카데미/u.test(item.title)).slice(0, 20);
  const selectedIds = new Set([...individual, ...mixed, ...unknown, ...traps].map((item) => item.grantId));
  const company = sorted.filter((item) => item.predictedAudience === "company" && !selectedIds.has(item.grantId)).slice(0, 20);
  return [...individual, ...mixed, ...unknown, ...traps, ...company];
}

function targetSummary(source: string, payload: unknown): string {
  const record = isRecord(payload) ? payload : {};
  const fields = source === "kstartup"
    ? [record.aply_trgt, record.aply_trgt_ctnt]
    : [record.trgetNm, record.bsnsSumryCn];
  const value = fields.filter((item): item is string => typeof item === "string")
    .join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return value.length <= 2_000 ? value : `${value.slice(0, 1_999)}…`;
}

function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
