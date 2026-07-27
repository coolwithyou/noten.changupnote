import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  resolveAggregateSplitPromotionPolicy,
  runAggregateSplitPromotionInvocation,
} from "./aggregateSplitPromotion";

loadMonorepoEnv();

if (
  process.env.AGGREGATE_SPLIT_PROMOTION_EXECUTE !== "1"
  && !process.argv.includes("--execute")
) {
  throw new Error(
    "Aggregate split staged promotion is fail-closed. "
    + "Set AGGREGATE_SPLIT_PROMOTION_EXECUTE=1 or pass --execute.",
  );
}

const storage = createR2ObjectStorageFromEnv();
if (!storage) throw new Error("R2 storage environment is incomplete");
const db = getCunoteDb();

try {
  const policy = resolveAggregateSplitPromotionPolicy();
  const result = await runAggregateSplitPromotionInvocation({
    db,
    storage,
    policy,
  });
  console.log(JSON.stringify({
    ok: result.failed === 0 && result.retryPending === 0,
    modelPath: "existing_deep_analysis_validator_ai_audit",
    activeFeederBypassReason: "aggregate_split_staged_direct_enqueue",
    policy,
    ...result,
  }));
  if (result.failed > 0 || result.retryPending > 0) process.exitCode = 1;
} finally {
  await closeCunoteDb();
}
