import { getCunoteDb } from "@/lib/server/db/client";
import {
  getDeepAnalysisRuntimeControl,
  recoverExpiredLocalSubscriptionLease,
} from "@/lib/server/deep-analysis/runtimeControl";
import {
  createDeepRepairRecovery,
  type DeepRepairRecoveryRuntimeSnapshot,
} from "./deep-repair-recovery";
import { createDeepRepairRecoveryFilesystemRepository } from "./deep-repair-recovery-fs";

const recovery = createDeepRepairRecovery({
  repository: createDeepRepairRecoveryFilesystemRepository(),
  runtime: {
    async inspect() {
      return toRecoveryRuntimeSnapshot(
        await getDeepAnalysisRuntimeControl(getCunoteDb()),
      );
    },
    async recoverExpiredLease(input) {
      return toRecoveryRuntimeSnapshot(
        await recoverExpiredLocalSubscriptionLease({
          db: getCunoteDb(),
          ownerId: input.ownerId,
          expectedGeneration: input.expectedGeneration,
          expectedLeaseExpiresAt: exactDate(input.expectedLeaseExpiresAt),
          changeReason: input.changeReason,
        }),
      );
    },
  },
});

/** 비정상 종료 attempt와 runtime을 변경 없이 관측한다. */
export function inspectDeepRepairRecovery(input: {
  readonly authorityId: string;
}) {
  return recovery.inspect(input);
}

/** 사용자 승인에 결속된 exact attempt를 상태별로 복구한다. 모델 미착수만 새 승인을 다시 허용한다. */
export function recoverApprovedDeepRepairAttempt(input: {
  readonly approvalId: string;
  readonly signal: AbortSignal;
}) {
  return recovery.recoverApproved(input);
}

function toRecoveryRuntimeSnapshot(input: {
  readonly mode: string;
  readonly generation: number;
  readonly localOwnerId: string | null;
  readonly localLeaseExpiresAt: string | null;
  readonly changedBy: string;
  readonly changeReason: string | null;
  readonly updatedAt: string;
}): DeepRepairRecoveryRuntimeSnapshot {
  return {
    mode: input.mode,
    generation: input.generation,
    localOwnerId: input.localOwnerId,
    localLeaseExpiresAt: input.localLeaseExpiresAt,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
    updatedAt: input.updatedAt,
  };
}

function exactDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("recovery lease expiry는 canonical ISO timestamp여야 합니다.");
  }
  return date;
}
