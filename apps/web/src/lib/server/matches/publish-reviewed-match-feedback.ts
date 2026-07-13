import { eq, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { resolveGrantExtractionManifest, parseMatchFeedbackReviewJsonl, planMatchFeedbackReviewPublication } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();
const inputPath = readArg("input");
if (!inputPath) throw new Error("--input=<review-decisions.jsonl> is required");
const writeMode = process.argv.includes("--write");
if (writeMode && readArg("confirm") !== "publish-reviewed-feedback") {
  throw new Error("write mode requires --confirm=publish-reviewed-feedback");
}
const decisions = parseMatchFeedbackReviewJsonl(await readFile(inputPath, "utf8"), inputPath);
const db = getCunoteDb();
try {
  const ids = decisions.map((decision) => decision.feedbackId);
  const feedbackRows = ids.length === 0 ? [] : await db.select({
    id: schema.feedback.id,
    actor: schema.feedback.actor,
    targetId: schema.feedback.targetId,
    timestamp: schema.feedback.ts,
    value: schema.feedback.value,
  }).from(schema.feedback).where(inArray(schema.feedback.id, ids));
  const byId = new Map(feedbackRows.map((row) => [row.id, row]));
  const existingReviews = await db.select({ value: schema.feedback.value })
    .from(schema.feedback).where(eq(schema.feedback.actor, "reviewer"));
  const alreadyReviewed = new Set(existingReviews.map((row) => stringValue(row.value.reviewedFeedbackId)).filter(Boolean));
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const plans = [];
  for (const decision of decisions) {
    if (alreadyReviewed.has(decision.feedbackId)) throw new Error(`${decision.feedbackId}: review already published`);
    const feedback = byId.get(decision.feedbackId);
    if (!feedback) throw new Error(`${decision.feedbackId}: feedback not found`);
    const grantId = stringValue(feedback.value.grantId);
    if (!grantId) throw new Error(`${decision.feedbackId}: grantId missing from feedback`);
    const currentGrant = await repositories.grants.findGrantById(grantId);
    if (!currentGrant) throw new Error(`${decision.feedbackId}: current grant not found`);
    plans.push(planMatchFeedbackReviewPublication({
      decision,
      feedback: {
        id: feedback.id,
        actor: feedback.actor,
        targetId: feedback.targetId,
        timestamp: feedback.timestamp.toISOString(),
        value: feedback.value,
      },
      currentGrantRevision: resolveGrantExtractionManifest(currentGrant).revision,
    }));
  }
  if (writeMode && plans.length > 0) {
    await db.insert(schema.feedback).values(plans.map((plan) => ({
      targetType: "match" as const,
      targetId: plan.targetId,
      type: "implicit" as const,
      actor: "reviewer" as const,
      value: {
        reviewedFeedbackId: plan.reviewedFeedbackId,
        reviewDecision: plan.reviewDecision,
        reviewerId: plan.reviewerId,
        reviewedAt: plan.reviewedAt,
        note: plan.note,
        grantRevision: plan.grantRevision,
        evaluationCandidate: plan.evaluationCandidate,
        refreshScope: plan.refreshScope,
        refreshReason: plan.refreshReason,
      },
    })));
  }
  console.log(JSON.stringify({
    writeMode,
    decisionCount: decisions.length,
    plannedCount: plans.length,
    acceptedCount: plans.filter((plan) => plan.reviewDecision === "accepted").length,
    rejectedCount: plans.filter((plan) => plan.reviewDecision === "rejected").length,
    publishedCount: writeMode ? plans.length : 0,
    refreshScopeCounts: histogram(plans.map((plan) => plan.refreshScope)),
    operationalReady: false,
    nextGate: "accepted feedback remains an evaluation candidate until separate v3 annotation review/publication",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
