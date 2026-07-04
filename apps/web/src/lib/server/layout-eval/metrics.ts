/**
 * Gate 2 메트릭 — 후보 vs 골든 필드 매칭으로 coverage / manual recall / 비용 산출.
 *
 * 단일 원천: 마스터 §17 Gate 2 (필드 coverage 80%, 서명/동의/직인 manual recall 99%), §8.6.
 * 위임 스펙 §7: 매칭 = IoU≥0.5 (같은 페이지) ∨ 정규화 label 유사도. text_parser(kordoc)는 label 만.
 *
 * 통과 판정·임계값 캘리브레이션은 이 세션 범위가 아니다(리뷰팀 golden 축적 후).
 * 여기서는 수치 계산만 하고 eval_runs.metrics(Record<string,number>) 로 기록 가능한 형태로 반환한다.
 */
import type { BBox, NormalizedFieldCandidate } from "./types";

export const IOU_THRESHOLD = 0.5;
export const LABEL_SIM_THRESHOLD = 0.6;

/** 골든 필드(라벨 JSON fields[] 요소)에서 매칭에 필요한 부분만 추출한 형태. */
export interface GoldenField {
  label: string;
  type: string;
  page: number | null;
  bbox: BBox | null;
  manual: boolean;
}

/** 라벨 JSON(golden gold) → GoldenField[]. bbox 는 [x,y,w,h] 0~1, page 1-기준. */
export function extractGoldenFields(gold: unknown): GoldenField[] {
  const rec = gold as Record<string, unknown> | null;
  const fields = rec && Array.isArray(rec["fields"]) ? (rec["fields"] as unknown[]) : [];
  const out: GoldenField[] = [];
  for (const f of fields) {
    if (typeof f !== "object" || f === null) continue;
    const rf = f as Record<string, unknown>;
    const bboxArr = Array.isArray(rf["bbox"]) ? (rf["bbox"] as unknown[]) : null;
    let bbox: BBox | null = null;
    if (bboxArr && bboxArr.length >= 4) {
      const nums = bboxArr.slice(0, 4).map((n) => (typeof n === "number" && Number.isFinite(n) ? n : NaN));
      if (nums.every((n) => !Number.isNaN(n))) {
        bbox = [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number];
      }
    }
    out.push({
      label: typeof rf["label"] === "string" ? rf["label"] : "",
      type: typeof rf["type"] === "string" ? rf["type"] : "",
      page: typeof rf["page"] === "number" ? rf["page"] : null,
      bbox,
      manual: rf["manual"] === true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 라벨 유사도 (문자 bigram Dice)
// ---------------------------------------------------------------------------

/** NFKC + 소문자 + 공백/구두점 제거 (한글/영숫자만 남김). */
export function normalizeLabelText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 문자 bigram Dice 계수 (0~1). 길이<2 인 짧은 문자열은 완전일치만 1. */
export function diceBigram(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, c] of A) {
    total += c;
    inter += Math.min(c, B.get(g) ?? 0);
  }
  for (const [, c] of B) total += c;
  return total === 0 ? 0 : (2 * inter) / total;
}

/** 정규화 label 유사도. */
export function labelSimilarity(a: string, b: string): number {
  return diceBigram(normalizeLabelText(a), normalizeLabelText(b));
}

// ---------------------------------------------------------------------------
// 기하: IoU
// ---------------------------------------------------------------------------

/** 두 [x,y,w,h] 의 IoU. */
export function iou(a: BBox, b: BBox): number {
  const ix = Math.max(a[0], b[0]);
  const iy = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const iy2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const iw = Math.max(0, ix2 - ix);
  const ih = Math.max(0, iy2 - iy);
  const inter = iw * ih;
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni <= 0 ? 0 : inter / uni;
}

/**
 * 후보가 골든 필드를 커버하는가.
 *   - bbox 경로: 둘 다 bbox + 같은 페이지 + IoU≥0.5
 *   - label 경로: 정규화 label 유사도 ≥ 0.6 (text_parser 는 이 경로만 가능)
 */
export function candidateCoversField(cand: NormalizedFieldCandidate, field: GoldenField): boolean {
  if (
    cand.bbox &&
    field.bbox &&
    cand.page !== null &&
    field.page !== null &&
    cand.page === field.page &&
    iou(cand.bbox, field.bbox) >= IOU_THRESHOLD
  ) {
    return true;
  }
  const candText = cand.label || cand.text;
  if (candText && field.label && labelSimilarity(candText, field.label) >= LABEL_SIM_THRESHOLD) {
    return true;
  }
  return false;
}

/** 골든 필드가 후보들 중 하나 이상에 커버되는가. */
export function fieldIsCovered(field: GoldenField, candidates: readonly NormalizedFieldCandidate[]): boolean {
  return candidates.some((c) => candidateCoversField(c, field));
}

// ---------------------------------------------------------------------------
// 집계
// ---------------------------------------------------------------------------

export interface MatchTally {
  goldenFields: number;
  matchedFields: number;
  manualGoldenFields: number;
  manualMatched: number;
}

/**
 * 한 문서의 골든 필드 대비 후보 커버리지 집계.
 * manual 대상 = manual===true ∨ type==="signature" (서명/동의/직인 계열; 마스터 §8.6).
 */
export function tallyDoc(golden: readonly GoldenField[], candidates: readonly NormalizedFieldCandidate[]): MatchTally {
  let matched = 0;
  let manualTotal = 0;
  let manualMatched = 0;
  for (const field of golden) {
    const covered = fieldIsCovered(field, candidates);
    if (covered) matched += 1;
    const isManualTarget = field.manual || field.type === "signature";
    if (isManualTarget) {
      manualTotal += 1;
      if (covered) manualMatched += 1;
    }
  }
  return {
    goldenFields: golden.length,
    matchedFields: matched,
    manualGoldenFields: manualTotal,
    manualMatched,
  };
}

/** 누적 tally 합산. */
export function addTally(a: MatchTally, b: MatchTally): MatchTally {
  return {
    goldenFields: a.goldenFields + b.goldenFields,
    matchedFields: a.matchedFields + b.matchedFields,
    manualGoldenFields: a.manualGoldenFields + b.manualGoldenFields,
    manualMatched: a.manualMatched + b.manualMatched,
  };
}

export const EMPTY_TALLY: MatchTally = {
  goldenFields: 0,
  matchedFields: 0,
  manualGoldenFields: 0,
  manualMatched: 0,
};

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export interface RunCounters {
  candidatesTotal: number;
  pagesProcessed: number;
  apiCallUnits: number;
  cacheHitUnits: number;
  docsProcessed: number;
  costPerPageUsd: number;
  estimatedCostUsd: number;
}

/**
 * eval_runs.metrics(Record<string,number>) 로 기록 가능한 최종 수치 묶음.
 * coverage/recall 은 골든 0 이면 -1(계산 불가 표식)으로 둔다(러너가 "메트릭 생략" 처리).
 */
export function buildMetrics(tally: MatchTally, counters: RunCounters): Record<string, number> {
  const fieldCoverage = tally.goldenFields > 0 ? round(tally.matchedFields / tally.goldenFields) : -1;
  const manualRecall = tally.manualGoldenFields > 0 ? round(tally.manualMatched / tally.manualGoldenFields) : -1;
  return {
    goldenFields: tally.goldenFields,
    matchedFields: tally.matchedFields,
    fieldCoverage,
    manualGoldenFields: tally.manualGoldenFields,
    manualMatched: tally.manualMatched,
    manualRecall,
    candidatesTotal: counters.candidatesTotal,
    pagesProcessed: counters.pagesProcessed,
    apiCallUnits: counters.apiCallUnits,
    cacheHitUnits: counters.cacheHitUnits,
    docsProcessed: counters.docsProcessed,
    costPerPageUsd: counters.costPerPageUsd,
    estimatedCostUsd: round(counters.estimatedCostUsd, 4),
  };
}
