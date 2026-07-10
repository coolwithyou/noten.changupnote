/**
 * 크레딧 요율(pricing) 단위 테스트 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/credits/pricing.test.ts
 *
 * 커버(설계 16.1):
 *   - 요율 계산 ceil 정확성, 밀리크레딧 경계값
 *   - 룰 resolver 우선순위(6.3), 유효기간 필터, 룰 부재 시 예외
 *   - feature_flat / feature_free
 */
import assert from "node:assert/strict";
import {
  creditsFor,
  millicreditsPer1kFromUsd,
  resolvePricingRule,
  type PricingRule,
} from "./pricing.js";
import { PricingRuleMissingError } from "./errors.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const now = new Date("2026-07-09T00:00:00.000Z");

function tokenRule(over: Partial<PricingRule> = {}): PricingRule {
  return {
    id: "rule-default",
    ruleType: "model_token",
    featureCode: null,
    model: null,
    inputMillicreditsPer1k: 8400,
    outputMillicreditsPer1k: 42000,
    cacheReadMillicreditsPer1k: 840,
    cacheWriteMillicreditsPer1k: 10500,
    flatCredits: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveUntil: null,
    ...over,
  };
}

check("설계 5.5 예시: input 20k + output 8k ≈ 504 크레딧", () => {
  const rule = tokenRule({ inputMillicreditsPer1k: 8400, outputMillicreditsPer1k: 42000 });
  const credits = creditsFor(
    { inputTokens: 20000, outputTokens: 8000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    rule,
  );
  // 20000×8400 = 168,000,000 milli; 8000×42000 = 336,000,000 milli; 합 504,000,000 → /1e6 = 504
  assert.equal(credits, 504);
});

check("ceil: 1 밀리크레딧이라도 남으면 1 크레딧으로 올림", () => {
  // 1 토큰 × 1 milli/1k = 1 milli-per-1k → /1000/1000 = 0.000001 → ceil = 1
  const rule = tokenRule({
    inputMillicreditsPer1k: 1,
    outputMillicreditsPer1k: 0,
    cacheReadMillicreditsPer1k: 0,
    cacheWriteMillicreditsPer1k: 0,
  });
  const credits = creditsFor(
    { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    rule,
  );
  assert.equal(credits, 1);
});

check("경계값: 정확히 나누어떨어지면 올림 없음", () => {
  const rule = tokenRule({
    inputMillicreditsPer1k: 1000,
    outputMillicreditsPer1k: 0,
    cacheReadMillicreditsPer1k: 0,
    cacheWriteMillicreditsPer1k: 0,
  });
  // 1000 토큰 × 1000 milli/1k = 1,000,000 milli → /1e6 = 1 크레딧 (정확)
  const credits = creditsFor(
    { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    rule,
  );
  assert.equal(credits, 1);
});

check("사용량 0 이면 0 크레딧", () => {
  assert.equal(
    creditsFor({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, tokenRule()),
    0,
  );
});

check("캐시 토큰도 요율에 반영된다", () => {
  const rule = tokenRule({
    inputMillicreditsPer1k: 0,
    outputMillicreditsPer1k: 0,
    cacheReadMillicreditsPer1k: 1000,
    cacheWriteMillicreditsPer1k: 2000,
  });
  // cacheRead 1000×1000=1e6, cacheWrite 1000×2000=2e6 → 합 3e6 → 3 크레딧
  const credits = creditsFor(
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 1000 },
    rule,
  );
  assert.equal(credits, 3);
});

check("feature_flat 룰은 flatCredits 고정(토큰 무시)", () => {
  const rule = tokenRule({ ruleType: "feature_flat", featureCode: "some_feature", flatCredits: 25 });
  const credits = creditsFor(
    { inputTokens: 999999, outputTokens: 999999, cacheReadTokens: 0, cacheWriteTokens: 0 },
    rule,
  );
  assert.equal(credits, 25);
});

check("feature_free 룰은 항상 0", () => {
  const rule = tokenRule({ ruleType: "feature_free", featureCode: "popbill_lookup" });
  assert.equal(
    creditsFor({ inputTokens: 5000, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0 }, rule),
    0,
  );
});

// ── resolver 우선순위 (6.3) ────────────────────────────────────────────

check("우선순위 1: feature_free 가 최우선", () => {
  const rules: PricingRule[] = [
    tokenRule({ id: "token", model: "claude-x" }),
    tokenRule({ id: "flat", ruleType: "feature_flat", featureCode: "popbill_lookup", flatCredits: 5 }),
    tokenRule({ id: "free", ruleType: "feature_free", featureCode: "popbill_lookup" }),
  ];
  const rule = resolvePricingRule(rules, "popbill_lookup", "claude-x", now);
  assert.equal(rule.id, "free");
});

check("우선순위 2: feature_flat 이 model_token 보다 우선", () => {
  const rules: PricingRule[] = [
    tokenRule({ id: "token-exact", model: "claude-x" }),
    tokenRule({ id: "flat", ruleType: "feature_flat", featureCode: "guide", flatCredits: 3 }),
  ];
  const rule = resolvePricingRule(rules, "guide", "claude-x", now);
  assert.equal(rule.id, "flat");
});

check("우선순위 3: model 정확 일치가 기본값(null)보다 우선", () => {
  const rules: PricingRule[] = [
    tokenRule({ id: "default", model: null }),
    tokenRule({ id: "exact", model: "claude-x" }),
  ];
  const rule = resolvePricingRule(rules, "application_draft", "claude-x", now);
  assert.equal(rule.id, "exact");
});

check("우선순위 4: 정확 일치 없으면 기본값(model=null) 사용", () => {
  const rules: PricingRule[] = [tokenRule({ id: "default", model: null })];
  const rule = resolvePricingRule(rules, "application_draft", "claude-unknown", now);
  assert.equal(rule.id, "default");
});

check("룰이 하나도 없으면 PricingRuleMissingError (없으면 불가)", () => {
  assert.throws(
    () => resolvePricingRule([], "application_draft", "claude-x", now),
    (e: unknown) => e instanceof PricingRuleMissingError && e.code === "pricing_unavailable",
  );
});

check("유효기간 밖 룰은 무시된다", () => {
  const expired = tokenRule({
    id: "expired",
    model: "claude-x",
    effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
    effectiveUntil: new Date("2026-01-01T00:00:00.000Z"),
  });
  const current = tokenRule({
    id: "current",
    model: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveUntil: null,
  });
  const rule = resolvePricingRule([expired, current], "application_draft", "claude-x", now);
  // 만료된 exact 룰은 제외 → 기본값으로 폴백
  assert.equal(rule.id, "current");
});

check("effectiveUntil 경계: until 시각 자체는 이미 만료(< at)", () => {
  const rule = tokenRule({
    id: "boundary",
    model: "claude-x",
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveUntil: now, // until === at → 만료 취급
  });
  assert.throws(() => resolvePricingRule([rule], "f", "claude-x", now), PricingRuleMissingError);
});

// ── ops 요율 산정 계산기 (5.5) ─────────────────────────────────────────

check("millicreditsPer1kFromUsd: output $15/1M, fx 1400, margin 1.0 → 42,000", () => {
  const v = millicreditsPer1kFromUsd({ usdPer1MTokens: 15, fxKrwPerUsd: 1400, margin: 1.0, krwPerCredit: 1 });
  assert.equal(v, 42000);
});

check("millicreditsPer1kFromUsd: input $3/1M → 8,400", () => {
  const v = millicreditsPer1kFromUsd({ usdPer1MTokens: 3, fxKrwPerUsd: 1400, margin: 1.0, krwPerCredit: 1 });
  assert.equal(v, 8400);
});

console.log(JSON.stringify({ ok: true, suite: "credits/pricing", passed }, null, 2));
