import assert from "node:assert/strict";
import type { CunoteDb } from "../db/client";
import { runReviewedFeedbackScopedRefresh } from "./reviewedFeedbackScopedRefreshCore";

await assert.rejects(() => runReviewedFeedbackScopedRefresh({
  db: {} as CunoteDb,
  reviewerFeedbackId: "review-1",
  limit: 10,
  asOf: new Date("2026-07-12T00:00:00.000Z"),
  write: true,
  correctionApplied: false,
}), /correctionApplied=true/);
console.log("reviewedFeedbackScopedRefreshCore.test.ts: write safety assertion passed");
