import type { Grant, NormalizedGrant } from "@cunote/contracts";

export function isGrantActiveAt(grant: Grant, asOf: Date = new Date()): boolean {
  if (grant.status === "closed") return false;
  if (isClearlyStaleUndatedGrant(grant, asOf)) return false;
  const applyEnd = grant.apply_end ? grant.apply_end.slice(0, 10) : null;
  return !applyEnd || applyEnd >= asDateOnly(asOf);
}

export function isKStartupRecruitmentClosedPayload(source: Grant["source"], payload: unknown): boolean {
  if (source !== "kstartup" || !isRecord(payload)) return false;
  const recruitmentProgress = payload["rcrt_prgs_yn"];
  return typeof recruitmentProgress === "string" && recruitmentProgress.trim().toUpperCase() === "N";
}

export function isClearlyStaleUndatedGrant(
  grant: Pick<Grant, "source" | "status" | "title" | "apply_end">,
  asOf: Date = new Date(),
): boolean {
  if (grant.source !== "kstartup" || grant.status !== "unknown" || grant.apply_end) return false;
  const currentYear = koreaDateParts(asOf).year;
  const titleYears = [...grant.title.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?=[^0-9]|$)/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1990 && year <= currentYear + 1);
  return titleYears.length > 0 && Math.max(...titleYears) <= currentYear - 2;
}

export function filterActiveGrants<TPayload>(
  entries: Array<NormalizedGrant<TPayload>>,
  options: { asOf?: Date; limit?: number } = {},
): Array<NormalizedGrant<TPayload>> {
  const asOf = options.asOf ?? new Date();
  const filtered = entries.filter((entry) =>
    isGrantActiveAt(entry.grant, asOf) &&
    !isKStartupRecruitmentClosedPayload(entry.grant.source, entry.raw.payload)
  );
  return options.limit === undefined ? filtered : filtered.slice(0, options.limit);
}

export function activeGrantApplyEndCutoff(asOf: Date = new Date()): Date {
  const { year, month, day } = koreaDateParts(asOf);
  return new Date(Date.UTC(year, month - 1, day));
}

function asDateOnly(value: Date): string {
  const { year, month, day } = koreaDateParts(value);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function koreaDateParts(value: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const read = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
