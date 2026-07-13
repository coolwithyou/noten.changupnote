import type { Grant, NormalizedGrant } from "@cunote/contracts";

export interface GrantDedupCandidate {
  canonicalGrantKey: string;
  memberGrantKey: string;
  score: number;
  reasons: string[];
  decision?: GrantDedupDecision;
  relation?: GrantRelation;
}

export interface FindGrantDedupCandidatesOptions {
  minScore?: number;
  crossSourceOnly?: boolean;
}

export interface ScoredGrantPair {
  score: number;
  reasons: string[];
  signals: GrantDedupSignals;
}

export interface GrantDedupSignals {
  title: number;
  agency: number;
  schedule: number;
  category: number;
  exactNormalizedTitle: boolean;
  exactSourceId: boolean;
  exactCanonicalUrl: boolean;
  yearConflict: boolean;
  roundConflict: boolean;
  scheduleConflict: boolean;
}

export type GrantDedupDecision = "auto_duplicate" | "review" | "distinct";
export type GrantRelation = "same_announcement" | "revision" | "extension" | "reannouncement" | "related_program";

export interface GrantDedupAssessment extends ScoredGrantPair {
  decision: GrantDedupDecision;
  relation: GrantRelation;
}

export interface GrantDedupPairAssessment extends GrantDedupAssessment {
  leftGrantKey: string;
  rightGrantKey: string;
}

export interface ConfirmedGrantDedupLink {
  canonicalGrantKey: string;
  memberGrantKey: string;
}

export type GrantDedupComparable = Pick<
  Grant,
  | "title"
  | "agency_jurisdiction"
  | "agency_operator"
  | "category_l1"
  | "category_l2"
  | "apply_start"
  | "apply_end"
> & Partial<Pick<Grant, "source_id" | "url">>;

const DEFAULT_MIN_SCORE = 0.82;
const STOP_WORDS = new Set([
  "2026",
  "2025",
  "사업",
  "지원",
  "모집",
  "공고",
  "참여",
  "기업",
  "프로그램",
]);

export function findGrantDedupCandidates<TPayload>(
  entries: Array<NormalizedGrant<TPayload>>,
  options: FindGrantDedupCandidatesOptions = {},
): GrantDedupCandidate[] {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const crossSourceOnly = options.crossSourceOnly ?? true;
  const candidates: GrantDedupCandidate[] = [];

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (!left || !right) continue;
      if (crossSourceOnly && left.grant.source === right.grant.source) continue;

      const pair = assessGrantPair(left.grant, right.grant);
      if (pair.score < minScore && pair.decision !== "auto_duplicate") continue;
      const [canonical, member] = sortGrantEntryPair(left, right);
      candidates.push({
        canonicalGrantKey: grantDedupKey(canonical.grant),
        memberGrantKey: grantDedupKey(member.grant),
        score: pair.score,
        reasons: pair.reasons,
        decision: pair.decision,
        relation: pair.relation,
      });
    }
  }

  return candidates.sort((left, right) =>
    right.score - left.score ||
    left.canonicalGrantKey.localeCompare(right.canonicalGrantKey) ||
    left.memberGrantKey.localeCompare(right.memberGrantKey)
  );
}

/** 점수 cutoff와 무관하게 자동 병합·검토 후보를 모두 반환하는 품질 보고용 경로. */
export function findGrantDedupAssessments<TPayload>(
  entries: Array<NormalizedGrant<TPayload>>,
  options: { crossSourceOnly?: boolean; includeDistinct?: boolean } = {},
): GrantDedupPairAssessment[] {
  const crossSourceOnly = options.crossSourceOnly ?? true;
  const includeDistinct = options.includeDistinct ?? false;
  const assessments: GrantDedupPairAssessment[] = [];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (!left || !right) continue;
      if (crossSourceOnly && left.grant.source === right.grant.source) continue;
      const assessment = assessGrantPair(left.grant, right.grant);
      if (!includeDistinct && assessment.decision === "distinct") continue;
      const [leftGrantKey, rightGrantKey] = [grantDedupKey(left.grant), grantDedupKey(right.grant)].sort();
      assessments.push({ ...assessment, leftGrantKey: leftGrantKey!, rightGrantKey: rightGrantKey! });
    }
  }
  return assessments.sort((left, right) =>
    decisionRank(left.decision) - decisionRank(right.decision) ||
    right.score - left.score ||
    left.leftGrantKey.localeCompare(right.leftGrantKey) ||
    left.rightGrantKey.localeCompare(right.rightGrantKey));
}

/** confirmed occurrence component를 canonical 한 건으로 접고, 최신 신청기간과 파생 필드를 보존한다. */
export function collapseConfirmedGrantOccurrences<TPayload>(
  entries: Array<NormalizedGrant<TPayload>>,
  links: ConfirmedGrantDedupLink[],
): Array<NormalizedGrant<TPayload>> {
  if (links.length === 0) return entries;
  const canonicalByMember = new Map(links.map((link) => [link.memberGrantKey, link.canonicalGrantKey]));
  const rootFor = (key: string): string => {
    const seen = new Set<string>();
    let current = key;
    while (canonicalByMember.has(current) && !seen.has(current)) {
      seen.add(current);
      current = canonicalByMember.get(current)!;
    }
    return current;
  };
  const groups = new Map<string, Array<NormalizedGrant<TPayload>>>();
  const rootOrder: string[] = [];
  for (const entry of entries) {
    const root = rootFor(grantDedupKey(entry.grant));
    if (!groups.has(root)) rootOrder.push(root);
    groups.set(root, [...(groups.get(root) ?? []), entry]);
  }
  return rootOrder.map((root) => mergeOccurrenceGroup(root, groups.get(root) ?? []));
}

export function grantDedupKey(grant: Grant): string {
  return grant.id ?? `${grant.source}:${grant.source_id}`;
}

export function scoreGrantPair(left: GrantDedupComparable, right: GrantDedupComparable): ScoredGrantPair {
  const title = titleSimilarity(left.title, right.title);
  const agency = maxSimilarity([
    textSimilarity(left.agency_jurisdiction, right.agency_jurisdiction),
    textSimilarity(left.agency_operator, right.agency_operator),
  ]);
  const schedule = scheduleSimilarity(left, right);
  const category = maxSimilarity([
    textSimilarity(left.category_l1, right.category_l1),
    textSimilarity(left.category_l2, right.category_l2),
  ]);
  const signals: GrantDedupSignals = {
    title: round(title),
    agency: round(agency),
    schedule: round(schedule),
    category: round(category),
    exactNormalizedTitle: normalizeGrantDedupText(left.title) === normalizeGrantDedupText(right.title),
    exactSourceId: Boolean(left.source_id && right.source_id && left.source_id === right.source_id),
    exactCanonicalUrl: canonicalUrl(left.url) !== null && canonicalUrl(left.url) === canonicalUrl(right.url),
    yearConflict: setsConflict(yearTokens(left.title), yearTokens(right.title)),
    roundConflict: setsConflict(roundTokens(left.title), roundTokens(right.title)),
    scheduleConflict: scheduleConflict(left, right),
  };
  if (title < 0.55) return {
    score: round(title * 0.7),
    reasons: [`title:${round(title)}`],
    signals,
  };

  const score = title * 0.7 + agency * 0.15 + schedule * 0.1 + category * 0.05;
  const reasons = [
    `title:${round(title)}`,
    `agency:${round(agency)}`,
    `schedule:${round(schedule)}`,
    `category:${round(category)}`,
  ];

  return { score: round(score), reasons, signals };
}

/** 자동 숨김과 사람 검토 후보를 분리한다. 연도·회차·비중첩 기간 충돌은 자동 병합하지 않는다. */
export function assessGrantPair(
  left: GrantDedupComparable,
  right: GrantDedupComparable,
): GrantDedupAssessment {
  const scored = scoreGrantPair(left, right);
  const { signals } = scored;
  const hasConflict = signals.yearConflict || signals.roundConflict || signals.scheduleConflict;
  const strongIdentity = signals.exactSourceId || signals.exactCanonicalUrl;
  const exactEvidence =
    signals.exactCanonicalUrl ||
    (signals.exactSourceId && signals.title >= 0.55) ||
    (signals.exactNormalizedTitle && (signals.agency >= 0.85 || signals.schedule === 1));
  const highConfidenceEvidence = scored.score >= 0.9 && signals.title >= 0.9 &&
    (signals.agency >= 0.85 || signals.schedule === 1 || strongIdentity);

  if (!hasConflict && (exactEvidence || highConfidenceEvidence)) {
    return { ...scored, decision: "auto_duplicate", relation: "same_announcement" };
  }
  if (scored.score >= DEFAULT_MIN_SCORE || (signals.title >= 0.65 && hasConflict)) {
    return {
      ...scored,
      decision: "review",
      relation: relationForConflict(signals),
    };
  }
  return { ...scored, decision: "distinct", relation: "related_program" };
}

function sortGrantEntryPair<TPayload>(
  left: NormalizedGrant<TPayload>,
  right: NormalizedGrant<TPayload>,
): [NormalizedGrant<TPayload>, NormalizedGrant<TPayload>] {
  const qualityDifference = occurrenceQuality(right) - occurrenceQuality(left);
  if (qualityDifference !== 0) return qualityDifference > 0 ? [right, left] : [left, right];
  const leftUpdated = Date.parse(left.grant.updated_at ?? "");
  const rightUpdated = Date.parse(right.grant.updated_at ?? "");
  if (!Number.isNaN(leftUpdated) || !Number.isNaN(rightUpdated)) {
    const normalizedLeft = Number.isNaN(leftUpdated) ? 0 : leftUpdated;
    const normalizedRight = Number.isNaN(rightUpdated) ? 0 : rightUpdated;
    if (normalizedLeft !== normalizedRight) return normalizedRight > normalizedLeft ? [right, left] : [left, right];
  }
  return grantDedupKey(left.grant).localeCompare(grantDedupKey(right.grant)) <= 0 ? [left, right] : [right, left];
}

function occurrenceQuality<TPayload>(entry: NormalizedGrant<TPayload>): number {
  const structuredCriteria = entry.criteria.filter((criterion) =>
    criterion.operator !== "text_only" && criterion.needs_review !== true).length;
  const convertedAttachments = (entry.raw.attachments ?? []).filter((attachment) =>
    attachment.conversion?.status === "converted").length;
  return (
    structuredCriteria * 5 +
    convertedAttachments * 4 +
    (entry.grant.url ? 3 : 0) +
    (entry.grant.apply_start ? 1 : 0) +
    (entry.grant.apply_end ? 1 : 0) +
    (entry.grant.agency_operator || entry.grant.agency_jurisdiction ? 1 : 0) +
    Math.min(entry.grant.required_documents?.length ?? 0, 3) +
    Math.round(entry.grant.overall_confidence * 2)
  );
}

function mergeOccurrenceGroup<TPayload>(
  root: string,
  entries: Array<NormalizedGrant<TPayload>>,
): NormalizedGrant<TPayload> {
  const canonical = entries.find((entry) => grantDedupKey(entry.grant) === root) ??
    [...entries].sort((left, right) => occurrenceQuality(right) - occurrenceQuality(left))[0];
  if (!canonical || entries.length <= 1) return canonical ?? entries[0]!;
  const applyStart = minDateString(entries.map((entry) => entry.grant.apply_start));
  const applyEnd = maxDateString(entries.map((entry) => entry.grant.apply_end));
  const updatedAt = maxDateString(entries.map((entry) => entry.grant.updated_at));
  const grant: Grant = {
    ...canonical.grant,
    status: mergedStatus(entries.map((entry) => entry.grant.status)),
    f_regions: uniqueStrings(entries.flatMap((entry) => entry.grant.f_regions)),
    f_industries: uniqueStrings(entries.flatMap((entry) => entry.grant.f_industries)),
    f_sizes: uniqueStrings(entries.flatMap((entry) => entry.grant.f_sizes)),
    f_founder_traits: uniqueStrings(entries.flatMap((entry) => entry.grant.f_founder_traits)),
    f_required_certs: uniqueStrings(entries.flatMap((entry) => entry.grant.f_required_certs)),
    overall_confidence: Math.max(...entries.map((entry) => entry.grant.overall_confidence)),
  };
  if (applyStart) grant.apply_start = applyStart;
  if (applyEnd) grant.apply_end = applyEnd;
  if (updatedAt) grant.updated_at = updatedAt;
  if (!grant.url) grant.url = entries.find((entry) => entry.grant.url)?.grant.url ?? null;
  return { ...canonical, grant };
}

function minDateString(values: Array<string | null | undefined>): string | null {
  return extremeDateString(values, "min");
}
function maxDateString(values: Array<string | null | undefined>): string | null {
  return extremeDateString(values, "max");
}
function extremeDateString(values: Array<string | null | undefined>, mode: "min" | "max"): string | null {
  const valid = values.flatMap((value) => {
    if (!value) return [];
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? [] : [{ value, timestamp }];
  });
  if (valid.length === 0) return null;
  valid.sort((left, right) => mode === "min" ? left.timestamp - right.timestamp : right.timestamp - left.timestamp);
  return valid[0]?.value ?? null;
}
function mergedStatus(values: Grant["status"][]): Grant["status"] {
  for (const status of ["open", "upcoming", "unknown", "closed"] as const) if (values.includes(status)) return status;
  return "unknown";
}
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function titleSimilarity(left: string, right: string): number {
  const leftNormalized = normalizeGrantDedupText(left);
  const rightNormalized = normalizeGrantDedupText(right);
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return 0.92;
  return tokenJaccard(leftNormalized, rightNormalized);
}

function textSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const leftNormalized = normalizeGrantDedupText(left ?? "");
  const rightNormalized = normalizeGrantDedupText(right ?? "");
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return 0.85;
  return tokenJaccard(leftNormalized, rightNormalized);
}

function scheduleSimilarity(left: GrantDedupComparable, right: GrantDedupComparable): number {
  const startsMatch = Boolean(left.apply_start && right.apply_start && left.apply_start === right.apply_start);
  const endsMatch = Boolean(left.apply_end && right.apply_end && left.apply_end === right.apply_end);
  if (startsMatch && endsMatch) return 1;
  if (startsMatch || endsMatch) return 0.65;
  if (dateRangesOverlap(left, right)) return 0.45;
  return 0;
}

function dateRangesOverlap(left: GrantDedupComparable, right: GrantDedupComparable): boolean {
  if (!left.apply_start || !left.apply_end || !right.apply_start || !right.apply_end) return false;
  const leftStart = Date.parse(left.apply_start);
  const leftEnd = Date.parse(left.apply_end);
  const rightStart = Date.parse(right.apply_start);
  const rightEnd = Date.parse(right.apply_end);
  if ([leftStart, leftEnd, rightStart, rightEnd].some(Number.isNaN)) return false;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function scheduleConflict(left: GrantDedupComparable, right: GrantDedupComparable): boolean {
  if (!left.apply_start || !left.apply_end || !right.apply_start || !right.apply_end) return false;
  const values = [left.apply_start, left.apply_end, right.apply_start, right.apply_end].map(Date.parse);
  if (values.some(Number.isNaN)) return false;
  return !dateRangesOverlap(left, right);
}

function yearTokens(value: string): Set<string> {
  return new Set([...value.matchAll(/(?:19|20)\d{2}/g)].map((match) => match[0]));
}

function roundTokens(value: string): Set<string> {
  const normalized = normalizeGrantDedupText(value);
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/(?:제\s*)?(\d+)\s*차/g)) if (match[1]) tokens.add(`${match[1]}차`);
  for (const token of ["상반기", "하반기", "1분기", "2분기", "3분기", "4분기"]) {
    if (normalized.includes(token)) tokens.add(token);
  }
  return tokens;
}

function setsConflict(left: Set<string>, right: Set<string>): boolean {
  return left.size > 0 && right.size > 0 && ![...left].some((value) => right.has(value));
}

function canonicalUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return null;
  }
}

function relationForConflict(signals: GrantDedupSignals): GrantRelation {
  if (signals.yearConflict) return "reannouncement";
  if (signals.roundConflict) return "reannouncement";
  if (signals.scheduleConflict) return "extension";
  return "related_program";
}

function decisionRank(decision: GrantDedupDecision): number {
  if (decision === "auto_duplicate") return 0;
  if (decision === "review") return 1;
  return 2;
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token)),
  );
}

export function normalizeGrantDedupText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&[a-z]+;/g, " ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function maxSimilarity(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
