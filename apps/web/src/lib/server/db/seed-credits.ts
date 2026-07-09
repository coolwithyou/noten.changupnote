/**
 * 크레딧 시스템 시드 (멱등 — 재실행 안전).
 *
 * 설계: docs/plans/2026-07-09-ai-credit-system.md
 *   - 4.7 credit_settings 초기 키 14개
 *   - 4.8 credit_products 5종
 *   - 4.9 credit_plans 3종
 *   - 5.5 초기 요율 (구현 시점 Anthropic 단가 기준)
 *
 * 실행: pnpm exec tsx apps/web/src/lib/server/db/seed-credits.ts
 * 멱등 전략: settings/products/plans 는 unique key(code)로 onConflictDoUpdate.
 *   요율은 "현행(effectiveUntil IS NULL) 룰이 이미 있으면 삽입 생략"으로 멱등.
 *   → 재실행해도 요율 버전이 중복 생성되지 않는다(4.6 "요율은 UPDATE 안 함, 버전만").
 */

import { and, eq, isNull } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const SYSTEM_ADMIN = "system:seed";

// ── 4.7 settings ──────────────────────────────────────────────────────
const SETTINGS: Array<{ key: string; value: Record<string, unknown> }> = [
  { key: "krw_per_credit", value: { value: 1 } },
  { key: "signup_bonus_credits", value: { value: 1000 } },
  { key: "signup_bonus_expiry_days", value: { value: 90 } },
  { key: "purchase_expiry_days", value: { value: 1825 } },
  { key: "hold_ttl_seconds", value: { value: 600 } },
  { key: "hold_buffer_ratio", value: { value: 1.2 } },
  { key: "low_balance_warn_credits", value: { value: 200 } },
  { key: "payment_order_ttl_minutes", value: { value: 90 } },
  { key: "plan_retry_schedule_days", value: { value: [1, 3] } },
  { key: "plan_grant_expiry_cycles", value: { value: 2, flexValue: 3 } },
  { key: "admin_grant_review_threshold", value: { value: 50000 } },
  { key: "support_grant_ticket_cap", value: { value: 1000 } },
  { key: "support_grant_daily_cap", value: { value: 2000 } },
  { key: "company_bonus_consumption_cap", value: { value: 3000 } },
];

// ── 4.8 products (5,000 / 10,000 / 30,000+3% / 50,000+5% / 100,000+8%) ──
const PRODUCTS = [
  { code: "topup_5k", name: "5,000 크레딧", amountKrw: 5000, credits: 5000, bonusCredits: 0, displayOrder: 1 },
  { code: "topup_10k", name: "10,000 크레딧", amountKrw: 10000, credits: 10000, bonusCredits: 0, displayOrder: 2 },
  { code: "topup_30k", name: "30,000 크레딧", amountKrw: 30000, credits: 30000, bonusCredits: 900, displayOrder: 3 },
  { code: "topup_50k", name: "50,000 크레딧", amountKrw: 50000, credits: 50000, bonusCredits: 2500, displayOrder: 4 },
  { code: "topup_100k", name: "100,000 크레딧", amountKrw: 100000, credits: 100000, bonusCredits: 8000, displayOrder: 5 },
];

// ── 4.9 plans (plus / pro / flex) ──────────────────────────────────────
const PLANS = [
  { code: "plus", name: "Plus", monthlyPriceKrw: 9900, monthlyCredits: 11000, displayOrder: 1 },
  { code: "pro", name: "Pro", monthlyPriceKrw: 29900, monthlyCredits: 35000, displayOrder: 2 },
  { code: "flex", name: "Flex", monthlyPriceKrw: 79900, monthlyCredits: 100000, displayOrder: 3 },
];

/**
 * 5.5 초기 요율 (구현 시점 Anthropic 단가 기준).
 * 산정: millicredits_per_1k = ceil( usd_per_1M/1000 × fx(1400) × (1+margin=1.0) / krw_per_credit(1) × 1000 )
 *   Opus 4.8: input $5/1M → 5/1000×1400×2×1000 = 14,000; output $25/1M → 70,000
 *   cache read ≈ input×0.1 → 1,400; cache write ≈ input×1.25 → 17,500 (동일 마진율)
 * 운영 배치 모델은 model=null 기본값 하나로 커버(원가 추적용 — P2 에서 무과금 모드로 미터링).
 * popbill_lookup·ops_batch_* 은 feature_free (무과금, 미터링만) — 6.5.
 */
const FX = 1400;
const MARGIN = 1.0; // 100%
const KRW_PER_CREDIT = 1;
function milli(usdPer1M: number): number {
  return Math.ceil((usdPer1M / 1000) * FX * (1 + MARGIN) / KRW_PER_CREDIT * 1000);
}
const PRICING_RULES: Array<{
  ruleType: string;
  featureCode: string | null;
  model: string | null;
  inputMillicreditsPer1k: number | null;
  outputMillicreditsPer1k: number | null;
  cacheReadMillicreditsPer1k: number | null;
  cacheWriteMillicreditsPer1k: number | null;
  flatCredits: number | null;
  note: string;
}> = [
  {
    // 전 모델 기본값 (model=null): Opus 4.8 단가 기준. 신규 모델은 정확 일치 룰을 추가한다.
    ruleType: "model_token", featureCode: null, model: null,
    inputMillicreditsPer1k: milli(5), outputMillicreditsPer1k: milli(25),
    cacheReadMillicreditsPer1k: Math.ceil(milli(5) * 0.1), cacheWriteMillicreditsPer1k: Math.ceil(milli(5) * 1.25),
    flatCredits: null,
    note: "기본 요율 (Opus 4.8 단가, fx 1400, margin 100%)",
  },
  {
    // 운영 배치 모델 예시 (bizinfo 추출 등). 현재는 무과금 미터링(P2)이므로 원가 추적용.
    ruleType: "model_token", featureCode: null, model: "claude-opus-4-8",
    inputMillicreditsPer1k: milli(5), outputMillicreditsPer1k: milli(25),
    cacheReadMillicreditsPer1k: Math.ceil(milli(5) * 0.1), cacheWriteMillicreditsPer1k: Math.ceil(milli(5) * 1.25),
    flatCredits: null,
    note: "claude-opus-4-8 정확 일치 요율",
  },
  {
    // 팝빌 조회: 무과금(미터링만) — 6.5.
    ruleType: "feature_free", featureCode: "popbill_lookup", model: null,
    inputMillicreditsPer1k: null, outputMillicreditsPer1k: null,
    cacheReadMillicreditsPer1k: null, cacheWriteMillicreditsPer1k: null, flatCredits: null,
    note: "팝빌 조회 무과금 (미터링만)",
  },
];

async function main() {
  const db = getCunoteDb();
  const now = new Date();
  const summary = { settings: 0, products: 0, plans: 0, pricingInserted: 0, pricingSkipped: 0 };

  // settings — key upsert
  for (const s of SETTINGS) {
    await db
      .insert(schema.creditSettings)
      .values({ key: s.key, value: s.value, updatedByAdminId: SYSTEM_ADMIN, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.creditSettings.key,
        set: { value: s.value, updatedByAdminId: SYSTEM_ADMIN, updatedAt: now },
      });
    summary.settings += 1;
  }

  // products — code upsert
  for (const p of PRODUCTS) {
    await db
      .insert(schema.creditProducts)
      .values({
        code: p.code, name: p.name, amountKrw: p.amountKrw, credits: p.credits,
        bonusCredits: p.bonusCredits, isActive: true, displayOrder: p.displayOrder,
        createdAt: now, updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.creditProducts.code,
        set: {
          name: p.name, amountKrw: p.amountKrw, credits: p.credits,
          bonusCredits: p.bonusCredits, displayOrder: p.displayOrder, updatedAt: now,
        },
      });
    summary.products += 1;
  }

  // plans — code upsert
  for (const pl of PLANS) {
    await db
      .insert(schema.creditPlans)
      .values({
        code: pl.code, name: pl.name, monthlyPriceKrw: pl.monthlyPriceKrw,
        monthlyCredits: pl.monthlyCredits, isActive: true, displayOrder: pl.displayOrder,
        createdAt: now, updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.creditPlans.code,
        set: {
          name: pl.name, monthlyPriceKrw: pl.monthlyPriceKrw,
          monthlyCredits: pl.monthlyCredits, displayOrder: pl.displayOrder, updatedAt: now,
        },
      });
    summary.plans += 1;
  }

  // pricing rules — 현행(effectiveUntil IS NULL) 룰이 있으면 삽입 생략 (멱등, 버전 중복 방지)
  for (const r of PRICING_RULES) {
    const conds = [
      eq(schema.creditPricingRules.ruleType, r.ruleType),
      isNull(schema.creditPricingRules.effectiveUntil),
    ];
    conds.push(
      r.featureCode === null
        ? isNull(schema.creditPricingRules.featureCode)
        : eq(schema.creditPricingRules.featureCode, r.featureCode),
    );
    conds.push(
      r.model === null
        ? isNull(schema.creditPricingRules.model)
        : eq(schema.creditPricingRules.model, r.model),
    );
    const [existing] = await db
      .select({ id: schema.creditPricingRules.id })
      .from(schema.creditPricingRules)
      .where(and(...conds))
      .limit(1);
    if (existing) {
      summary.pricingSkipped += 1;
      continue;
    }
    await db.insert(schema.creditPricingRules).values({
      ruleType: r.ruleType, featureCode: r.featureCode, model: r.model,
      inputMillicreditsPer1k: r.inputMillicreditsPer1k, outputMillicreditsPer1k: r.outputMillicreditsPer1k,
      cacheReadMillicreditsPer1k: r.cacheReadMillicreditsPer1k, cacheWriteMillicreditsPer1k: r.cacheWriteMillicreditsPer1k,
      flatCredits: r.flatCredits, effectiveFrom: now, effectiveUntil: null,
      createdByAdminId: SYSTEM_ADMIN, note: r.note, createdAt: now,
    });
    summary.pricingInserted += 1;
  }

  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
}

main()
  .then(() => closeCunoteDb())
  .catch(async (error) => {
    console.error("seed-credits failed:", error);
    await closeCunoteDb();
    process.exitCode = 1;
  });
