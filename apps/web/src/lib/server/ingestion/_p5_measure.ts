// P5 백필·재계산 — before/after 층화 측정 도구(읽기 전용).
//
// 목적: 차원 확장(14→22) 재정규화가 매칭 티어 분포에 미치는 영향을 M7 층화로 측정한다.
//   - 공고군 (a): other text_only placeholder 보유(재정규화로 신규 결격 criteria가 생길 후보)
//   - 공고군 (b): 결격/배제 신호가 전무(오늘 recommendable일 수 있는 군) — 하락 폭이 M7 판단 대상
//
// 실제 매칭 엔진(matchGrantCriteria)으로 고정 대표 프로필 2종을 활성 공고 전량에 돌려
// review_gate.tier 분포를 낸다. before/after 동일 스크립트로 실행해 직접 비교한다.
//   - Profile CLEAN_KNOWN: 결격 3축 clean + 전 flag known → 신규 결격 criteria는 pass
//   - Profile NO_DISQ:     결격 지식 전무(known_flags 없음) → 신규 결격 criteria는 unknown (M7 worst case)
//
// 사용: npx tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/ingestion/_p5_measure.ts [--label=before]
import { inArray, sql } from "drizzle-orm";
import type { CompanyProfile, CriterionDimension, GrantCriterion } from "@cunote/contracts";
import {
  ALL_DISQUALIFICATION_FLAGS,
  DISQUALIFICATION_FLAGS,
  matchGrantCriteria,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import * as schema from "../db/schema";

loadMonorepoEnv();

const label = readArg("label") ?? "snapshot";
const asOf = new Date();

// 대표 프로필: 전형적인 초기 스타트업(수도권 제조·SW, 창업 2년, 대표 35세, 소기업).
// 결격/재무/고용/투자 축은 프로필별로 달리 채운다.
function baseProfile(): CompanyProfile {
  return {
    name: "대표프로필",
    region: { code: "11", label: "서울" },
    biz_age_months: 24,
    founder_age: 35,
    is_preliminary: false,
    industries: ["소프트웨어 개발업"],
    industry_codes: ["62010", "62", "J"],
    size: "small",
    revenue_krw: 300_000_000,
    employees_count: 5,
    traits: [],
    certs: [],
    prior_awards: [],
    ip: [],
    target_types: [],
    confidence: {
      region: 0.9,
      biz_age: 0.9,
      founder_age: 0.9,
      industry: 0.8,
      size: 0.8,
      revenue: 0.7,
      employees: 0.7,
    },
  };
}

/** 결격 3축 clean + 전 flag known + 재무/고용/투자 정상값 → 신규 결격 criteria는 pass. */
function cleanKnownProfile(): CompanyProfile {
  const p = baseProfile();
  const knownByAxis = (axis: "tax_compliance" | "credit_status" | "sanction") => ({
    flags: [] as string[],
    known_flags: [...DISQUALIFICATION_FLAGS[axis]] as string[],
    exceptions: [] as string[],
  });
  p.tax_compliance = knownByAxis("tax_compliance");
  p.credit_status = knownByAxis("credit_status");
  p.sanction = knownByAxis("sanction");
  p.financial_health = {
    debt_ratio_pct: 120,
    impairment: "none",
    total_assets_krw: 500_000_000,
    equity_krw: 200_000_000,
    capital_krw: 100_000_000,
  };
  p.insured_workforce = {
    employment_insurance_active: true,
    insured_count: 5,
    months_since_last_layoff: null,
    no_layoff: true,
  };
  p.investment = { total_raised_krw: 500_000_000, last_round: "seed", tips_backed: true };
  p.confidence = {
    ...p.confidence,
    tax_compliance: 0.6,
    credit_status: 0.6,
    sanction: 0.6,
    financial_health: 0.6,
    insured_workforce: 0.6,
    investment: 0.6,
  };
  return p;
}

/** 결격/재무/고용/투자 지식 전무(무응답) → 신규 결격 criteria는 unknown. M7 worst case. */
function noDisqProfile(): CompanyProfile {
  return baseProfile();
}

interface GrantBucket {
  grantId: string;
  source: string;
  criteria: GrantCriterion[];
  hasOtherTextonly: boolean;   // 공고군 (a) 후보
  hasDisqSignal: boolean;      // 결격/배제 신호 보유(신규 결격 criteria 또는 기존 exclusion)
}

function tierOf(criteria: GrantCriterion[], profile: CompanyProfile): string {
  return matchGrantCriteria(criteria, profile).review_gate?.tier ?? "unknown";
}

async function main() {
  const db = getCunoteDb();
  try {
    // 활성 공고 id (open/upcoming/unknown + apply_end 미도래). listActiveGrants 와 동일 조건.
    const cutoff = new Date(asOf);
    cutoff.setDate(cutoff.getDate() - 1);
    const cutoffIso = cutoff.toISOString();
    const idRows = (await db.execute(sql`
      select id, source from grants
      where status in ('open','upcoming','unknown')
        and (apply_end is null or apply_end >= ${cutoffIso}::timestamptz)
    `)) as unknown as Array<{ id: string; source: string }>;
    const grantIds = idRows.map((r) => r.id);
    if (grantIds.length === 0) {
      console.log(JSON.stringify({ label, error: "no active grants" }));
      return;
    }

    // criteria 로드(청크)
    const critByGrant = new Map<string, GrantCriterion[]>();
    for (let i = 0; i < grantIds.length; i += 500) {
      const chunk = grantIds.slice(i, i + 500);
      const rows = await db
        .select()
        .from(schema.grantCriteria)
        .where(inArray(schema.grantCriteria.grantId, chunk));
      for (const row of rows) {
        const list = critByGrant.get(row.grantId) ?? [];
        list.push(rowToCriterion(row));
        critByGrant.set(row.grantId, list);
      }
    }

    const disqDims = new Set<CriterionDimension>([
      "tax_compliance", "credit_status", "sanction",
      "financial_health", "insured_workforce", "investment",
    ]);

    const buckets: GrantBucket[] = idRows.map((r) => {
      const criteria = critByGrant.get(r.id) ?? [];
      const hasOtherTextonly = criteria.some((c) => c.dimension === "other" && c.operator === "text_only");
      const hasDisqSignal = criteria.some((c) =>
        disqDims.has(c.dimension) ||
        c.kind === "exclusion" ||
        (c.dimension === "industry" && c.operator === "not_in") ||
        (c.dimension === "business_status" && c.operator === "not_in"),
      );
      return { grantId: r.id, source: r.source, criteria, hasOtherTextonly, hasDisqSignal };
    });

    const profiles = { clean_known: cleanKnownProfile(), no_disq: noDisqProfile() };
    const report = summarize(label, buckets, profiles);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await closeCunoteDb();
  }
}

function summarize(
  label: string,
  buckets: GrantBucket[],
  profiles: { clean_known: CompanyProfile; no_disq: CompanyProfile },
) {
  // 층화: (a) other text_only 보유 vs (b) 결격/배제 신호 전무.
  const popA = buckets.filter((b) => b.hasOtherTextonly);
  const popB = buckets.filter((b) => !b.hasDisqSignal && !b.hasOtherTextonly);
  const emptyTier = () => ({ recommendable: 0, needs_profile_input: 0, needs_core_review: 0, not_recommended: 0 } as Record<string, number>);

  const tierDist = (set: GrantBucket[], profile: CompanyProfile) => {
    const d = emptyTier();
    for (const b of set) {
      const t = tierOf(b.criteria, profile);
      d[t] = (d[t] ?? 0) + 1;
    }
    return d;
  };

  const bySource = (pred: (b: GrantBucket) => boolean) => {
    const k = buckets.filter((b) => b.source === "kstartup" && pred(b)).length;
    const bz = buckets.filter((b) => b.source === "bizinfo" && pred(b)).length;
    return { kstartup: k, bizinfo: bz, total: k + bz };
  };

  const disqCritByDim: Record<string, number> = {};
  const disqDims = ["tax_compliance", "credit_status", "sanction", "financial_health", "insured_workforce", "investment"];
  let industryNotIn = 0;
  let businessStatusNotIn = 0;
  for (const b of buckets) {
    for (const c of b.criteria) {
      if (disqDims.includes(c.dimension)) disqCritByDim[c.dimension] = (disqCritByDim[c.dimension] ?? 0) + 1;
      if (c.dimension === "industry" && c.operator === "not_in") industryNotIn += 1;
      if (c.dimension === "business_status" && c.operator === "not_in") businessStatusNotIn += 1;
    }
  }

  return {
    label,
    asOf: asOf.toISOString(),
    active_universe: {
      total: buckets.length,
      by_source: bySource(() => true),
      pop_a_has_other_textonly: bySource((b) => b.hasOtherTextonly),
      pop_b_no_disq_signal: bySource((b) => !b.hasDisqSignal && !b.hasOtherTextonly),
      has_disq_signal: bySource((b) => b.hasDisqSignal),
    },
    // needs_core_review 비율은 프로필과 무관한 부분(구조화 안됨/코어 unknown)이 큰 축이나,
    // 신규 결격 criteria가 프로필별로 tier에 영향을 주므로 프로필별로 낸다.
    tier_distribution: {
      all_clean_known: tierDist(buckets, profiles.clean_known),
      all_no_disq: tierDist(buckets, profiles.no_disq),
      pop_a_clean_known: tierDist(popA, profiles.clean_known),
      pop_a_no_disq: tierDist(popA, profiles.no_disq),
      pop_b_clean_known: tierDist(popB, profiles.clean_known),
      pop_b_no_disq: tierDist(popB, profiles.no_disq),
    },
    needs_core_review_ratio: {
      // criteria_extracted=false 또는 core unknown 비율(프로필 무관 근사): clean_known 프로필 기준.
      all_clean_known: ratio(tierDist(buckets, profiles.clean_known).needs_core_review, buckets.length),
      pop_b_clean_known: ratio(tierDist(popB, profiles.clean_known).needs_core_review, popB.length),
    },
    disqualification_criteria_by_dimension: disqCritByDim,
    industry_not_in_count: industryNotIn,
    business_status_not_in_count: businessStatusNotIn,
  };
}

function ratio(n: number | undefined, d: number): string {
  if (d === 0) return "0.0%";
  return `${(((n ?? 0) / d) * 100).toFixed(1)}%`;
}

function rowToCriterion(row: typeof schema.grantCriteria.$inferSelect): GrantCriterion {
  return {
    id: row.id,
    grant_id: row.grantId,
    dimension: row.dimension as CriterionDimension,
    operator: row.operator,
    value: row.value as Record<string, unknown>,
    kind: row.kind,
    weight: row.weight ?? undefined,
    confidence: row.confidence,
    source_span: row.sourceSpan ?? undefined,
    raw_text: row.rawText ?? undefined,
    source_field: row.sourceField ?? undefined,
    needs_review: row.needsReview ?? undefined,
    parser_version: row.parserVersion ?? undefined,
  } as GrantCriterion;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

await main();
