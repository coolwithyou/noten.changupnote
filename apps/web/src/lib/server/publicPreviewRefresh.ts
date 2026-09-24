import { randomUUID } from "node:crypto";
import type {
  ClaimEnrichmentCacheInput,
  EnrichmentCacheEntry,
  ReadEnrichmentCacheInput,
  ReleaseEnrichmentCacheClaimInput,
  WriteEnrichmentCacheInput,
} from "@cunote/core";

/** 랜딩 공개 재조회의 24시간 쿨다운과 모든 유료 Popbill 경로의 공통 lease. */
export const PUBLIC_PREVIEW_REFRESH_PROVIDER = "popbill_public_refresh";
export const PUBLIC_PREVIEW_REFRESH_COOLDOWN_SCOPE = "checkBizInfo-24h";
export const PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE = "checkBizInfo-live-attempt";

export const PUBLIC_PREVIEW_ALREADY_FRESH_MS = 60 * 60 * 1000;
export const PUBLIC_PREVIEW_REFRESH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type PublicPreviewRefreshResult =
  | "updated"
  | "unchanged"
  | "already_fresh"
  | "rate_limited"
  | "failed";

export interface PublicPreviewRefreshCache {
  getFresh(input: ReadEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null>;
  put(input: WriteEnrichmentCacheInput): Promise<EnrichmentCacheEntry>;
  claim(input: ClaimEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null>;
  releaseClaim(input: ReleaseEnrichmentCacheClaimInput): Promise<boolean>;
}

/** 만료로 재선점하지 않는 공통 유료 조회 lease. 비정상 종료 시에는 수동 복구 전까지 fail-closed한다. */
export async function claimPopbillPaidLookupLease(
  cache: Pick<PublicPreviewRefreshCache, "claim">,
  bizNo: string,
  now: Date,
): Promise<string | null> {
  const ownerToken = randomUUID();
  const claimed = await cache.claim({
    provider: PUBLIC_PREVIEW_REFRESH_PROVIDER,
    bizNo,
    scope: PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE,
    canonicalPayload: { state: "attempt_reserved", ownerToken, reservedAt: now.toISOString() },
    providerResultCode: "reserved",
    providerResultMessage: "Popbill paid lookup lease",
    checkedAt: now,
    fetchedAt: now,
    now,
    expiresAt: null,
  });
  if (!claimed) return null;
  if (claimed.canonicalPayload?.ownerToken !== ownerToken) {
    throw new Error("Popbill 유료 조회 lease 소유자 검증에 실패했습니다.");
  }
  return ownerToken;
}

export function releasePopbillPaidLookupLease(
  cache: Pick<PublicPreviewRefreshCache, "releaseClaim">,
  bizNo: string,
  ownerToken: string,
): Promise<boolean> {
  return cache.releaseClaim({
    provider: PUBLIC_PREVIEW_REFRESH_PROVIDER,
    bizNo,
    scope: PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE,
    ownerToken,
  });
}

export interface PublicPreviewRefreshProfile {
  profile: { name?: string | null };
}

export interface ExecutePublicPreviewRefreshInput<T extends PublicPreviewRefreshProfile> {
  bizNo: string;
  now: Date;
  cache: PublicPreviewRefreshCache;
  popbillProvider: string;
  popbillScope: string;
  guardProvider: string;
  guardScope: string;
  readCached: () => Promise<T | null>;
  /** 라이브 직전에만 호출한다. 1시간·24시간 생략 경로에서는 예산을 쓰지 않는다. */
  reserveBudget: () => Promise<void>;
  liveLookup: () => Promise<T>;
  /** true면 이전 상호로 삼키지 않고 그대로 던진다. 폐업·미등록·공개 조회 한도. */
  isTerminalError?: (error: unknown) => boolean;
}

export interface PublicPreviewRefreshExecution<T extends PublicPreviewRefreshProfile> {
  refreshResult: PublicPreviewRefreshResult;
  resolution: T | null;
}

/**
 * 캐시가 1시간 안이면 라이브를 생략한다.
 * 그 외 24시간 쿨다운이 남아 있으면 한도, 아니면 라이브다.
 */
export function classifyPublicPreviewRefresh(input: {
  now: Date;
  liveCheckedAt: Date | null;
  cooldownExpiresAt: Date | null;
}): "already_fresh" | "rate_limited" | "live" {
  if (input.liveCheckedAt) {
    const ageMs = input.now.getTime() - input.liveCheckedAt.getTime();
    if (ageMs >= 0 && ageMs < PUBLIC_PREVIEW_ALREADY_FRESH_MS) return "already_fresh";
  }
  if (input.cooldownExpiresAt && input.cooldownExpiresAt.getTime() > input.now.getTime()) {
    return "rate_limited";
  }
  return "live";
}

export function samePublicPreviewCompanyName(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return normalizePublicPreviewCompanyName(left) === normalizePublicPreviewCompanyName(right);
}

function normalizePublicPreviewCompanyName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

/**
 * 이번 요청만 팝빌 캐시 읽기 결과를 답으로 쓰지 않는다.
 * 캐시 행과 30일 popbill_guard는 지우지 않는다. claim은 정산된 guard를 거절하므로
 * 공통 유료 조회 lease를 잡고, 성공 후에만 24시간 쿨다운을 남긴다.
 * 진행 중인 guard(attempt_reserved)는 건드리지 않아 같은 번호의 다른 라이브와 겹치지 않는다.
 */
export async function executePublicPreviewRefresh<T extends PublicPreviewRefreshProfile>(
  input: ExecutePublicPreviewRefreshInput<T>,
): Promise<PublicPreviewRefreshExecution<T>> {
  const cachedEntry = await input.cache.getFresh({
    provider: input.popbillProvider,
    bizNo: input.bizNo,
    scope: input.popbillScope,
    now: input.now,
  });
  const cooldown = await input.cache.getFresh({
    provider: PUBLIC_PREVIEW_REFRESH_PROVIDER,
    bizNo: input.bizNo,
    scope: PUBLIC_PREVIEW_REFRESH_COOLDOWN_SCOPE,
    now: input.now,
  });
  const decision = classifyPublicPreviewRefresh({
    now: input.now,
    liveCheckedAt: cachedEntry?.checkedAt ?? cachedEntry?.fetchedAt ?? null,
    cooldownExpiresAt: cooldown
      ? cooldown.expiresAt ?? new Date(input.now.getTime() + PUBLIC_PREVIEW_REFRESH_COOLDOWN_MS)
      : null,
  });

  if (decision !== "live") {
    return finishWithoutLive(input, decision);
  }

  const guard = await input.cache.getFresh({
    provider: input.guardProvider,
    bizNo: input.bizNo,
    scope: input.guardScope,
    now: input.now,
  });
  if (canonicalState(guard?.canonicalPayload) === "attempt_reserved") {
    const resolution = await readCachedOrNull(input);
    return { refreshResult: "failed", resolution };
  }

  const ownerToken = await claimPopbillPaidLookupLease(input.cache, input.bizNo, input.now);
  if (!ownerToken) {
    const resolution = await readCachedOrNull(input);
    return { refreshResult: "failed", resolution };
  }

  let previous: T | null = null;
  try {
    previous = await input.readCached();
    await input.reserveBudget();
    const live = await input.liveLookup();
    const refreshResult = samePublicPreviewCompanyName(previous?.profile.name, live.profile.name)
      ? "unchanged"
      : "updated";
    try {
      await input.cache.put({
        provider: PUBLIC_PREVIEW_REFRESH_PROVIDER,
        bizNo: input.bizNo,
        scope: PUBLIC_PREVIEW_REFRESH_COOLDOWN_SCOPE,
        canonicalPayload: {
          state: "settled",
          settledAt: input.now.toISOString(),
        },
        providerResultCode: "settled",
        providerResultMessage: "Public preview refresh cooldown",
        checkedAt: input.now,
        fetchedAt: input.now,
        expiresAt: new Date(input.now.getTime() + PUBLIC_PREVIEW_REFRESH_COOLDOWN_MS),
      });
    } catch (error) {
      console.warn(`공개 재조회 쿨다운 기록 실패: ${errorMessage(error)}`);
    }
    return { refreshResult, resolution: live };
  } catch (error) {
    if (input.isTerminalError?.(error)) throw error;
    return { refreshResult: "failed", resolution: previous };
  } finally {
    await releasePopbillPaidLookupLease(input.cache, input.bizNo, ownerToken).then((released) => {
      if (!released) console.warn("공개 재조회 lease 소유자가 변경되어 해제하지 않았습니다.");
    }).catch((error) => {
      console.warn(`공개 재조회 lease 해제 실패: ${errorMessage(error)}`);
    });
  }
}

async function finishWithoutLive<T extends PublicPreviewRefreshProfile>(
  input: ExecutePublicPreviewRefreshInput<T>,
  decision: "already_fresh" | "rate_limited",
): Promise<PublicPreviewRefreshExecution<T>> {
  try {
    const resolution = await input.readCached();
    if (resolution) return { refreshResult: decision, resolution };
  } catch (error) {
    if (input.isTerminalError?.(error)) throw error;
    if (decision === "rate_limited") return { refreshResult: "rate_limited", resolution: null };
    throw error;
  }
  if (decision === "rate_limited") return { refreshResult: "rate_limited", resolution: null };
  return { refreshResult: "failed", resolution: null };
}

async function readCachedOrNull<T extends PublicPreviewRefreshProfile>(
  input: ExecutePublicPreviewRefreshInput<T>,
): Promise<T | null> {
  try {
    return await input.readCached();
  } catch (error) {
    if (input.isTerminalError?.(error)) throw error;
    return null;
  }
}

function canonicalState(payload: Record<string, unknown> | null | undefined): string | null {
  return payload && typeof payload.state === "string" ? payload.state : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
