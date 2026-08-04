export interface ParallelApplicationOutcome<T> {
  result: T | null;
  error: string | null;
}

/**
 * Kordoc enqueue와 22축 primary를 서로 기다리지 않고 같은 event-loop turn에 착수한다.
 * 보조 enqueue 오류는 값으로 낮춰 primary의 성공/실패 의미를 바꾸지 않는다.
 */
export function startPrimaryWithApplicationPrecompute<TPrimary, TApplication>(input: {
  startPrimary: () => Promise<TPrimary>;
  startApplication: () => Promise<TApplication>;
}): {
  primary: Promise<TPrimary>;
  application: Promise<ParallelApplicationOutcome<TApplication>>;
} {
  const application = Promise.resolve().then(input.startApplication).then(
    (result) => ({ result, error: null }),
    (error: unknown) => ({
      result: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const primary = input.startPrimary();
  return { primary, application };
}
