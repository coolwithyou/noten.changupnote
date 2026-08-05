export interface ParallelApplicationOutcome<T> {
  result: T | null;
  error: string | null;
}

export interface ApplicationPrecomputeEnqueueExceptionEvent {
  runId: string;
  exceptionKey: string;
  eventType: "opened";
  reasonCode: "application_precompute_enqueue_failed";
  actorType: "system";
  actor: string;
  detail: {
    component: "application_precompute_enqueue";
    terminalRoute: "operational_attention";
    error: string;
  };
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

/** enqueue 실패만 non-blocking 운영 예외로 정규화한다. 성공은 별도 event를 만들지 않는다. */
export function applicationPrecomputeEnqueueExceptionEvent(input: {
  runId: string;
  actor: string;
  outcome: ParallelApplicationOutcome<unknown>;
}): ApplicationPrecomputeEnqueueExceptionEvent | null {
  if (!input.outcome.error) return null;
  return {
    runId: input.runId,
    exceptionKey: `${input.runId}:application_precompute_enqueue`,
    eventType: "opened",
    reasonCode: "application_precompute_enqueue_failed",
    actorType: "system",
    actor: input.actor,
    detail: {
      component: "application_precompute_enqueue",
      terminalRoute: "operational_attention",
      error: input.outcome.error.slice(0, 2_000),
    },
  };
}
