export const MAX_CONSECUTIVE_LEASE_RENEWAL_FAILURES = 2;

export type LeaseRenewalFailureKind = "transient" | "confirmed_lease_loss";

export interface LeaseRenewalFailureState {
  consecutiveFailures: number;
  fatalErrorMessage: string | null;
}

export function initialLeaseRenewalFailureState(): LeaseRenewalFailureState {
  return { consecutiveFailures: 0, fatalErrorMessage: null };
}

export function recordLeaseRenewalSuccess(
  state: LeaseRenewalFailureState,
): void {
  if (state.fatalErrorMessage !== null) return;
  state.consecutiveFailures = 0;
}

export function recordLeaseRenewalFailure(
  state: LeaseRenewalFailureState,
  errorMessage: string,
  kind: LeaseRenewalFailureKind = "transient",
): { shouldAbort: boolean; consecutiveFailures: number } {
  if (state.fatalErrorMessage !== null) {
    return { shouldAbort: true, consecutiveFailures: state.consecutiveFailures };
  }
  state.consecutiveFailures += 1;
  const shouldAbort = kind === "confirmed_lease_loss"
    || state.consecutiveFailures >= MAX_CONSECUTIVE_LEASE_RENEWAL_FAILURES;
  if (shouldAbort) state.fatalErrorMessage = errorMessage;
  return { shouldAbort, consecutiveFailures: state.consecutiveFailures };
}
