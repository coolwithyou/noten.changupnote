import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateGrantAudience,
  parseGrantAudienceAnnotationJsonl,
  type GrantAudiencePrediction,
} from "../src/index.js";

const annotationsPath = resolve(readArg("annotations") ?? "tmp/grant-audience-draft-annotations.jsonl");
const tasksPath = resolve(readArg("tasks") ?? "tmp/grant-audience-review-tasks.jsonl");
const verify = process.argv.includes("--verify");
const annotations = parseGrantAudienceAnnotationJsonl(readFileSync(annotationsPath, "utf8"), annotationsPath);
const predictions = readFileSync(tasksPath, "utf8").split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index): GrantAudiencePrediction => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.recordType !== "grant_audience_review_task") throw new Error(`${tasksPath}:${index + 1}: invalid recordType`);
    if (typeof record.grantId !== "string") throw new Error(`${tasksPath}:${index + 1}: missing grantId`);
    if (!isAudience(record.predictedAudience)) throw new Error(`${tasksPath}:${index + 1}: invalid predictedAudience`);
    if (typeof record.safeToExcludeFromBusinessMatching !== "boolean") {
      throw new Error(`${tasksPath}:${index + 1}: invalid safeToExcludeFromBusinessMatching`);
    }
    return {
      grantId: record.grantId,
      predictedAudience: record.predictedAudience,
      safeToExcludeFromBusinessMatching: record.safeToExcludeFromBusinessMatching,
    };
  });
const report = evaluateGrantAudience(annotations, predictions);
console.log(JSON.stringify({ annotationsPath, tasksPath, ...report }, null, 2));
if (verify && !report.operationalReady) {
  console.error("Audience gate failed: reviewed>=60, actual individual>=20, individual precision>=0.95, business preservation recall>=0.98 required.");
  process.exitCode = 1;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function isAudience(value: unknown): value is "company" | "individual" | "mixed" | "unknown" {
  return value === "company" || value === "individual" || value === "mixed" || value === "unknown";
}
