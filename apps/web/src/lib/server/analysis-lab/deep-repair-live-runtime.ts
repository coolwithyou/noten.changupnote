import {
  initialLeaseRenewalFailureState,
  recordLeaseRenewalFailure,
  recordLeaseRenewalSuccess,
} from "./lease-renewal-policy";
import type { DeepRepairLiveRuntimeAuthority } from "./deep-repair-live-experiment";

interface LocalLeaseControl {
  readonly mode: string;
  readonly generation: number;
  readonly localOwnerId: string | null;
}

export interface DeepRepairLeaseClient {
  acquire(input: {
    readonly ownerId: string;
    readonly expectedGeneration: number;
  }): Promise<LocalLeaseControl>;
  renew(input: { readonly ownerId: string; readonly generation: number }): Promise<LocalLeaseControl>;
  release(input: { readonly ownerId: string; readonly generation: number }): Promise<void>;
}

interface RuntimeTimerDependencies {
  readonly scheduleRenewal?: (callback: () => Promise<void>) => () => void;
}

export function createDeepRepairLiveRuntimeAuthority(
  client: DeepRepairLeaseClient,
  timers: RuntimeTimerDependencies = {},
): DeepRepairLiveRuntimeAuthority {
  const scheduleRenewal = timers.scheduleRenewal ?? scheduleEvery45Seconds;
  return {
    async runExclusive(binding, run) {
      throwIfAborted(binding.signal);
      let operationError: unknown;
      let acquired = false;
      let stopRenewal: (() => void) | null = null;
      let cleanupSignals: (() => void) | null = null;
      let acquiredGeneration: number | null = null;
      let renewalPending: Promise<void> | null = null;
      try {
        const control = await client.acquire({
          ownerId: binding.ownerId,
          expectedGeneration: binding.expectedGeneration,
        });
        acquired = true;
        acquiredGeneration = control.generation;
        if (
          control.mode !== "local_subscription"
          || control.localOwnerId !== binding.ownerId
          || control.generation !== binding.expectedGeneration + 1
        ) {
          throw new Error("runtime lease generation/owner binding mismatch");
        }

        const leaseAbort = new AbortController();
        const combined = combineSignals(binding.signal, leaseAbort.signal);
        cleanupSignals = combined.cleanup;
        const failureState = initialLeaseRenewalFailureState();
        let renewalInFlight = false;
        stopRenewal = scheduleRenewal(async () => {
          if (renewalInFlight || leaseAbort.signal.aborted) return;
          renewalInFlight = true;
          const renew = async (): Promise<void> => {
            try {
              const renewed = await client.renew({
                ownerId: binding.ownerId,
                generation: control.generation,
              });
              if (
                renewed.mode !== "local_subscription"
                || renewed.localOwnerId !== binding.ownerId
                || renewed.generation !== binding.expectedGeneration + 1
              ) {
                throw new Error("renewed lease generation/owner binding mismatch");
              }
              recordLeaseRenewalSuccess(failureState);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const failure = recordLeaseRenewalFailure(failureState, message);
              if (failure.shouldAbort) leaseAbort.abort(error);
            } finally {
              renewalInFlight = false;
            }
          };
          renewalPending = renew();
          await renewalPending;
        });

        const value = await run(combined.signal);
        throwIfAborted(combined.signal);
        if (failureState.fatalErrorMessage !== null) {
          throw new Error(failureState.fatalErrorMessage);
        }
        return value;
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        const cleanupErrors: unknown[] = [];
        try { stopRenewal?.(); } catch (error) { cleanupErrors.push(error); }
        try { await renewalPending; } catch (error) { cleanupErrors.push(error); }
        try { cleanupSignals?.(); } catch (error) { cleanupErrors.push(error); }
        if (acquired && acquiredGeneration !== null) {
          try {
            await client.release({ ownerId: binding.ownerId, generation: acquiredGeneration });
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length > 0) {
          const cleanupError = cleanupErrors.length === 1
            ? cleanupErrors[0]
            : new AggregateError(cleanupErrors, "runtime lease cleanup failed");
          if (operationError === undefined) throw cleanupError;
          if (operationError instanceof Error && operationError.cause === undefined) {
            operationError.cause = cleanupError;
          }
        }
      }
    },
  };
}

function scheduleEvery45Seconds(callback: () => Promise<void>): () => void {
  const timer = setInterval(() => { void callback(); }, 45_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function combineSignals(
  first: AbortSignal,
  second: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromFirst = () => controller.abort(first.reason);
  const abortFromSecond = () => controller.abort(second.reason);
  if (first.aborted) abortFromFirst();
  else first.addEventListener("abort", abortFromFirst, { once: true });
  if (second.aborted) abortFromSecond();
  else second.addEventListener("abort", abortFromSecond, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      first.removeEventListener("abort", abortFromFirst);
      second.removeEventListener("abort", abortFromSecond);
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}
