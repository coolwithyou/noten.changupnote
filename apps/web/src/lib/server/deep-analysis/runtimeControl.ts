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

// DB lease는 운영 API와 로컬 구독 실행의 상호배타를 보장한다. 같은 owner가 브라우저
// 요청을 중복 전송하는 경우까지 허용하면 연결이 끊긴 장시간 CLI 호출과 새 호출이 겹칠
// 수 있으므로, 실제 로컬 프로세스 안에서는 분석 실행을 하나로 직렬화한다.
let localSubscriptionRunActive = false;

type RuntimeControlRow = typeof schema.deepAnalysisRuntimeControl.$inferSelect;

export class DeepAnalysisRuntimeControlError extends Error {
  constructor(
    readonly code:
      | "runtime_control_missing"
      | "runtime_control_conflict"
      | "local_owner_required"
      | "local_subscription_not_allowed"
      | "local_analysis_already_running",
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
  if (localSubscriptionRunActive) {
    throw new DeepAnalysisRuntimeControlError(
      "local_analysis_already_running",
      "이 로컬 서버에서 다른 구독 분석이 실행 중입니다. 기존 실행이 끝난 뒤 다시 시도하세요.",
    );
  }
  localSubscriptionRunActive = true;
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
    localSubscriptionRunActive = false;
  }
}

export async function acquireLocalSubscriptionLease(input: {
  db: CunoteDb;
  ownerId: string;
  changedBy: string;
  expectedGeneration?: number;
  reason?: string | null;
  now?: Date;
  ttlSeconds?: number;
}): Promise<DeepAnalysisRuntimeControl> {
  const ownerId = requireOwnerId(input.ownerId);
  const now = input.now ?? new Date();
  const leaseExpiresAt = leaseExpiry(now, input.ttlSeconds);
  const expectedGeneration = input.expectedGeneration === undefined
    ? null
    : requireGeneration(input.expectedGeneration);
  const [row] = await input.db.update(schema.deepAnalysisRuntimeControl).set({
    mode: "local_subscription",
    generation: sql`${schema.deepAnalysisRuntimeControl.generation} + 1`,
    changedBy: input.changedBy.slice(0, 200),
    changeReason: input.reason?.slice(0, 1_000) ?? "로컬 구독 분석 권한 획득",
    localOwnerId: ownerId,
    localLeaseExpiresAt: leaseExpiresAt,
    updatedAt: now,
  }).where(expectedGeneration === null
    ? and(
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
    )
    : and(
      eq(schema.deepAnalysisRuntimeControl.controlKey, CONTROL_KEY),
      eq(schema.deepAnalysisRuntimeControl.mode, "paused"),
      eq(schema.deepAnalysisRuntimeControl.generation, expectedGeneration),
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
  generation?: number;
  now?: Date;
  ttlSeconds?: number;
}): Promise<DeepAnalysisRuntimeControl> {
  const ownerId = requireOwnerId(input.ownerId);
  const now = input.now ?? new Date();
  const generation = input.generation === undefined ? null : requireGeneration(input.generation);
  const [row] = await input.db.update(schema.deepAnalysisRuntimeControl).set({
    localLeaseExpiresAt: leaseExpiry(now, input.ttlSeconds),
    updatedAt: now,
  }).where(and(
    eq(schema.deepAnalysisRuntimeControl.controlKey, CONTROL_KEY),
    eq(schema.deepAnalysisRuntimeControl.mode, "local_subscription"),
    eq(schema.deepAnalysisRuntimeControl.localOwnerId, ownerId),
    ...(generation === null
      ? []
      : [eq(schema.deepAnalysisRuntimeControl.generation, generation)]),
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

/**
 * receipt-bound 실험이 비정상 종료된 뒤 남은 만료 lease만 정리한다. 관측했던
 * generation/owner/expiry를 모두 CAS에 묶어 이후 획득·갱신된 lease를 건드리지 않는다.
 */
export async function recoverExpiredLocalSubscriptionLease(input: {
  db: CunoteDb;
  ownerId: string;
  expectedGeneration: number;
  expectedLeaseExpiresAt: Date;
  changeReason: string;
  now?: Date;
}): Promise<DeepAnalysisRuntimeControl> {
  const ownerId = requireOwnerId(input.ownerId);
  const expectedGeneration = requireGeneration(input.expectedGeneration);
  const now = input.now ?? new Date();
  const [row] = await input.db.update(schema.deepAnalysisRuntimeControl).set({
    mode: "paused",
    generation: sql`${schema.deepAnalysisRuntimeControl.generation} + 1`,
    changedBy: "lab:experiment:recover",
    changeReason: input.changeReason,
    localOwnerId: null,
    localLeaseExpiresAt: null,
    updatedAt: now,
  }).where(and(
    eq(schema.deepAnalysisRuntimeControl.controlKey, CONTROL_KEY),
    eq(schema.deepAnalysisRuntimeControl.mode, "local_subscription"),
    eq(schema.deepAnalysisRuntimeControl.generation, expectedGeneration),
    eq(schema.deepAnalysisRuntimeControl.localOwnerId, ownerId),
    eq(schema.deepAnalysisRuntimeControl.localLeaseExpiresAt, input.expectedLeaseExpiresAt),
    lte(schema.deepAnalysisRuntimeControl.localLeaseExpiresAt, now),
  )).returning();
  if (!row) {
    throw new DeepAnalysisRuntimeControlError(
      "runtime_control_conflict",
      "관측한 만료 lease와 현재 실행 권한이 일치하지 않아 복구하지 않았습니다.",
    );
  }
  return serializeRuntimeControl(row);
}

export async function releaseLocalSubscriptionLease(input: {
  db: CunoteDb;
  ownerId: string;
  changedBy: string;
  generation?: number;
  now?: Date;
}): Promise<DeepAnalysisRuntimeControl> {
  const ownerId = requireOwnerId(input.ownerId);
  const now = input.now ?? new Date();
  const generation = input.generation === undefined ? null : requireGeneration(input.generation);
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
    ...(generation === null
      ? []
      : [eq(schema.deepAnalysisRuntimeControl.generation, generation)]),
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

function requireGeneration(generation: number): number {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Deep analysis runtime generation must be a positive safe integer");
  }
  return generation;
}

function leaseExpiry(now: Date, ttlSeconds = LOCAL_ANALYSIS_LEASE_TTL_SECONDS): Date {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) {
    throw new Error("Local analysis lease TTL must be an integer between 30 and 600 seconds");
  }
  return new Date(now.getTime() + ttlSeconds * 1_000);
}
