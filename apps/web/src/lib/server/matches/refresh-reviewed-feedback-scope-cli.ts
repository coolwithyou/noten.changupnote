import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { runReviewedFeedbackScopedRefresh } from "./reviewedFeedbackScopedRefreshCore";

loadMonorepoEnv();
const reviewerFeedbackId = readArg("reviewerFeedbackId");
if (!reviewerFeedbackId) throw new Error("--reviewerFeedbackId=<uuid> is required");
const write = hasFlag("write");
const correctionApplied = hasFlag("correction-applied");
if (write && readArg("confirm") !== "REFRESH_REVIEWED_FEEDBACK_SCOPE") {
  throw new Error("write requires --confirm=REFRESH_REVIEWED_FEEDBACK_SCOPE");
}
const limit = boundedInteger(readArg("limit"), 500, 1, 2_000);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const db = getCunoteDb();
try {
  const report = await runReviewedFeedbackScopedRefresh({
    db,
    reviewerFeedbackId,
    limit,
    asOf,
    write,
    correctionApplied,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`limit must be ${min}..${max}`);
  return parsed;
}
function dateArg(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}
