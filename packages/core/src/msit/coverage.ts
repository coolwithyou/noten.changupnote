import type { NormalizedGrant } from "@cunote/contracts";
import { normalizeGrantDedupText, scoreGrantPair, type GrantDedupComparable } from "../dedup/grant-dedup.js";
import type { MsitAnnouncement } from "./fetch.js";

export type MsitOverlapClass = "exact_title" | "high_confidence" | "review" | "likely_unique";

export interface MsitCoverageRow {
  subject: string;
  pressDate: string;
  department: string | null;
  overlapClass: MsitOverlapClass;
  bestExistingGrantId: string | null;
  bestExistingTitle: string | null;
  bestScore: number;
  reasons: string[];
}

export interface MsitCoverageReport {
  asOf: string;
  windowDays: number;
  windowStart: string;
  receivedCount: number;
  invalidPressDateCount: number;
  futurePressDateCount: number;
  inWindowCount: number;
  exactTitleCount: number;
  highConfidenceOverlapCount: number;
  reviewRequiredCount: number;
  likelyUniqueCount: number;
  conservativeIncrementalCount: number;
  rows: MsitCoverageRow[];
}

const HIGH_CONFIDENCE_SCORE = 0.82;
const REVIEW_SCORE = 0.6;

export function measureMsitIncrementalCoverage<TPayload>(input: {
  announcements: MsitAnnouncement[];
  existingGrants: Array<NormalizedGrant<TPayload>>;
  asOf?: Date;
  windowDays?: number;
}): MsitCoverageReport {
  const asOf = validDate(input.asOf ?? new Date(), "asOf");
  const windowDays = boundedWindowDays(input.windowDays ?? 90);
  const windowStart = new Date(asOf);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
  const asOfDay = utcDay(asOf);
  const windowStartDay = utcDay(windowStart);
  let invalidPressDateCount = 0;
  let futurePressDateCount = 0;
  const rows: MsitCoverageRow[] = [];

  for (const announcement of input.announcements) {
    const pressDate = parsePressDate(announcement.pressDt);
    if (!pressDate) {
      invalidPressDateCount += 1;
      continue;
    }
    const pressDay = utcDay(pressDate);
    if (pressDay > asOfDay) {
      futurePressDateCount += 1;
      continue;
    }
    if (pressDay < windowStartDay) continue;
    rows.push(classifyOverlap(announcement, pressDate, input.existingGrants));
  }

  rows.sort((left, right) => right.pressDate.localeCompare(left.pressDate) || left.subject.localeCompare(right.subject));
  const count = (overlapClass: MsitOverlapClass) => rows.filter((row) => row.overlapClass === overlapClass).length;
  const exactTitleCount = count("exact_title");
  const highConfidenceOverlapCount = count("high_confidence");
  const reviewRequiredCount = count("review");
  const likelyUniqueCount = count("likely_unique");
  return {
    asOf: asOf.toISOString(),
    windowDays,
    windowStart: windowStart.toISOString(),
    receivedCount: input.announcements.length,
    invalidPressDateCount,
    futurePressDateCount,
    inWindowCount: rows.length,
    exactTitleCount,
    highConfidenceOverlapCount,
    reviewRequiredCount,
    likelyUniqueCount,
    conservativeIncrementalCount: likelyUniqueCount,
    rows,
  };
}

function classifyOverlap<TPayload>(
  announcement: MsitAnnouncement,
  pressDate: Date,
  existingGrants: Array<NormalizedGrant<TPayload>>,
): MsitCoverageRow {
  const comparable: GrantDedupComparable = {
    title: announcement.subject,
    agency_jurisdiction: "과학기술정보통신부",
    agency_operator: announcement.deptName ?? null,
    category_l1: null,
    category_l2: null,
    apply_start: null,
    apply_end: null,
  };
  const normalizedSubject = normalizeGrantDedupText(announcement.subject);
  let best: { entry: NormalizedGrant<TPayload>; score: number; reasons: string[]; exactTitle: boolean } | null = null;
  for (const entry of existingGrants) {
    const scored = scoreGrantPair(comparable, entry.grant);
    const candidate = {
      entry,
      score: scored.score,
      reasons: scored.reasons,
      exactTitle: normalizedSubject.length > 0 && normalizedSubject === normalizeGrantDedupText(entry.grant.title),
    };
    if (!best || Number(candidate.exactTitle) > Number(best.exactTitle) ||
      (candidate.exactTitle === best.exactTitle && candidate.score > best.score)) best = candidate;
  }
  const overlapClass: MsitOverlapClass = best?.exactTitle
    ? "exact_title"
    : (best?.score ?? 0) >= HIGH_CONFIDENCE_SCORE
      ? "high_confidence"
      : (best?.score ?? 0) >= REVIEW_SCORE
        ? "review"
        : "likely_unique";
  return {
    subject: announcement.subject,
    pressDate: pressDate.toISOString().slice(0, 10),
    department: announcement.deptName ?? null,
    overlapClass,
    bestExistingGrantId: best ? (best.entry.grant.id ?? `${best.entry.grant.source}:${best.entry.grant.source_id}`) : null,
    bestExistingTitle: best?.entry.grant.title ?? null,
    bestScore: best?.score ?? 0,
    reasons: best?.reasons ?? [],
  };
}

function parsePressDate(value: string): Date | null {
  const normalized = value.trim();
  const match = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})$/.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? parsed
    : null;
}

function validDate(value: Date, label: string): Date {
  if (Number.isNaN(value.getTime())) throw new Error(`${label} must be a valid date`);
  return value;
}

function boundedWindowDays(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 366) throw new Error("windowDays must be an integer between 1 and 366");
  return value;
}

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}
