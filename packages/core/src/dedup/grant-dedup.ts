import type { Grant, NormalizedGrant } from "@cunote/contracts";

export interface GrantDedupCandidate {
  canonicalGrantKey: string;
  memberGrantKey: string;
  score: number;
  reasons: string[];
}

export interface FindGrantDedupCandidatesOptions {
  minScore?: number;
  crossSourceOnly?: boolean;
}

interface ScoredGrantPair {
  score: number;
  reasons: string[];
}

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

      const pair = scoreGrantPair(left.grant, right.grant);
      if (pair.score < minScore) continue;
      const [canonical, member] = sortGrantPair(left.grant, right.grant);
      candidates.push({
        canonicalGrantKey: grantDedupKey(canonical),
        memberGrantKey: grantDedupKey(member),
        score: pair.score,
        reasons: pair.reasons,
      });
    }
  }

  return candidates.sort((left, right) =>
    right.score - left.score ||
    left.canonicalGrantKey.localeCompare(right.canonicalGrantKey) ||
    left.memberGrantKey.localeCompare(right.memberGrantKey)
  );
}

export function grantDedupKey(grant: Grant): string {
  return grant.id ?? `${grant.source}:${grant.source_id}`;
}

export function scoreGrantPair(left: Grant, right: Grant): ScoredGrantPair {
  const title = titleSimilarity(left.title, right.title);
  if (title < 0.55) return { score: title * 0.7, reasons: [`title:${round(title)}`] };

  const agency = maxSimilarity([
    textSimilarity(left.agency_jurisdiction, right.agency_jurisdiction),
    textSimilarity(left.agency_operator, right.agency_operator),
  ]);
  const schedule = scheduleSimilarity(left, right);
  const category = maxSimilarity([
    textSimilarity(left.category_l1, right.category_l1),
    textSimilarity(left.category_l2, right.category_l2),
  ]);

  const score = title * 0.7 + agency * 0.15 + schedule * 0.1 + category * 0.05;
  const reasons = [
    `title:${round(title)}`,
    `agency:${round(agency)}`,
    `schedule:${round(schedule)}`,
    `category:${round(category)}`,
  ];

  return { score: round(score), reasons };
}

function sortGrantPair(left: Grant, right: Grant): [Grant, Grant] {
  return grantDedupKey(left).localeCompare(grantDedupKey(right)) <= 0 ? [left, right] : [right, left];
}

function titleSimilarity(left: string, right: string): number {
  const leftNormalized = normalizeText(left);
  const rightNormalized = normalizeText(right);
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return 0.92;
  return tokenJaccard(leftNormalized, rightNormalized);
}

function textSimilarity(left: string | null | undefined, right: string | null | undefined): number {
  const leftNormalized = normalizeText(left ?? "");
  const rightNormalized = normalizeText(right ?? "");
  if (!leftNormalized || !rightNormalized) return 0;
  if (leftNormalized === rightNormalized) return 1;
  if (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return 0.85;
  return tokenJaccard(leftNormalized, rightNormalized);
}

function scheduleSimilarity(left: Grant, right: Grant): number {
  const startsMatch = Boolean(left.apply_start && right.apply_start && left.apply_start === right.apply_start);
  const endsMatch = Boolean(left.apply_end && right.apply_end && left.apply_end === right.apply_end);
  if (startsMatch && endsMatch) return 1;
  if (startsMatch || endsMatch) return 0.65;
  if (dateRangesOverlap(left, right)) return 0.45;
  return 0;
}

function dateRangesOverlap(left: Grant, right: Grant): boolean {
  if (!left.apply_start || !left.apply_end || !right.apply_start || !right.apply_end) return false;
  const leftStart = Date.parse(left.apply_start);
  const leftEnd = Date.parse(left.apply_end);
  const rightStart = Date.parse(right.apply_start);
  const rightEnd = Date.parse(right.apply_end);
  if ([leftStart, leftEnd, rightStart, rightEnd].some(Number.isNaN)) return false;
  return leftStart <= rightEnd && rightStart <= leftEnd;
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

function normalizeText(value: string): string {
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
