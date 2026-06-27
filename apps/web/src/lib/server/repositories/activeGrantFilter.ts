import type { Grant, NormalizedGrant } from "@cunote/contracts";

export function isGrantActiveAt(grant: Grant, asOf: Date = new Date()): boolean {
  if (grant.status === "closed") return false;
  const applyEnd = grant.apply_end ? grant.apply_end.slice(0, 10) : null;
  return !applyEnd || applyEnd >= asDateOnly(asOf);
}

export function filterActiveGrants<TPayload>(
  entries: Array<NormalizedGrant<TPayload>>,
  options: { asOf?: Date; limit?: number } = {},
): Array<NormalizedGrant<TPayload>> {
  const asOf = options.asOf ?? new Date();
  const filtered = entries.filter((entry) => isGrantActiveAt(entry.grant, asOf));
  return options.limit === undefined ? filtered : filtered.slice(0, options.limit);
}

export function activeGrantApplyEndCutoff(asOf: Date = new Date()): Date {
  return new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
}

function asDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
