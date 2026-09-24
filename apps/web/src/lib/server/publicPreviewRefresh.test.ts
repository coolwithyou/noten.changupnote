import assert from "node:assert/strict";
import type {
  ClaimEnrichmentCacheInput,
  DeleteEnrichmentCacheInput,
  EnrichmentCacheEntry,
  ReadEnrichmentCacheInput,
  ReleaseEnrichmentCacheClaimInput,
  WriteEnrichmentCacheInput,
} from "@cunote/core";
import {
  claimPopbillPaidLookupLease,
  classifyPublicPreviewRefresh,
  executePublicPreviewRefresh,
  PUBLIC_PREVIEW_REFRESH_COOLDOWN_SCOPE,
  PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE,
  PUBLIC_PREVIEW_REFRESH_PROVIDER,
  releasePopbillPaidLookupLease,
  type PublicPreviewRefreshCache,
} from "./publicPreviewRefresh";

const bizNo = "7465400870";
const now = new Date("2026-07-14T12:00:00.000Z");
const popbillProvider = "popbill";
const popbillScope = "checkBizInfo";
const guardProvider = "popbill_guard";
const guardScope = "checkBizInfo-live-attempt";
const ntsProvider = "nts";
const ntsScope = "status";
const smppProvider = "smpp";
const smppScope = "certs";

class MemoryCache implements PublicPreviewRefreshCache {
  readonly deletes: Array<{ provider?: string; scope?: string }> = [];
  readonly releases: Array<{ provider: string; scope: string; released: boolean }> = [];
  private readonly entries = new Map<string, EnrichmentCacheEntry>();

  async getFresh(input: ReadEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null> {
    const entry = this.entries.get(keyOf(input));
    if (!entry) return null;
    const at = input.now ?? new Date();
    if (entry.expiresAt && entry.expiresAt.getTime() <= at.getTime()) return null;
    return entry;
  }

  async put(input: WriteEnrichmentCacheInput): Promise<EnrichmentCacheEntry> {
    const entry: EnrichmentCacheEntry = {
      provider: input.provider,
      bizNo: input.bizNo,
      scope: input.scope,
      fetchedAt: input.fetchedAt ?? new Date(),
      ...(input.canonicalPayload !== undefined ? { canonicalPayload: input.canonicalPayload } : {}),
      ...(input.checkedAt !== undefined ? { checkedAt: input.checkedAt } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.entries.set(keyOf(input), entry);
    return entry;
  }

  async claim(input: ClaimEnrichmentCacheInput): Promise<EnrichmentCacheEntry | null> {
    const existing = this.entries.get(keyOf(input));
    if (existing && (!existing.expiresAt || existing.expiresAt.getTime() > input.now.getTime())) {
      return null;
    }
    return this.put(input);
  }

  async releaseClaim(input: ReleaseEnrichmentCacheClaimInput): Promise<boolean> {
    const key = keyOf(input);
    const current = this.entries.get(key);
    const released = current?.canonicalPayload?.state === "attempt_reserved" &&
      current.canonicalPayload.ownerToken === input.ownerToken;
    if (released) this.entries.delete(key);
    this.releases.push({ provider: input.provider, scope: input.scope, released });
    return released;
  }

  async deleteByBizNo(input: DeleteEnrichmentCacheInput): Promise<number> {
    this.deletes.push({
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    });
    let deleted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.bizNo !== input.bizNo) continue;
      if (input.provider && entry.provider !== input.provider) continue;
      if (input.scope && entry.scope !== input.scope) continue;
      this.entries.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  has(provider: string, scope: string): boolean {
    return this.entries.has(`${provider}:${bizNo}:${scope}`);
  }

  profileName(): string {
    const entry = this.entries.get(`${popbillProvider}:${bizNo}:${popbillScope}`);
    const profile = entry?.canonicalPayload?.profile;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return "";
    const name = (profile as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  }
}

function keyOf(input: { provider: string; bizNo: string; scope: string }): string {
  return `${input.provider}:${input.bizNo}:${input.scope}`;
}

const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
assert.equal(classifyPublicPreviewRefresh({
  now,
  liveCheckedAt: new Date(hourAgo.getTime() + 1),
  cooldownExpiresAt: new Date(now.getTime() + 60_000),
}), "already_fresh");
assert.equal(classifyPublicPreviewRefresh({
  now,
  liveCheckedAt: hourAgo,
  cooldownExpiresAt: null,
}), "live");
assert.equal(classifyPublicPreviewRefresh({
  now,
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  cooldownExpiresAt: now,
}), "live");
assert.equal(classifyPublicPreviewRefresh({
  now,
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  cooldownExpiresAt: new Date(now.getTime() + 1),
}), "rate_limited");

const fresh = await run({
  liveCheckedAt: new Date(now.getTime() - 30 * 60 * 1000),
  name: "옛상호",
});
assert.equal(fresh.result.refreshResult, "already_fresh");
assert.equal(fresh.result.resolution?.profile.name, "옛상호");
assert.equal(fresh.liveCalls, 0);
assert.equal(fresh.budgetCalls, 0);
assert.deepEqual(fresh.cache.deletes, []);
assert.equal(fresh.cache.has(ntsProvider, ntsScope), true);
assert.equal(fresh.cache.has(smppProvider, smppScope), true);

const limited = await run({
  liveCheckedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
  name: "옛상호",
  cooldownExpiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
});
assert.equal(limited.result.refreshResult, "rate_limited");
assert.equal(limited.result.resolution?.profile.name, "옛상호");
assert.equal(limited.liveCalls, 0);
assert.equal(limited.budgetCalls, 0);

const busy = await run({
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  name: "옛상호",
  guardState: "attempt_reserved",
  guardExpiresAt: null,
});
assert.equal(busy.result.refreshResult, "failed");
assert.equal(busy.result.resolution?.profile.name, "옛상호");
assert.equal(busy.liveCalls, 0);
assert.equal(busy.budgetCalls, 0);
assert.equal(busy.cache.has(guardProvider, guardScope), true);

const settled = await run({
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  name: "옛상호",
  nextName: "새상호",
  guardState: "cache_stored",
  guardExpiresAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
});
assert.equal(settled.result.refreshResult, "updated");
assert.equal(settled.result.resolution?.profile.name, "새상호");
assert.equal(settled.liveCalls, 1, "30일 정산 guard가 있어도 재조회 라이브는 1회");
assert.equal(settled.budgetCalls, 1, "라이브 재조회는 공개 조회 예산에 포함");
assert.equal(settled.cache.has(popbillProvider, popbillScope), true);
assert.equal(settled.cache.has(guardProvider, guardScope), true);
assert.equal(settled.cache.has(ntsProvider, ntsScope), true);
assert.equal(settled.cache.has(smppProvider, smppScope), true);
assert.equal(settled.cache.has(PUBLIC_PREVIEW_REFRESH_PROVIDER, PUBLIC_PREVIEW_REFRESH_COOLDOWN_SCOPE), true);
assert.equal(settled.cache.has(PUBLIC_PREVIEW_REFRESH_PROVIDER, PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE), false);
assert.deepEqual(settled.cache.deletes, []);
assert.deepEqual(settled.cache.releases, [{
  provider: PUBLIC_PREVIEW_REFRESH_PROVIDER,
  scope: PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE,
  released: true,
}]);

const againAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
const again = await executePublicPreviewRefresh({
  bizNo,
  now: againAt,
  cache: settled.cache,
  popbillProvider,
  popbillScope,
  guardProvider,
  guardScope,
  readCached: async () => ({ profile: { name: settled.cache.profileName() } }),
  reserveBudget: async () => {
    settled.budgetCalls += 1;
  },
  liveLookup: async () => {
    settled.liveCalls += 1;
    return { profile: { name: "또 바뀐 상호" } };
  },
});
assert.equal(again.refreshResult, "rate_limited");
assert.equal(settled.liveCalls, 1, "24시간 안 두 번째 재조회는 팝빌 0회");
assert.equal(settled.budgetCalls, 1);

const same = await run({
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  name: "옛상호",
  nextName: "옛상호",
  guardState: "cache_stored",
  guardExpiresAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
});
assert.equal(same.result.refreshResult, "unchanged");
assert.equal(same.liveCalls, 1);
assert.equal(same.result.resolution?.profile.name, "옛상호");

const failed = await run({
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  name: "옛상호",
  guardState: "cache_stored",
  guardExpiresAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
  liveError: new Error("popbill down"),
});
assert.equal(failed.result.refreshResult, "failed");
assert.equal(failed.result.resolution?.profile.name, "옛상호");
assert.equal(failed.liveCalls, 1);
assert.equal(failed.budgetCalls, 1);
assert.equal(failed.cache.profileName(), "옛상호");
assert.equal(failed.cache.has(PUBLIC_PREVIEW_REFRESH_PROVIDER, PUBLIC_PREVIEW_REFRESH_COOLDOWN_SCOPE), false);
assert.equal(failed.cache.has(PUBLIC_PREVIEW_REFRESH_PROVIDER, PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE), true,
  "유료 SDK 오류 뒤 결과가 불명확하면 공통 lease를 유지한다");
assert.equal(failed.cache.has(ntsProvider, ntsScope), true);
assert.equal(failed.cache.has(smppProvider, smppScope), true);
assert.equal(failed.cache.deletes.some((entry) => entry.provider === popbillProvider), false);
const failedRetry = await executePublicPreviewRefresh({
  bizNo,
  now: new Date(now.getTime() + 3 * 60_000),
  cache: failed.cache,
  popbillProvider,
  popbillScope,
  guardProvider,
  guardScope,
  readCached: async () => ({ profile: { name: failed.cache.profileName() } }),
  reserveBudget: async () => { failed.budgetCalls += 1; },
  liveLookup: async () => {
    failed.liveCalls += 1;
    return { profile: { name: "재시도 상호" } };
  },
});
assert.equal(failedRetry.refreshResult, "failed");
assert.equal(failed.liveCalls, 1, "유료 SDK 오류 직후 재시도는 두 번째 유료 호출을 시작하지 않는다");
assert.equal(failed.budgetCalls, 1);

const preLiveCache = seedCache({
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  name: "옛상호",
  guardState: "cache_stored",
  guardExpiresAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
});
let preLivePaidCalls = 0;
const preLiveFailure = await executePublicPreviewRefresh({
  bizNo,
  now,
  cache: preLiveCache,
  popbillProvider,
  popbillScope,
  guardProvider,
  guardScope,
  readCached: async () => ({ profile: { name: "옛상호" } }),
  reserveBudget: async () => {},
  preLiveLookup: async () => { throw new Error("NTS unavailable before paid call"); },
  liveLookup: async () => {
    preLivePaidCalls += 1;
    return { profile: { name: "새상호" } };
  },
});
assert.equal(preLiveFailure.refreshResult, "failed");
assert.equal(preLivePaidCalls, 0);
assert.equal(preLiveCache.has(PUBLIC_PREVIEW_REFRESH_PROVIDER, PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE), false,
  "유료 호출 전 무료 사전 검사 실패는 lease를 해제한다");

class CooldownWriteFailureCache extends MemoryCache {
  override async put(input: WriteEnrichmentCacheInput): Promise<EnrichmentCacheEntry> {
    if (input.provider === PUBLIC_PREVIEW_REFRESH_PROVIDER &&
        input.scope === PUBLIC_PREVIEW_REFRESH_COOLDOWN_SCOPE) {
      throw new Error("cooldown DB write failed");
    }
    return super.put(input);
  }
}
const cooldownWriteFailureCache = new CooldownWriteFailureCache();
const cooldownWriteFailure = await executePublicPreviewRefresh({
  bizNo,
  now,
  cache: cooldownWriteFailureCache,
  popbillProvider,
  popbillScope,
  guardProvider,
  guardScope,
  readCached: async () => ({ profile: { name: "옛상호" } }),
  reserveBudget: async () => {},
  liveLookup: async () => ({ profile: { name: "새상호" } }),
});
assert.equal(cooldownWriteFailure.refreshResult, "updated");
assert.equal(cooldownWriteFailureCache.has(PUBLIC_PREVIEW_REFRESH_PROVIDER, PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE), true,
  "유료 호출이 성공해도 쿨다운 저장 실패 시 중복 유료 호출을 막는 lease를 유지한다");

let overlapLive = 0;
const overlapCache = seedCache({
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  name: "옛상호",
  guardState: "cache_stored",
  guardExpiresAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
});
let releaseLive: () => void = () => {};
const liveGate = new Promise<void>((resolve) => {
  releaseLive = resolve;
});
const first = executePublicPreviewRefresh({
  bizNo,
  now,
  cache: overlapCache,
  popbillProvider,
  popbillScope,
  guardProvider,
  guardScope,
  readCached: async () => ({ profile: { name: "옛상호" } }),
  reserveBudget: async () => {},
  liveLookup: async () => {
    overlapLive += 1;
    await liveGate;
    return { profile: { name: "새상호" } };
  },
});
const second = executePublicPreviewRefresh({
  bizNo,
  now,
  cache: overlapCache,
  popbillProvider,
  popbillScope,
  guardProvider,
  guardScope,
  readCached: async () => ({ profile: { name: "옛상호" } }),
  reserveBudget: async () => {},
  liveLookup: async () => {
    overlapLive += 1;
    return { profile: { name: "또 다른 상호" } };
  },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(overlapLive, 1, "겹친 재조회는 라이브 1회만");
assert.equal(
  await claimPopbillPaidLookupLease(overlapCache, bizNo, new Date(now.getTime() + 3 * 60_000)),
  null,
  "공개 재조회 중 일반 조회는 2분이 지나도 유료 조회 lease를 재선점하지 못한다",
);
releaseLive();
const [firstResult, secondResult] = await Promise.all([first, second]);
assert.equal(firstResult.refreshResult, "updated");
assert.equal(secondResult.refreshResult, "failed");
assert.equal(overlapLive, 1);

const sharedLeaseCache = seedCache({
  liveCheckedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
  name: "옛상호",
  guardState: "cache_stored",
  guardExpiresAt: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
});
const ordinaryOwner = await claimPopbillPaidLookupLease(sharedLeaseCache, bizNo, now);
assert.ok(ordinaryOwner);
let crossedLiveCalls = 0;
const crossed = await executePublicPreviewRefresh({
  bizNo,
  now: new Date(now.getTime() + 3 * 60_000),
  cache: sharedLeaseCache,
  popbillProvider,
  popbillScope,
  guardProvider,
  guardScope,
  readCached: async () => ({ profile: { name: "옛상호" } }),
  reserveBudget: async () => {},
  liveLookup: async () => {
    crossedLiveCalls += 1;
    return { profile: { name: "새상호" } };
  },
});
assert.equal(crossed.refreshResult, "failed");
assert.equal(crossedLiveCalls, 0, "일반 조회가 진행 중이면 공개 재조회 유료 호출을 차단한다");
assert.equal(await releasePopbillPaidLookupLease(sharedLeaseCache, bizNo, ordinaryOwner), true);

const reclaimedCache = new MemoryCache();
const staleOwner = await claimPopbillPaidLookupLease(reclaimedCache, bizNo, now);
assert.ok(staleOwner);
assert.equal(
  await claimPopbillPaidLookupLease(reclaimedCache, bizNo, new Date(now.getTime() + 3 * 60_000)),
  null,
  "느린 SDK 호출은 TTL 경과만으로 재선점되지 않는다",
);
assert.equal(await reclaimedCache.deleteByBizNo({
  bizNo,
  provider: PUBLIC_PREVIEW_REFRESH_PROVIDER,
  scope: PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE,
}), 1, "운영자의 명시적 복구로만 이전 lease를 제거한다");
const newOwner = await claimPopbillPaidLookupLease(reclaimedCache, bizNo, new Date(now.getTime() + 3 * 60_000));
assert.ok(newOwner);
assert.notEqual(newOwner, staleOwner);
assert.equal(await releasePopbillPaidLookupLease(reclaimedCache, bizNo, staleOwner), false);
assert.equal(reclaimedCache.has(PUBLIC_PREVIEW_REFRESH_PROVIDER, PUBLIC_PREVIEW_REFRESH_LEASE_SCOPE), true);
assert.equal(await claimPopbillPaidLookupLease(reclaimedCache, bizNo, new Date(now.getTime() + 4 * 60_000)), null);
assert.equal(await releasePopbillPaidLookupLease(reclaimedCache, bizNo, newOwner), true);

console.log("publicPreviewRefresh.test.ts: all assertions passed");

interface RunInput {
  liveCheckedAt: Date;
  name: string;
  nextName?: string;
  cooldownExpiresAt?: Date;
  guardState?: "cache_stored" | "attempt_reserved";
  guardExpiresAt?: Date | null;
  liveError?: Error;
}

async function run(input: RunInput) {
  const cache = seedCache(input);
  let liveCalls = 0;
  let budgetCalls = 0;
  const result = await executePublicPreviewRefresh({
    bizNo,
    now,
    cache,
    popbillProvider,
    popbillScope,
    guardProvider,
    guardScope,
    readCached: async () => ({ profile: { name: cache.profileName() } }),
    reserveBudget: async () => {
      budgetCalls += 1;
    },
    liveLookup: async () => {
      liveCalls += 1;
      if (input.liveError) throw input.liveError;
      const nextName = input.nextName ?? input.name;
      await cache.put({
        provider: popbillProvider,
        bizNo,
        scope: popbillScope,
        canonicalPayload: { profile: { name: nextName } },
        checkedAt: now,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      });
      await cache.put({
        provider: guardProvider,
        bizNo,
        scope: guardScope,
        canonicalPayload: { state: "cache_stored" },
        checkedAt: now,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      });
      return { profile: { name: nextName } };
    },
  });
  return { result, liveCalls, budgetCalls, cache };
}

function seedCache(input: {
  liveCheckedAt: Date;
  name: string;
  cooldownExpiresAt?: Date;
  guardState?: "cache_stored" | "attempt_reserved";
  guardExpiresAt?: Date | null;
}): MemoryCache {
  const cache = new MemoryCache();
  void cache.put({
    provider: popbillProvider,
    bizNo,
    scope: popbillScope,
    canonicalPayload: { profile: { name: input.name } },
    checkedAt: input.liveCheckedAt,
    fetchedAt: input.liveCheckedAt,
    expiresAt: new Date(input.liveCheckedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
  });
  void cache.put({
    provider: ntsProvider,
    bizNo,
    scope: ntsScope,
    canonicalPayload: { b_stt_cd: "01" },
    checkedAt: input.liveCheckedAt,
    fetchedAt: input.liveCheckedAt,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });
  void cache.put({
    provider: smppProvider,
    bizNo,
    scope: smppScope,
    canonicalPayload: { women: { held: false } },
    checkedAt: input.liveCheckedAt,
    fetchedAt: input.liveCheckedAt,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  });
  if (input.guardState) {
    void cache.put({
      provider: guardProvider,
      bizNo,
      scope: guardScope,
      canonicalPayload: { state: input.guardState },
      checkedAt: input.liveCheckedAt,
      fetchedAt: input.liveCheckedAt,
      expiresAt: input.guardExpiresAt === undefined
        ? new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000)
        : input.guardExpiresAt,
    });
  }
  if (input.cooldownExpiresAt) {
    void cache.put({
      provider: PUBLIC_PREVIEW_REFRESH_PROVIDER,
      bizNo,
      scope: PUBLIC_PREVIEW_REFRESH_COOLDOWN_SCOPE,
      canonicalPayload: { state: "settled" },
      checkedAt: now,
      fetchedAt: now,
      expiresAt: input.cooldownExpiresAt,
    });
  }
  cache.deletes.length = 0;
  return cache;
}
