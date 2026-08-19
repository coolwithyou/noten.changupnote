const MEBIBYTE = 1024 * 1024;
const BASE_TIMEOUT_MS = 35_000;
const PER_MEBIBYTE_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 120_000;

export const STUDIO_INITIALIZATION_ATTEMPTS = 2;

export class StudioInitializationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`문서 편집기가 ${Math.ceil(timeoutMs / 1_000)}초 안에 응답하지 않았습니다.`);
    this.name = "StudioInitializationTimeoutError";
  }
}

/** 작은 신청서는 빠르게 복구하고, 큰 문서는 크기에 비례해 초기 렌더 시간을 더 허용한다. */
export function studioInitializationTimeoutMs(byteLength: number): number {
  const safeByteLength = Number.isFinite(byteLength) && byteLength > 0 ? byteLength : 0;
  const sizeAllowance = Math.ceil(safeByteLength / MEBIBYTE) * PER_MEBIBYTE_TIMEOUT_MS;
  return Math.min(BASE_TIMEOUT_MS + sizeAllowance, MAX_TIMEOUT_MS);
}

export function studioUrlForInitializationAttempt(
  studioUrl: string,
  attempt: number,
  nonce: string,
): string {
  if (attempt === 0) return studioUrl;
  const url = new URL(studioUrl);
  url.searchParams.set("host-reconnect", `${attempt}-${nonce}`);
  return url.href;
}

export async function withStudioInitializationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StudioInitializationTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
