import { getCunoteDb, type CunoteDb } from "@/lib/server/db/client";
import {
  acquireLocalSubscriptionLease,
  releaseLocalSubscriptionLease,
  renewLocalSubscriptionLease,
} from "../deep-analysis/runtimeControl";
import type { DeepRepairLeaseClient } from "./deep-repair-live-runtime";

const LIVE_EXPERIMENT_CHANGED_BY = "lab:experiment";

interface DeepRepairLiveDbLeaseDependencies {
  readonly getDb?: () => CunoteDb;
  readonly changedBy?: string;
  readonly reason?: string;
}

/** Gate R의 receipt-bound 단건 실행만 쓰는 exact-generation DB lease client. */
export function createDeepRepairLiveDbLeaseClient(
  dependencies: DeepRepairLiveDbLeaseDependencies = {},
): DeepRepairLeaseClient {
  const readDb = dependencies.getDb ?? getCunoteDb;
  const changedBy = dependencies.changedBy ?? LIVE_EXPERIMENT_CHANGED_BY;
  const reason = dependencies.reason ?? "딥분석 실험 exact authority lease";
  return {
    acquire({ ownerId, expectedGeneration }) {
      return acquireLocalSubscriptionLease({
        db: readDb(),
        ownerId,
        expectedGeneration,
        changedBy,
        reason,
      });
    },
    renew({ ownerId, generation }) {
      return renewLocalSubscriptionLease({
        db: readDb(),
        ownerId,
        generation,
      });
    },
    async release({ ownerId, generation }) {
      await releaseLocalSubscriptionLease({
        db: readDb(),
        ownerId,
        generation,
        changedBy,
      });
    },
  };
}
