const EXECUTION_SCOPED_TIMEOUT_FETCH = Symbol.for(
  "cunote.deep-analysis.execution-scoped-timeout-fetch",
);

export const EXECUTION_TIMEOUT_HEADER = "x-cunote-execution-timeout-ms";

/**
 * 로컬 CLI 전송층처럼 자체 대기열을 가진 fetch는 실제 실행 슬롯을 얻은 뒤 타이머를
 * 시작한다. API fetch에는 이 표식을 붙이지 않아 기존 네트워크 전체 timeout을 유지한다.
 */
export function markExecutionScopedTimeoutFetch(fetchImpl: typeof fetch): typeof fetch {
  Object.defineProperty(fetchImpl, EXECUTION_SCOPED_TIMEOUT_FETCH, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return fetchImpl;
}

export function hasExecutionScopedTimeout(fetchImpl: typeof fetch): boolean {
  return Boolean(
    (fetchImpl as typeof fetch & { [EXECUTION_SCOPED_TIMEOUT_FETCH]?: boolean })[
      EXECUTION_SCOPED_TIMEOUT_FETCH
    ],
  );
}
