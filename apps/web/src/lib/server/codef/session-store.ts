/**
 * CODEF 간편인증 2-way 세션 + 토큰 DB 접근 계층 (Phase B B2).
 *
 * serverless(Vercel)에서 "승인 대기 → 완료"를 두 HTTP 요청으로 처리하려면 세션을 DB로 영속해야 한다.
 * 이 모듈은 codef_two_way_sessions·codef_tokens·company_enrichment_cache·company_profiles 에 대한
 * 순수 DB 접근만 담당하고, 프로토콜/오케스트레이션은 orchestrator.ts 가 맡는다.
 *
 * 프로덕션 격리: CODEF 는 dev 경로에만. 여기서 쓰는 테이블 접근은 프로덕션 매칭/serviceData 오버레이와
 * 무관하다(company_enrichment_cache 는 dev service-data 하네스와 동일한 진단 캐시).
 *
 * 마스킹 규칙(B5): 이 모듈은 어떤 값도 로그로 남기지 않는다. requestSnapshot(민감 로그인 입력)은
 * 세션 종결(done/failed/expired) 즉시 NULL 로 지운다.
 */

import { and, eq, isNull } from "drizzle-orm";
import {
  assertTwoWayTransition,
  isCodefTokenExpired,
  isTwoWaySessionExpired,
  CODEF_TWO_WAY_TIMEOUT_MS,
  type CodefToken,
  type CodefTwoWayState,
} from "@cunote/core";
import { getCunoteDb } from "../db/client";
import { codefTokens, codefTwoWaySessions, companies, companyEnrichmentCache, companyProfiles } from "../db/schema";

/** codef_two_way_sessions 행의 애플리케이션 표현. */
export interface CodefSessionRecord {
  id: string;
  bizNo: string;
  userId: string | null;
  productScope: string;
  state: CodefTwoWayState;
  requestSnapshot: Record<string, unknown> | null;
  twoWayInfo: Record<string, unknown> | null;
  errorCode: string | null;
  retryCount: number;
  createdAt: Date;
  expiresAt: Date;
}

type CodefSessionRow = typeof codefTwoWaySessions.$inferSelect;

const TERMINAL_STATES: ReadonlySet<CodefTwoWayState> = new Set(["done", "failed", "expired"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toRecord(row: CodefSessionRow): CodefSessionRecord {
  return {
    id: row.id,
    bizNo: row.bizNo,
    userId: row.userId,
    productScope: row.productScope,
    state: row.state,
    requestSnapshot: row.requestSnapshot ?? null,
    twoWayInfo: row.twoWayInfo ?? null,
    errorCode: row.errorCode,
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

// ── 세션 CRUD ────────────────────────────────────────────────────────────────

/** pending_approval 세션을 만든다. expiresAt = now + 270초(코어 CODEF_TWO_WAY_TIMEOUT_MS). */
export async function createCodefSession(input: {
  bizNo: string;
  userId?: string | null;
  productScope?: string;
  requestSnapshot: Record<string, unknown>;
  twoWayInfo: Record<string, unknown>;
  now?: Date;
}): Promise<CodefSessionRecord> {
  const db = getCunoteDb();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CODEF_TWO_WAY_TIMEOUT_MS);
  const [row] = await db
    .insert(codefTwoWaySessions)
    .values({
      bizNo: input.bizNo,
      userId: input.userId ?? null,
      ...(input.productScope ? { productScope: input.productScope } : {}),
      state: "pending_approval",
      requestSnapshot: input.requestSnapshot,
      twoWayInfo: input.twoWayInfo,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error("CODEF 세션 생성 결과가 없습니다.");
  return toRecord(row);
}

/**
 * 세션을 읽는다. 비종결 상태인데 제한시간(4분30초)이 지났으면 lazy 하게 expired + snapshot NULL 로
 * 갱신한 뒤 만료로 취급한다. id 가 uuid 형식이 아니면 null(잘못된 sessionId → 조회 없음).
 */
export async function getCodefSession(id: string, now: Date = new Date()): Promise<CodefSessionRecord | null> {
  if (!UUID_RE.test(id)) return null;
  const db = getCunoteDb();
  const [row] = await db.select().from(codefTwoWaySessions).where(eq(codefTwoWaySessions.id, id)).limit(1);
  if (!row) return null;
  const record = toRecord(row);
  if (!TERMINAL_STATES.has(record.state) && isTwoWaySessionExpired(record.createdAt.getTime(), now.getTime())) {
    const [updated] = await db
      .update(codefTwoWaySessions)
      .set({ state: "expired", requestSnapshot: null })
      .where(eq(codefTwoWaySessions.id, id))
      .returning();
    return updated ? toRecord(updated) : { ...record, state: "expired", requestSnapshot: null };
  }
  return record;
}

/**
 * 세션 상태를 전이한다. 전이는 코어 assertTwoWayTransition 으로 가드(불법 전이 시 throw).
 * 종결 상태(done/failed/expired)로 전이하면 requestSnapshot 을 NULL 로 지운다.
 * from 상태와 실제 행이 다르면(경합) null 을 반환한다.
 */
export async function transitionCodefSession(input: {
  id: string;
  from: CodefTwoWayState;
  to: CodefTwoWayState;
  patch?: {
    requestSnapshot?: Record<string, unknown> | null;
    twoWayInfo?: Record<string, unknown> | null;
    errorCode?: string | null;
    retryCount?: number;
  };
}): Promise<CodefSessionRecord | null> {
  assertTwoWayTransition(input.from, input.to);
  const db = getCunoteDb();
  const set: Partial<typeof codefTwoWaySessions.$inferInsert> = { state: input.to };
  if (input.patch?.twoWayInfo !== undefined) set.twoWayInfo = input.patch.twoWayInfo;
  if (input.patch?.errorCode !== undefined) set.errorCode = input.patch.errorCode;
  if (input.patch?.retryCount !== undefined) set.retryCount = input.patch.retryCount;
  // 종결 전이는 무조건 snapshot NULL(민감정보 즉시 삭제). 그 외에는 patch 값을 따른다.
  if (TERMINAL_STATES.has(input.to)) {
    set.requestSnapshot = null;
  } else if (input.patch?.requestSnapshot !== undefined) {
    set.requestSnapshot = input.patch.requestSnapshot;
  }
  const [row] = await db
    .update(codefTwoWaySessions)
    .set(set)
    .where(and(eq(codefTwoWaySessions.id, input.id), eq(codefTwoWaySessions.state, input.from)))
    .returning();
  return row ? toRecord(row) : null;
}

/**
 * 상태 전이 없이 세션의 snapshot/twoWayInfo/retryCount 만 갱신한다(같은 상태 내 진행 갱신).
 * 예: VAT 2차 승인 유도 시 pendingProduct/VAT twoWayInfo 보관.
 */
export async function updateCodefSession(input: {
  id: string;
  requestSnapshot?: Record<string, unknown> | null;
  twoWayInfo?: Record<string, unknown> | null;
  retryCount?: number;
}): Promise<CodefSessionRecord | null> {
  const db = getCunoteDb();
  const set: Partial<typeof codefTwoWaySessions.$inferInsert> = {};
  if (input.requestSnapshot !== undefined) set.requestSnapshot = input.requestSnapshot;
  if (input.twoWayInfo !== undefined) set.twoWayInfo = input.twoWayInfo;
  if (input.retryCount !== undefined) set.retryCount = input.retryCount;
  if (Object.keys(set).length === 0) return getCodefSession(input.id);
  const [row] = await db
    .update(codefTwoWaySessions)
    .set(set)
    .where(eq(codefTwoWaySessions.id, input.id))
    .returning();
  return row ? toRecord(row) : null;
}

// ── 토큰 DB 캐시 ─────────────────────────────────────────────────────────────

const CODEF_TOKEN_ROW_ID = "default";

/** 캐시된 토큰을 읽어 코어 만료판정을 통과하면 반환, 없거나 만료면 null. */
export async function getCachedCodefToken(now: Date = new Date()): Promise<CodefToken | null> {
  const db = getCunoteDb();
  const [row] = await db.select().from(codefTokens).where(eq(codefTokens.id, CODEF_TOKEN_ROW_ID)).limit(1);
  if (!row) return null;
  const token: CodefToken = {
    accessToken: row.accessToken,
    tokenType: row.tokenType,
    expiresInSec: row.expiresInSec,
    obtainedAtMs: row.obtainedAtMs,
  };
  if (isCodefTokenExpired(token, now.getTime())) return null;
  return token;
}

/** 토큰을 단일행(id="default")으로 upsert 한다. */
export async function setCachedCodefToken(token: CodefToken): Promise<void> {
  const db = getCunoteDb();
  const values = {
    id: CODEF_TOKEN_ROW_ID,
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    obtainedAtMs: token.obtainedAtMs,
    expiresInSec: token.expiresInSec,
    updatedAt: new Date(),
  };
  await db
    .insert(codefTokens)
    .values(values)
    .onConflictDoUpdate({ target: codefTokens.id, set: values });
}

// ── 국세청 확정값 캐시 upsert (company_enrichment_cache) ──────────────────────

/** provider="codef" scope별(corporate-registration | vat-base) 결과를 캐시에 upsert 한다. */
export async function upsertCodefEnrichmentCache(input: {
  bizNo: string;
  scope: "corporate-registration" | "vat-base";
  canonicalPayload?: Record<string, unknown> | null;
  providerResultCode?: string | null;
  providerResultMessage?: string | null;
  lastError?: Record<string, unknown> | null;
  fetchedAt?: Date;
}): Promise<void> {
  const db = getCunoteDb();
  const values = {
    provider: "codef",
    bizNo: input.bizNo,
    scope: input.scope,
    rawPayload: null,
    canonicalPayload: input.canonicalPayload ?? null,
    providerResultCode: input.providerResultCode ?? null,
    providerResultMessage: input.providerResultMessage ?? null,
    checkedAt: input.fetchedAt ?? new Date(),
    fetchedAt: input.fetchedAt ?? new Date(),
    expiresAt: null,
    payloadHash: null,
    lastError: input.lastError ?? null,
  };
  await db
    .insert(companyEnrichmentCache)
    .values(values)
    .onConflictDoUpdate({
      target: [companyEnrichmentCache.provider, companyEnrichmentCache.bizNo, companyEnrichmentCache.scope],
      set: values,
    });
}

// ── companyProfiles best-effort upsert ───────────────────────────────────────

/** CODEF 프로필이 채우는 차원(코어 buildCompanyProfileFromCodef 결과 기준). */
type CodefDimension = "region" | "biz_age" | "industry" | "target_type" | "revenue" | "founder_age";

/**
 * best-effort 로 company_profiles 를 dimension 별로 갱신한다(source="codef").
 * 해당 bizNo 의 company 행이 없으면(대부분 dev) 스킵. 어떤 이유로든 실패해도 예외를 던지지 않는다
 * — dev 의 진실 원천은 company_enrichment_cache 이고, 이 upsert 는 프로덕션 승격 대비 편의다.
 */
export async function upsertCodefCompanyProfiles(input: {
  bizNo: string;
  dimensions: Array<{ dimension: CodefDimension; value: Record<string, unknown>; confidence: number }>;
  now?: Date;
}): Promise<{ persisted: boolean; reason?: string }> {
  if (input.dimensions.length === 0) return { persisted: false, reason: "차원 없음" };
  try {
    const db = getCunoteDb();
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.bizNo, input.bizNo))
      .limit(1);
    if (!company) return { persisted: false, reason: "company 행 없음 · dev 스킵" };
    const now = input.now ?? new Date();
    await db.transaction(async (tx) => {
      // source="codef" 차원만 걷어내고 다시 심는다(다른 소스 행은 보존).
      await tx
        .delete(companyProfiles)
        .where(
          and(
            eq(companyProfiles.companyId, company.id),
            isNull(companyProfiles.userId),
            eq(companyProfiles.source, "codef"),
          ),
        );
      await tx.insert(companyProfiles).values(
        input.dimensions.map((d) => ({
          companyId: company.id,
          dimension: d.dimension,
          value: d.value,
          source: "codef" as const,
          confidence: d.confidence,
          asOf: now,
          updatedAt: now,
        })),
      );
    });
    return { persisted: true };
  } catch (error) {
    return { persisted: false, reason: error instanceof Error ? error.message.slice(0, 120) : "unknown" };
  }
}
