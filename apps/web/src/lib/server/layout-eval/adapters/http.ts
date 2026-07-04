/**
 * layout 엔진 어댑터 공용 HTTP/파일 유틸.
 *   - 페이지 이미지 읽기(버퍼/base64)
 *   - rate limit 직렬화(최소 간격)
 *   - 429/5xx 지수 백오프 재시도 (대조 §5-6: Upstage 1 RPS + 429 backoff)
 */
import { readFile } from "node:fs/promises";

export async function readFileBuffer(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function readFileBase64(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString("base64");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 최소 간격 직렬 rate limiter. wait() 를 await 하면 직전 호출로부터 minIntervalMs 를 보장한다. */
export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly minIntervalMs: number) {}

  wait(): Promise<void> {
    // 직렬 체이닝으로 동시 호출에서도 간격을 지킨다.
    const next = this.chain.then(async () => {
      const now = Date.now();
      const gap = this.minIntervalMs - (now - this.last);
      if (gap > 0) await sleep(gap);
      this.last = Date.now();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  /** 재시도 전 rate limiter 대기(있으면). */
  limiter?: RateLimiter;
}

/**
 * fetch + 429/5xx 지수 백오프. 재시도 소진 시 마지막 응답을 그대로 반환한다(호출측이 상태 판정).
 * Retry-After 헤더가 있으면 우선한다.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.limiter) await opts.limiter.wait();
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (error) {
      if (attempt >= opts.retries) throw error;
      await sleep(backoffMs(opts.baseDelayMs, attempt));
      attempt += 1;
      continue;
    }
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt >= opts.retries) return res;
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    await sleep(retryAfter ?? backoffMs(opts.baseDelayMs, attempt));
    attempt += 1;
  }
}

function backoffMs(base: number, attempt: number): number {
  const jitter = Math.floor(Math.random() * base);
  return base * 2 ** attempt + jitter;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseFloat(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}
