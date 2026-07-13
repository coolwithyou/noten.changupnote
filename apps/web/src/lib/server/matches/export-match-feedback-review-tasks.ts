import { and, eq, gte } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();
const output = resolve(readArg("output") ?? "tmp/match-feedback-review-tasks.jsonl");
const since = dateArg(readArg("since")) ?? new Date(Date.now() - 90 * 86_400_000);
const db = getCunoteDb();
try {
  const rows = await db.select({
    id: schema.feedback.id,
    actor: schema.feedback.actor,
    targetId: schema.feedback.targetId,
    timestamp: schema.feedback.ts,
    value: schema.feedback.value,
  }).from(schema.feedback).where(and(
    eq(schema.feedback.targetType, "match"),
    gte(schema.feedback.ts, since),
  ));
  const reviewedIds = new Set(rows
    .filter((row) => row.actor === "reviewer")
    .map((row) => stringValue(row.value.reviewedFeedbackId))
    .filter((value): value is string => value !== null));
  const tasks = rows.filter((row) => row.actor === "user" && !reviewedIds.has(row.id) && (
    row.value.kind === "wrong" || isRecord(row.value.correction)
  )).map((row) => ({
    schemaVersion: "matching-feedback-review-task-v1",
    feedbackId: row.id,
    targetId: row.targetId,
    submittedAt: row.timestamp.toISOString(),
    kind: stringValue(row.value.kind),
    reasonCode: stringValue(row.value.reasonCode),
    correction: isRecord(row.value.correction) ? row.value.correction : null,
    provenance: isRecord(row.value.provenance) ? row.value.provenance : null,
    annotationTemplate: {
      schemaVersion: "matching-feedback-review-v1",
      feedbackId: row.id,
      decision: null,
      reviewerId: null,
      reviewedAt: null,
      note: null,
    },
  }));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${tasks.map((task) => JSON.stringify(task)).join("\n")}${tasks.length ? "\n" : ""}`, "utf8");
  console.log(JSON.stringify({
    writeMode: false,
    databaseWrite: false,
    since: since.toISOString(),
    taskCount: tasks.length,
    output,
    excludedAlreadyReviewed: reviewedIds.size,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function dateArg(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
