import {
  canRunLocalSubscriptionAnalysis,
  canRunProductionDeepAnalysis,
  effectiveDeepAnalysisRuntimeMode,
  parseDeepAnalysisRuntimeMode,
  type DeepAnalysisRuntimeControl,
} from "@cunote/contracts";
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import type { CunoteDb, CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

const CONTROL_KEY = "global" as const;
export const LOCAL_ANALYSIS_LEASE_TTL_SECONDS = 120;
export const LOCAL_ANALYSIS_OWNER_HEADER = "x-cunote-local-analysis-owner";

type RuntimeControlRow = typeof schema.deepAnalysisRuntimeControl.$inferSelect;

export class DeepAnalysisRuntimeControlError extends Error {
  constructor(
    readonly code:
      | "runtime_control_missing"
      | "runtime_control_conflict"
      | "local_owner_required"
      | "local_subscription_not_allowed",
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "DeepAnalysisRuntimeControlError";
  }
}

export async function getDeepAnalysisRuntimeControl(
  db: CunoteDbSession,
): Promise<DeepAnalysisRuntimeControl> {
  const [row] = await db.select().from(schema.deepAnalysisRuntimeControl)
    .where(eq(schema.deepAnalysisRuntimeControl.controlKey, CONTROL_KEY))
    .limit(1);
  if (!row) {
    throw new DeepAnalysisRuntimeControlError(
      "runtime_control_missing",
      "딥분석 실행 모드 정본이 없습니다. migration 0069를 먼저 적용하세요.",
      503,
    );
  }
  return serializeRuntimeControl(row);
}

export async function isProductionDeepAnalysisAllowed(
  db: CunoteDbSession,
  now: Date = new Date(),
): Promise<{ allowed: boolean; control: DeepAnalysisRuntimeControl }> {
  const control = await getDeepAnalysisRuntimeControl(db);
  return { allowed: canRunProductionDeepAnalysis(control, now), control };
}

export async function assertLocalSubscriptionAnalysisAllowed(input: {
  db: CunoteDbSession;
  ownerId: string | null | undefined;
  now?: Date;
}): Promise<DeepAnalysisRuntimeControl> {
  const ownerId = input.ownerId?.trim();
  if (!ownerId) {
    throw new DeepAnalysisRuntimeControlError(
      "local_owner_required",
      "로컬 분석 권한 owner가 없습니다. 배치 운영에서 로컬 분석 권한을 먼저 획득하세요.",
      401,
    );
  }
  const control = await getDeepAnalysisRuntimeControl(input.db);
  if (!canRunLocalSubscriptionAnalysis(control, ownerId, input.now)) {
    throw new DeepAnalysisRuntimeControlError(
      "local_subscription_not_allowed",
      control.mode === "production_api"
        ? "운영 API 자동화가 켜져 있어 로컬 구독 분석을 시작할 수 없습니다."
        : "이 로컬 세션의 분석 권한이 없거나 임대가 만료됐습니다.",
    );
  }
  return control;
}

/**
 * 수 분 걸리는 로컬 단건 요청은 브라우저 탭이 닫혀도 서버 요청이 끝날 때까지 lease를
 * 유지한다. 갱신 실패는 다음 주기에 재시도하며 DB 장애 중에는 ops 전환도 성공할 수 없다.
 */
export async function runWithLocalSubscriptionLeaseHeartbeat<T>(input: {
  db: CunoteDb;
  ownerId: string | null | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  const ownerId = input.ownerId?.trim();
  await assertLocalSubscriptionAnalysisAllowed({ db: input.db, ownerId });
  let renewalInFlight = false;
  const timer = setInterval(() => {
    if (renewalInFlight || !ownerId) return;
    renewalInFlight = true;
    void renewLocalSubscriptionLease({ db: input.db, ownerId })
      .catch(() => undefined)
      .finally(() => { renewalInFlight = false; });
  }, 45_000);
  try {
    return await input.run();
  } finally {
    clearInterval(timer);
  }
}

export async function acquireLocalSubscriptionLease(input: {
  db: CunoteDb;
  ownerId: string;
  changedBy: string;
  reason?: string | null;
  now?: Date;
  ttlSeconds?: number;
}): Promise<DeepAnalysisRuntimeControl> {
  const ownerId = requireOwnerId(input.ownerId);
  const now = input.now ?? new Date();
  const leaseExpiresAt = leaseExpiry(now, input.ttlSeconds);
  const [row] = await input.db.update(schema.deepAnalysisRuntimeControl).set({
    mode: "local_subscription",
    generation: sql`${schema.deepAnalysisRuntimeControl.generation} + 1`,
    changedBy: input.changedBy.slice(0, 200),
    changeReason: input.reason?.slice(0, 1_000) ?? "로컬 구독 분석 권한 획득",
    localOwnerId: ownerId,
    localLeaseExpiresAt: leaseExpiresAt,
    updatedAt: now,
  }).where(and(
    eq(schema.deepAnalysisRuntimeControl.controlKey, CONTROL_KEY),
    or(
      eq(schema.deepAnalysisRuntimeControl.mode, "paused"),
      and(
        eq(schema.deepAnalysisRuntimeControl.mode, "local_subscription"),
        or(
          eq(schema.deepAnalysisRuntimeControl.localOwnerId, ownerId),
          lte(schema.deepAnalysisRuntimeControl.localLeaseExpiresAt, now),
        ),
      ),
    ),
  )).returning();
  if (!row) {
    throw new DeepAnalysisRuntimeControlError(
      "runtime_control_conflict",
      "운영 API 자동화가 켜져 있거나 다른 로컬 세션이 분석 권한을 사용 중입니다.",
    );
  }
  return serializeRuntimeControl(row);
}

export async function renewLocalSubscriptionLease(input: {
  db: CunoteDb;
  ownerId: string;
  now?: Date;
  ttlSeconds?: number;
}): Promise<DeepAnalysisRuntimeControl> {
  const ownerId = requireOwnerId(input.ownerId);
  const now = input.now ?? new Date();
  const [row] = await input.db.update(schema.deepAnalysisRuntimeControl).set({
    localLeaseExpiresAt: leaseExpiry(now, input.ttlSeconds),
    updatedAt: now,
  }).where(and(
    eq(schema.deepAnalysisRuntimeControl.controlKey, CONTROL_KEY),
    eq(schema.deepAnalysisRuntimeControl.mode, "local_subscription"),
    eq(schema.deepAnalysisRuntimeControl.localOwnerId, ownerId),
    gt(schema.deepAnalysisRuntimeControl.localLeaseExpiresAt, now),
  )).returning();
  if (!row) {
    throw new DeepAnalysisRuntimeControlError(
      "runtime_control_conflict",
      "로컬 분석 권한이 만료됐거나 다른 세션이 소유하고 있습니다. 다시 획득하세요.",
    );
  }
  return serializeRuntimeControl(row);
}

export async function releaseLocalSubscriptionLease(input: {
  db: CunoteDb;
  ownerId: string;
  changedBy: string;
  now?: Date;
}): Promise<DeepAnalysisRuntimeControl> {
  const ownerId = requireOwnerId(input.ownerId);
  const now = input.now ?? new Date();
  const [row] = await input.db.update(schema.deepAnalysisRuntimeControl).set({
    mode: "paused",
    generation: sql`${schema.deepAnalysisRuntimeControl.generation} + 1`,
    changedBy: input.changedBy.slice(0, 200),
    changeReason: "로컬 구독 분석 권한 해제",
    localOwnerId: null,
    localLeaseExpiresAt: null,
    updatedAt: now,
  }).where(and(
    eq(schema.deepAnalysisRuntimeControl.controlKey, CONTROL_KEY),
    eq(schema.deepAnalysisRuntimeControl.mode, "local_subscription"),
    eq(schema.deepAnalysisRuntimeControl.localOwnerId, ownerId),
  )).returning();
  if (!row) {
    throw new DeepAnalysisRuntimeControlError(
      "runtime_control_conflict",
      "이 로컬 세션이 소유한 분석 권한이 없습니다.",
    );
  }
  return serializeRuntimeControl(row);
}

export function runtimeControlView(
  control: DeepAnalysisRuntimeControl,
  now: Date = new Date(),
) {
  const effectiveMode = effectiveDeepAnalysisRuntimeMode(control, now);
  return {
    ...control,
    effectiveMode,
    productionAllowed: effectiveMode === "production_api",
    localAllowed: effectiveMode === "local_subscription",
    activeDeepLeases: 0,
    activeApplicationLeases: 0,
  };
}

export function localAnalysisOwnerFromRequest(request: Request): string | null {
  return request.headers.get(LOCAL_ANALYSIS_OWNER_HEADER)?.trim() || null;
}

function serializeRuntimeControl(row: RuntimeControlRow): DeepAnalysisRuntimeControl {
  return {
    controlKey: "global",
    mode: parseDeepAnalysisRuntimeMode(row.mode),
    generation: row.generation,
    changedBy: row.changedBy,
    changeReason: row.changeReason,
    localOwnerId: row.localOwnerId,
    localLeaseExpiresAt: row.localLeaseExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requireOwnerId(ownerId: string): string {
  const normalized = ownerId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
    throw new DeepAnalysisRuntimeControlError(
      "local_owner_required",
      "로컬 분석 owner ID 형식이 올바르지 않습니다.",
      400,
    );
  }
  return normalized;
}

function leaseExpiry(now: Date, ttlSeconds = LOCAL_ANALYSIS_LEASE_TTL_SECONDS): Date {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) {
    throw new Error("Local analysis lease TTL must be an integer between 30 and 600 seconds");
  }
  return new Date(now.getTime() + ttlSeconds * 1_000);
}
