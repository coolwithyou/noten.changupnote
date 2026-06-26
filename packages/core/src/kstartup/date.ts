import type { GrantStatus } from "@cunote/contracts";

export function parseKStartupDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function statusFromApplyWindow(
  startValue: string | null | undefined,
  endValue: string | null | undefined,
  asOf: Date,
): GrantStatus {
  const start = parseKStartupDate(startValue);
  const end = parseKStartupDate(endValue);
  const today = asDateOnly(asOf);

  if (start && today < start) return "upcoming";
  if (end && today > end) return "closed";
  if (start || end) return "open";
  return "unknown";
}

function asDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
