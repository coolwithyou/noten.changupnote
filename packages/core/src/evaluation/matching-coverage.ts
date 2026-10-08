import { createHash } from "node:crypto";
import type { CompanyProfile, Eligibility, NormalizedGrant } from "@cunote/contracts";
import { matchNormalizedGrant } from "../matching/match.js";

export interface CoverageCompany { id: string; profile: CompanyProfile; synthetic: true }
export interface CoveragePrediction {
  pairId: string;
  grantId: string;
  companyId: string;
  inputSha256: string;
  eligibility: Eligibility;
  tier: string;
  candidate: boolean;
  unknownReasons: string[];
}
export interface CoverageReview {
  pairId: string;
  inputSha256: string;
  expected: Eligibility | "undetermined";
  sourceEvidence: string;
  reviewer: string;
}
export const coverageSha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Sample every source/work stratum without looking at predictions or company labels.
 * This is a diagnostic sample, not a prevalence-weighted population estimate. */
export function selectCoverageSample<T extends { id: string; source: string; nextWork: string }>(
  rows: readonly T[], count: number, seed: string,
): T[] {
  if (!Number.isInteger(count) || count < 1 || count > rows.length) throw new Error("invalid coverage sample size");
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error("duplicate coverage grant");
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.source}:${row.nextWork}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, group] of sorted) group.sort((a, b) =>
    createHash("sha256").update(`${seed}:${a.id}`).digest("hex")
      .localeCompare(createHash("sha256").update(`${seed}:${b.id}`).digest("hex")));
  const sample: T[] = [];
  while (sample.length < count) for (const [, group] of sorted) {
    if (group.length && sample.length < count) sample.push(group.shift()!);
  }
  return sample;
}

export function buildCoveragePredictions(input: {
  grants: readonly NormalizedGrant[];
  companies: readonly CoverageCompany[];
  asOf: Date;
  sourceSha256ByGrantId: Readonly<Record<string, string>>;
}): CoveragePrediction[] {
  if (!Number.isFinite(input.asOf.getTime())) throw new Error("invalid coverage date");
  if (new Set(input.grants.map(g => g.grant.id)).size !== input.grants.length
      || new Set(input.companies.map(c => c.id)).size !== input.companies.length) throw new Error("duplicate coverage input");
  return input.grants.flatMap(grant => input.companies.map(company => {
    if (!grant.grant.id) throw new Error("coverage grant ID missing");
    const sourceSha256 = input.sourceSha256ByGrantId[grant.grant.id];
    if (!sourceSha256 || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("coverage source SHA missing");
    const result = matchNormalizedGrant(grant, company.profile, { asOf: input.asOf });
    const tier = result.review_gate?.tier ?? "needs_core_review";
    return {
      pairId: `${grant.grant.id}::${company.id}`, grantId: grant.grant.id, companyId: company.id,
      inputSha256: coverageSha({ grantId: grant.grant.id, sourceSha256, profile: company.profile, asOf: input.asOf.toISOString() }),
      eligibility: result.eligibility, tier,
      candidate: result.eligibility !== "ineligible" && ["recommendable", "needs_profile_input"].includes(tier),
      unknownReasons: [...new Set(result.rule_trace.filter(t => t.result === "unknown").map(t => t.unresolved_reason ?? "unspecified"))],
    };
  }));
}

/** Predictions never become answer labels. Missing independent review means
 * unmeasured, including when every unreviewed prediction is conditional. */
export function evaluateCoverage(predictions: readonly CoveragePrediction[], reviews: readonly CoverageReview[]) {
  const byPair = new Map(predictions.map(p => [p.pairId, p]));
  if (byPair.size !== predictions.length || new Set(reviews.map(r => r.pairId)).size !== reviews.length)
    throw new Error("duplicate coverage pair or review");
  const evaluated = reviews.map(review => {
    const prediction = byPair.get(review.pairId);
    if (!prediction || prediction.inputSha256 !== review.inputSha256) throw new Error("coverage review binding mismatch");
    if (!review.reviewer.trim() || !review.sourceEvidence.trim()
        || !["eligible", "conditional", "ineligible", "undetermined"].includes(review.expected)) throw new Error("incomplete coverage review");
    return { prediction, review };
  });
  const positives = evaluated.filter(e => ["eligible", "conditional"].includes(e.review.expected));
  const certain = evaluated.filter(e => e.review.expected !== "undetermined" && e.prediction.eligibility === "eligible");
  const metric = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
  return {
    status: evaluated.length ? "reviewed_sample_only" : "unmeasured",
    pairs: predictions.length, reviewedPairs: evaluated.length,
    unreviewedPairs: predictions.length - evaluated.length,
    candidateCount: predictions.filter(p => p.candidate).length,
    candidateRecall: metric(positives.filter(e => e.prediction.candidate).length, positives.length),
    eligiblePrecision: metric(certain.filter(e => e.review.expected === "eligible").length, certain.length),
    missedPairs: positives.filter(e => !e.prediction.candidate).map(e => e.prediction.pairId),
    falseEligiblePairs: evaluated.filter(e => e.review.expected === "ineligible" && e.prediction.eligibility === "eligible").map(e => e.prediction.pairId),
  };
}

/** Minimal early-company fixtures; unknown certifications, finances and capabilities
 * stay absent. These identities must never be written into customer records. */
export function coverageCompanies(): CoverageCompany[] {
  return [
    ["software", "응용 소프트웨어 개발 및 공급업", "11", "서울"],
    ["food", "식료품 제조업", "41", "경기"],
    ["garment", "의류제조", "43", "충북"],
    ["chemical", "화학 물질 및 화학제품 제조업; 의약품 제외", "30", "대전"],
    ["retail", "소매업", "28", "인천"],
    ["warehouse", "창고업", "26", "부산"],
    ["restaurant", "음식점 및 주점업", "42", "강원"],
    ["furniture", "가구제조업", "41", "경기"],
    ["media", "영상·오디오 기록물 제작 및 배급업", "26", "부산"],
    ["research", "연구개발업", "27", "대구"],
  ].map(([id, label, code, region]) => ({
    id: `synthetic:early-${id}`, synthetic: true,
    profile: {
      industries: [label!], region: { code: code!, label: region! }, biz_age_months: 24,
      founder_age: 35, is_preliminary: false, target_types: ["개인사업자"],
      confidence: { industry: 1, region: 1, biz_age: 1, founder_age: 1, target_type: 1 },
      list_completeness: { industry: "partial", target_type: "partial" },
    },
  }));
}
