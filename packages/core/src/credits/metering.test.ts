/**
 * withCreditMetering 단위 테스트 (node:assert, tsx 실행). DB 미의존 — 포트를 페이크로 대체.
 *
 * 실행: pnpm exec tsx packages/core/src/credits/metering.test.ts
 *
 * 커버(설계 6.2 / 6.3 / 13.1):
 *   - feature_free 경로: hold 없이 무과금 기록
 *   - ops 배치(userId=null): recordOpsUsageEvent 로만 기록
 *   - 과금 경로: hold → run(report) → 선기록 → capture, creditsCharged 반영
 *   - 요율 미정의: PricingRuleMissingError 로 호출 거부(run 미실행)
 *   - maxTokens 가 estimate.maxOutputTokens 와 결속(레드팀 M8)
 *   - 13.1 excludeBonusLots 신호가 상한 초과 시 acquire/capture 로 전달
 */
import assert from "node:assert/strict";
import { withCreditMetering } from "./metering.js";
import { PricingRuleMissingError } from "./errors.js";
import type { CreditRepository, CreditSystemRepository, CaptureHoldResult, CreditHoldRecord, CreditWalletRecord } from "./ports.js";
import type { PricingRule, TokenUsage } from "./pricing.js";

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const now = () => new Date("2026-07-10T00:00:00.000Z");

function tokenRule(overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    id: "rule-token",
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
    ...overrides,
  };
}

function freeRule(featureCode: string): PricingRule {
  return { ...tokenRule({ id: "rule-free", ruleType: "feature_free", featureCode }), inputMillicreditsPer1k: null };
}

interface Calls {
  acquire: unknown[];
  capture: unknown[];
  release: unknown[];
  ops: unknown[];
  pending: unknown[];
  tokens: unknown[];
  failed: unknown[];
}

function makeFakes(opts: {
  rules: PricingRule[];
  bonusConsumed?: number;
  cap?: number;
  captureCharged?: number;
}): { deps: { credits: CreditRepository; creditsSystem: CreditSystemRepository }; calls: Calls } {
  const calls: Calls = { acquire: [], capture: [], release: [], ops: [], pending: [], tokens: [], failed: [] };
  const wallet: CreditWalletRecord = {
    id: "wallet-1", userId: "u1", balanceCredits: 1000, status: "active",
    frozenReason: null, createdAt: now(), updatedAt: now(),
  };
  const credits: CreditRepository = {
    async ensureWalletWithSignupBonus() { return wallet; },
    async getWalletForUser() { return wallet; },
    async listActiveLotsForUser() { return []; },
    async applyLedgerEntry() { throw new Error("unused"); },
    async acquireHold(_userId, input) {
      calls.acquire.push(input);
      const hold: CreditHoldRecord = {
        id: "hold-1", walletId: input.walletId, usageEventId: input.usageEventId,
        heldCredits: Math.ceil(input.estimatedCredits * 1.2), capturedCredits: null,
        status: "pending", expiresAt: new Date(now().getTime() + 600_000),
        releasedReason: input.excludeBonusLots ? "exclude_bonus" : null, createdAt: now(),
      };
      return hold;
    },
    async captureHold(_userId, input): Promise<CaptureHoldResult> {
      calls.capture.push(input);
      const charged = opts.captureCharged ?? input.actualCredits;
      return {
        hold: {
          id: input.holdId, walletId: "wallet-1", usageEventId: "ue-1", heldCredits: 0,
          capturedCredits: charged, status: "captured", expiresAt: now(), releasedReason: null, createdAt: now(),
        },
        creditsCharged: charged,
        shortfall: Math.max(0, input.actualCredits - charged),
        capturedLate: false,
      };
    },
    async releaseHold(_userId, input) {
      calls.release.push(input);
      return { id: input.holdId, walletId: "wallet-1", usageEventId: "ue-1", heldCredits: 0, capturedCredits: null, status: "released", expiresAt: now(), releasedReason: input.reason, createdAt: now() };
    },
    async createPendingUsageEvent(_userId, input) { calls.pending.push(input); return { id: "ue-1" }; },
    async recordUsageTokens(_userId, input) { calls.tokens.push(input); },
    async markUsageEventFailed(_userId, input) { calls.failed.push(input); },
    async sumCompanyBonusConsumption() { return opts.bonusConsumed ?? 0; },
    async sumPendingHolds() { return 0; },
    async listLedgerForUser() { return { entries: [], nextCursor: null, hasMore: false }; },
    async listUsageForUser() { return { events: [], summary: { totalCredits: 0, byFeature: [] }, nextCursor: null, hasMore: false }; },
  };
  const creditsSystem: CreditSystemRepository = {
    async recordFreeUsageEvent() { return { id: "free-1" }; },
    async listEffectivePricingRules() { return opts.rules; },
    async readNumericSetting(key, fallback) {
      if (key === "company_bonus_consumption_cap") return opts.cap ?? 3000;
      return fallback;
    },
    async recordOpsUsageEvent(input) { calls.ops.push(input); return { id: "ops-1" }; },
  };
  return { deps: { credits, creditsSystem }, calls };
}

await check("feature_free: hold 없이 무과금 기록", async () => {
  const { deps, calls } = makeFakes({ rules: [freeRule("popbill_lookup")] });
  const { usageEvent } = await withCreditMetering(
    { ...deps, now },
    { userId: "u1", companyId: null, featureCode: "popbill_lookup", model: "n/a", estimate: { inputTokens: 0, maxOutputTokens: 100 }, requestId: "r1" },
    async ({ report }) => { report({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }); return "ok"; },
  );
  assert.equal(usageEvent.status, "free");
  assert.equal(usageEvent.creditsCharged, 0);
  assert.equal(calls.acquire.length, 0, "hold 없어야 함");
  assert.equal(calls.ops.length, 1, "ops 이벤트로 기록");
});

await check("ops 배치(userId=null): recordOpsUsageEvent 로만 기록", async () => {
  const { deps, calls } = makeFakes({ rules: [tokenRule()] });
  const { usageEvent } = await withCreditMetering(
    { ...deps, now },
    { userId: null, companyId: null, featureCode: "ops_batch_x", model: "claude-haiku-4-5", estimate: { inputTokens: 100, maxOutputTokens: 1800 }, requestId: "r1" },
    async ({ report, maxTokens }) => {
      assert.equal(maxTokens, 1800, "maxTokens 는 estimate.maxOutputTokens 와 결속");
      report({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return "done";
    },
  );
  assert.equal(usageEvent.status, "free");
  assert.equal(calls.acquire.length, 0);
  assert.equal(calls.ops.length, 1);
});

await check("과금 경로: hold → run → 선기록 → capture, creditsCharged 반영", async () => {
  const { deps, calls } = makeFakes({ rules: [tokenRule()], captureCharged: 504 });
  const { result, usageEvent } = await withCreditMetering(
    { ...deps, now },
    { userId: "u1", companyId: "c1", featureCode: "application_draft", model: "claude-sonnet-5", estimate: { inputTokens: 20000, maxOutputTokens: 8000 }, requestId: "r1" },
    async ({ report }) => {
      report({ inputTokens: 20000, outputTokens: 8000, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return "draft";
    },
  );
  assert.equal(result, "draft");
  assert.equal(usageEvent.status, "settled");
  assert.equal(usageEvent.creditsCharged, 504);
  assert.equal(calls.pending.length, 1, "pending usage 선생성");
  assert.equal(calls.acquire.length, 1, "hold 획득");
  assert.equal(calls.tokens.length, 1, "d-2 토큰 선기록");
  assert.equal(calls.capture.length, 1, "capture 정산");
  // 실제 요율 계산: input 20000×8400 + output 8000×42000 = 168M + 336M = 504M milli /1e6 = 504.
  const captureInput = calls.capture[0] as { actualCredits: number };
  assert.equal(captureInput.actualCredits, 504);
});

await check("run 실패: releaseHold + markUsageEventFailed 후 rethrow", async () => {
  const { deps, calls } = makeFakes({ rules: [tokenRule()] });
  await assert.rejects(
    () => withCreditMetering(
      { ...deps, now },
      { userId: "u1", companyId: null, featureCode: "application_draft", model: "claude-sonnet-5", estimate: { inputTokens: 100, maxOutputTokens: 100 }, requestId: "r1" },
      async () => { throw new Error("llm boom"); },
    ),
    /llm boom/,
  );
  assert.equal(calls.release.length, 1, "releaseHold 호출");
  assert.equal(calls.failed.length, 1, "usage failed 표기");
});

await check("요율 미정의: PricingRuleMissingError, run 미실행", async () => {
  const { deps, calls } = makeFakes({ rules: [] });
  let ran = false;
  await assert.rejects(
    () => withCreditMetering(
      { ...deps, now },
      { userId: "u1", companyId: null, featureCode: "unknown_feature", model: "unknown-model", estimate: { inputTokens: 1, maxOutputTokens: 1 }, requestId: "r1" },
      async () => { ran = true; return "x"; },
    ),
    PricingRuleMissingError,
  );
  assert.equal(ran, false, "요율 없으면 run 자체를 실행하지 않는다");
  assert.equal(calls.pending.length, 0);
});

await check("13.1 상한 초과: excludeBonusLots=true 가 acquire/capture 로 전달", async () => {
  const { deps, calls } = makeFakes({ rules: [tokenRule()], bonusConsumed: 5000, cap: 3000, captureCharged: 10 });
  await withCreditMetering(
    { ...deps, now },
    { userId: "u1", companyId: "c1", featureCode: "application_draft", model: "claude-sonnet-5", estimate: { inputTokens: 100, maxOutputTokens: 100 }, requestId: "r1" },
    async ({ report }) => { report({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }); return "x"; },
  );
  assert.equal((calls.acquire[0] as { excludeBonusLots?: boolean }).excludeBonusLots, true);
  assert.equal((calls.capture[0] as { excludeBonusLots?: boolean }).excludeBonusLots, true);
});

await check("13.1 상한 미달: excludeBonusLots=false", async () => {
  const { deps, calls } = makeFakes({ rules: [tokenRule()], bonusConsumed: 100, cap: 3000, captureCharged: 10 });
  await withCreditMetering(
    { ...deps, now },
    { userId: "u1", companyId: "c1", featureCode: "application_draft", model: "claude-sonnet-5", estimate: { inputTokens: 100, maxOutputTokens: 100 }, requestId: "r1" },
    async ({ report }) => { report({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }); return "x"; },
  );
  assert.equal((calls.acquire[0] as { excludeBonusLots?: boolean }).excludeBonusLots, false);
});

console.log(JSON.stringify({ ok: true, suite: "credits/metering", passed }, null, 2));
