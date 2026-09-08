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
  /** The DB client returns this; optional keeps pure/fake clients source-compatible. */
  readonly localLeaseExpiresAt?: string | null;
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
  readonly scheduleLeaseExpiry?: (expiresAtMs: number, callback: () => void) => () => void;
  readonly now?: () => number;
}

export function createDeepRepairLiveRuntimeAuthority(
  client: DeepRepairLeaseClient,
  timers: RuntimeTimerDependencies = {},
): DeepRepairLiveRuntimeAuthority {
  const scheduleRenewal = timers.scheduleRenewal ?? scheduleEvery45Seconds;
  const scheduleLeaseExpiry = timers.scheduleLeaseExpiry ?? scheduleAt;
  const now = timers.now ?? Date.now;
  return {
    async runExclusive(binding, run) {
      throwIfAborted(binding.signal);
      let operationError: unknown;
      let acquired = false;
      let stopRenewal: (() => void) | null = null;
      const leaseDeadline: {
        confirmedExpiresAtMs: number | null;
        stop: (() => void) | null;
      } = { confirmedExpiresAtMs: null, stop: null };
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
        const abortForConfirmedLeaseLoss = (message: string, cause?: unknown): void => {
          recordLeaseRenewalFailure(failureState, message, "confirmed_lease_loss");
          if (leaseAbort.signal.aborted) return;
          leaseAbort.abort(cause instanceof Error ? cause : new ConfirmedLeaseLossError(message));
        };
        const abortIfConfirmedLeaseExpired = (): boolean => {
          if (
            leaseDeadline.confirmedExpiresAtMs === null
            || now() < leaseDeadline.confirmedExpiresAtMs
          ) {
            return false;
          }
          abortForConfirmedLeaseLoss("runtime lease expired before renewal confirmation");
          return true;
        };
        const clearLeaseExpiry = (): void => {
          const stop = leaseDeadline.stop;
          leaseDeadline.stop = null;
          stop?.();
        };
        const armLeaseExpiry = (lease: LocalLeaseControl): void => {
          const expiry = lease.localLeaseExpiresAt;
          if (expiry === undefined) return;
          const expiresAtMs = expiry === null ? Number.NaN : Date.parse(expiry);
          if (!Number.isFinite(expiresAtMs)) {
            abortForConfirmedLeaseLoss("runtime lease expiry binding mismatch");
            return;
          }
          clearLeaseExpiry();
          if (expiresAtMs <= now()) {
            abortForConfirmedLeaseLoss("runtime lease expired before renewal confirmation");
            return;
          }
          leaseDeadline.confirmedExpiresAtMs = expiresAtMs;
          leaseDeadline.stop = scheduleLeaseExpiry(expiresAtMs, () => {
            if (leaseDeadline.confirmedExpiresAtMs !== expiresAtMs) return;
            abortForConfirmedLeaseLoss("runtime lease expired before renewal confirmation");
          });
        };
        armLeaseExpiry(control);
        throwIfAborted(combined.signal);
        let renewalInFlight = false;
        stopRenewal = scheduleRenewal(async () => {
          if (renewalInFlight || combined.signal.aborted) return;
          if (abortIfConfirmedLeaseExpired()) return;
          renewalInFlight = true;
          const renew = async (): Promise<void> => {
            try {
              const renewed = await waitForLeaseOperationOrAbort(
                client.renew({
                  ownerId: binding.ownerId,
                  generation: control.generation,
                }),
                combined.signal,
              );
              if (abortIfConfirmedLeaseExpired()) return;
              if (
                renewed.mode !== "local_subscription"
                || renewed.localOwnerId !== binding.ownerId
                || renewed.generation !== binding.expectedGeneration + 1
              ) {
                abortForConfirmedLeaseLoss("renewed lease generation/owner binding mismatch");
                return;
              }
              recordLeaseRenewalSuccess(failureState);
              armLeaseExpiry(renewed);
            } catch (error) {
              if (combined.signal.aborted) return;
              const message = error instanceof Error ? error.message : String(error);
              const failure = recordLeaseRenewalFailure(
                failureState,
                message,
                isRuntimeControlConflict(error) ? "confirmed_lease_loss" : "transient",
              );
              if (failure.shouldAbort) leaseAbort.abort(error);
            } finally {
              renewalInFlight = false;
            }
          };
          renewalPending = renew();
          await renewalPending;
        });

        const value = await run(combined.signal);
        const stopScheduledRenewal = stopRenewal;
        stopRenewal = null;
        stopScheduledRenewal?.();
        await renewalPending;
        abortIfConfirmedLeaseExpired();
        clearLeaseExpiry();
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
        try { leaseDeadline.stop?.(); } catch (error) { cleanupErrors.push(error); }
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

function scheduleAt(expiresAtMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, Math.max(0, expiresAtMs - Date.now()));
  timer.unref?.();
  return () => clearTimeout(timer);
}

function waitForLeaseOperationOrAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // The client operation was already created. Observe a later rejection even
    // though the caller's abort wins this race.
    operation.then(() => undefined, () => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isRuntimeControlConflict(error: unknown): boolean {
  return error instanceof Error
    && error.name === "DeepAnalysisRuntimeControlError"
    && "code" in error
    && error.code === "runtime_control_conflict";
}

class ConfirmedLeaseLossError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmedLeaseLossError";
  }
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
  throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
