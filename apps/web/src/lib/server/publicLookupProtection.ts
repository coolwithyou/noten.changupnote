import { createHash, createHmac } from "node:crypto";
import type { EnrichmentCacheRepository } from "@cunote/core";
import { loadMonorepoEnv } from "./loadMonorepoEnv";

const GLOBAL_BUDGET_PROVIDER = "popbill_public_budget_global";
const GLOBAL_BUDGET_SUBJECT = "global";
const GLOBAL_EXHAUSTED_SCOPE = "day:exhausted";
const DEFAULT_CLIENT_HOURLY_LIMIT = 5;
const DEFAULT_GLOBAL_DAILY_LIMIT = 100;
const MAX_CONFIGURED_LIMIT = 10_000;
const MAX_LOCAL_CLIENT_WINDOWS = 10_000;

const localClientWindows = new Map<string, { windowStartMs: number; count: number }>();

interface PublicLookupEnvironment {
  CREDIT_BIZNO_HMAC_PEPPER?: string;
  CUNOTE_PUBLIC_POPBILL_PER_CLIENT_HOURLY_LIMIT?: string;
  CUNOTE_PUBLIC_POPBILL_GLOBAL_DAILY_LIMIT?: string;
}

export class PublicLookupProtectionError extends Error {
  readonly field?: string;

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PublicLookupProtectionError";
  }
}

/**
 * 공개 preview 호출자를 raw IP 저장 없이 가명 키로 바꾼다.
 * web 랜딩은 production에서 same-origin POST만 허용하고, native app 라우트는 IP 예산만 공유한다.
 */
export function publicLookupRequestKey(
  request: Request,
  options: { requireSameOrigin: boolean; env?: PublicLookupEnvironment },
): string {
  if (!options.env && process.env.NODE_ENV !== "production") loadMonorepoEnv();
  const env = options.env ?? process.env;
  const url = new URL(request.url);
  const local = isLocalHostname(url.hostname);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new PublicLookupProtectionError(
      "public_lookup_content_type_unsupported",
      "JSON 형식의 조회 요청만 허용됩니다.",
      415,
    );
  }
  if (options.requireSameOrigin) assertSameOrigin(request, url);

  const clientAddress = firstHeaderValue(request.headers.get("cf-connecting-ip"))
    ?? firstHeaderValue(request.headers.get("x-forwarded-for"))
    ?? firstHeaderValue(request.headers.get("x-real-ip"))
    ?? (local ? "local-development" : null);
  if (!clientAddress) {
    throw new PublicLookupProtectionError(
      "public_lookup_identity_unavailable",
      "요청 보안 정보를 확인할 수 없어 사업자 정보를 조회할 수 없습니다.",
      503,
    );
  }

  const secret = env.CREDIT_BIZNO_HMAC_PEPPER?.trim();
  if (!secret) {
    throw new PublicLookupProtectionError(
      "public_lookup_protection_unavailable",
      "공개 조회 보호 설정이 없어 사업자 정보를 조회할 수 없습니다.",
      503,
    );
  }
  return createHmac("sha256", secret)
    .update(`cunote:public-popbill-client:v1:${clientAddress}`)
    .digest("hex");
}

/**
 * 공개 preview cache miss가 NTS/DB/Popbill 외부 경로로 들어가기 전 호출하는 예산.
 * cache hit는 소모하지 않고, 미등록/폐업 같은 NTS 종료 결과는 공개 리소스 보호를 위해 소모한다.
 * IP 헤더는 direct-origin에서 신뢰 경계가 아니므로 프로세스 로컬 보조 제한에만 쓴다.
 * 실제 비용 상한은 신뢰 할당이 불필요한 DB 전체 일일 hard cap이 보장한다.
 */
export function assertPublicLookupClientRate(input: {
  clientKey: string;
  now: Date;
  env?: PublicLookupEnvironment;
}): void {
  const env = input.env ?? process.env;
  const clientLimit = configuredLimit(
    env.CUNOTE_PUBLIC_POPBILL_PER_CLIENT_HOURLY_LIMIT,
    DEFAULT_CLIENT_HOURLY_LIMIT,
  );
  const hour = fixedWindow(input.now, 60 * 60 * 1000);
  if (!consumeLocalClientWindow(input.clientKey, hour.start.getTime(), clientLimit)) {
    throw new PublicLookupProtectionError(
      "public_lookup_rate_limited",
      "조회 요청이 많습니다. 잠시 후 다시 시도해주세요.",
      429,
    );
  }
}

export async function reservePublicLookupBudget(input: {
  cache: EnrichmentCacheRepository;
  clientKey: string;
  reservationKey: string;
  now: Date;
  env?: PublicLookupEnvironment;
}): Promise<void> {
  const env = input.env ?? process.env;
  const globalLimit = configuredLimit(
    env.CUNOTE_PUBLIC_POPBILL_GLOBAL_DAILY_LIMIT,
    DEFAULT_GLOBAL_DAILY_LIMIT,
  );
  const day = fixedWindow(input.now, 24 * 60 * 60 * 1000);

  try {
    const exhausted = await input.cache.getFresh({
      provider: GLOBAL_BUDGET_PROVIDER,
      bizNo: GLOBAL_BUDGET_SUBJECT,
      scope: GLOBAL_EXHAUSTED_SCOPE,
      now: input.now,
    });
    if (exhausted) throw globalBudgetExhausted();

    const globalAllowed = await claimBudgetSlot({
      cache: input.cache,
      provider: GLOBAL_BUDGET_PROVIDER,
      subject: GLOBAL_BUDGET_SUBJECT,
      bucket: `day:${day.start.toISOString()}`,
      expiresAt: day.end,
      now: input.now,
      limit: globalLimit,
      seed: `${input.clientKey}:${input.reservationKey}`,
    });
    if (!globalAllowed) {
      const canonicalPayload = { state: "exhausted", bucket: `day:${day.start.toISOString()}` };
      await input.cache.put({
        provider: GLOBAL_BUDGET_PROVIDER,
        bizNo: GLOBAL_BUDGET_SUBJECT,
        scope: GLOBAL_EXHAUSTED_SCOPE,
        canonicalPayload,
        providerResultCode: "exhausted",
        fetchedAt: input.now,
        checkedAt: input.now,
        expiresAt: day.end,
      });
      throw globalBudgetExhausted();
    }
  } catch (error) {
    if (error instanceof PublicLookupProtectionError) throw error;
    throw new PublicLookupProtectionError(
      "public_lookup_budget_unavailable",
      "조회 한도를 안전하게 확인할 수 없어 진행할 수 없습니다.",
      503,
    );
  }
}

function consumeLocalClientWindow(clientKey: string, windowStartMs: number, limit: number): boolean {
  const current = localClientWindows.get(clientKey);
  if (current?.windowStartMs === windowStartMs) {
    if (current.count >= limit) return false;
    current.count += 1;
    // Map 삽입 순서를 최근 사용 순으로 갱신해 제거 시 오래된 키가 먼저 나가게 한다.
    localClientWindows.delete(clientKey);
    localClientWindows.set(clientKey, current);
    return true;
  }
  pruneLocalClientWindows(windowStartMs);
  localClientWindows.set(clientKey, { windowStartMs, count: 1 });
  return true;
}

function pruneLocalClientWindows(currentWindowStartMs: number): void {
  for (const [key, entry] of localClientWindows) {
    if (entry.windowStartMs < currentWindowStartMs) localClientWindows.delete(key);
  }
  while (localClientWindows.size >= MAX_LOCAL_CLIENT_WINDOWS) {
    const oldest = localClientWindows.keys().next().value as string | undefined;
    if (!oldest) break;
    localClientWindows.delete(oldest);
  }
}

function globalBudgetExhausted(): PublicLookupProtectionError {
  return new PublicLookupProtectionError(
    "public_lookup_budget_exhausted",
    "오늘 공개 사업자 정보 조회 한도가 소진되었습니다. 다음에 다시 시도해주세요.",
    429,
  );
}

async function claimBudgetSlot(input: {
  cache: EnrichmentCacheRepository;
  provider: string;
  subject: string;
  bucket: string;
  expiresAt: Date;
  now: Date;
  limit: number;
  seed: string;
}): Promise<boolean> {
  const start = slotStart(input.seed, input.bucket, input.limit);
  const windowKind = input.bucket.split(":", 1)[0] ?? "window";
  for (let offset = 0; offset < input.limit; offset += 1) {
    const slot = (start + offset) % input.limit;
    const canonicalPayload = { state: "reserved", bucket: input.bucket, slot };
    const claimed = await input.cache.claim({
      provider: input.provider,
      bizNo: input.subject,
      // 버킷 시각을 PK에 넣지 않고 만료 후 같은 slot 행을 갱신해 시간별 행 누적을 막는다.
      scope: `${windowKind}:slot:${slot}`,
      canonicalPayload,
      providerResultCode: "reserved",
      fetchedAt: input.now,
      checkedAt: input.now,
      expiresAt: input.expiresAt,
      now: input.now,
    });
    if (claimed) return true;
  }
  return false;
}

function assertSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("origin");
  const expectedHost = firstHeaderValue(request.headers.get("x-forwarded-host"))
    ?? request.headers.get("host")?.trim()
    ?? url.host;
  const expectedProtocol = firstHeaderValue(request.headers.get("x-forwarded-proto"))
    ?? url.protocol.replace(/:$/, "");
  let actual: URL;
  try {
    actual = new URL(origin ?? "");
  } catch {
    throw forbiddenOrigin();
  }
  if (actual.host !== expectedHost || actual.protocol !== `${expectedProtocol}:`) {
    throw forbiddenOrigin();
  }
}

function forbiddenOrigin(): PublicLookupProtectionError {
  return new PublicLookupProtectionError(
    "public_lookup_origin_forbidden",
    "허용되지 않은 출처의 조회 요청입니다.",
    403,
  );
}

function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim();
  if (!first || first.length > 128) return null;
  return first;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function configuredLimit(raw: string | undefined, fallback: number): number {
  const parsed = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_CONFIGURED_LIMIT);
}

function fixedWindow(now: Date, durationMs: number): { start: Date; end: Date } {
  const startMs = Math.floor(now.getTime() / durationMs) * durationMs;
  return { start: new Date(startMs), end: new Date(startMs + durationMs) };
}

function slotStart(seed: string, bucket: string, limit: number): number {
  const digest = createHash("sha256").update(`${seed}:${bucket}`).digest();
  return digest.readUInt32BE(0) % limit;
}
