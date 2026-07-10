/**
 * 환불 계산 단위 테스트 (설계 16.1).
 *
 * 실행: tsx packages/core/src/credits/refund.test.ts
 *
 * 커버(16.1):
 *   - 청약철회(7일 내, 보너스 선소진 후 원금 보장)
 *   - 임의 환불(보너스 회수)
 *   - 환불 불가
 *   - 업그레이드 72h 내 합산 판정
 *   - admin_grant·promo·signup_bonus lot 배제
 */
import assert from "node:assert/strict";
import { calculateRefund, filterRefundableLots, refundKindOf, type RefundLotSnapshot } from "./refund.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("환불 계산 테스트 (7.4 / 16.1)");

// ── 구분 판정 ─────────────────────────────────────────────────────────────
check("refundKindOf: 7일 이내는 청약철회, 초과는 임의 환불", () => {
  assert.equal(refundKindOf(0), "withdrawal");
  assert.equal(refundKindOf(7), "withdrawal");
  assert.equal(refundKindOf(8), "discretionary");
  assert.equal(refundKindOf(30), "discretionary");
});

// ── lot 배제 ──────────────────────────────────────────────────────────────
check("admin_grant·promo·signup_bonus lot 배제(레드팀 M1-보안)", () => {
  const lots: RefundLotSnapshot[] = [
    { lotId: "p1", source: "purchase", initialCredits: 10000, remainingCredits: 10000, bonusCredits: 0 },
    { lotId: "a1", source: "admin_grant", initialCredits: 5000, remainingCredits: 5000, bonusCredits: 0 },
    { lotId: "b1", source: "signup_bonus", initialCredits: 1000, remainingCredits: 1000, bonusCredits: 0 },
    { lotId: "pr1", source: "promo", initialCredits: 2000, remainingCredits: 2000, bonusCredits: 0 },
    { lotId: "pg1", source: "plan_grant", initialCredits: 3000, remainingCredits: 3000, bonusCredits: 300 },
  ];
  const kept = filterRefundableLots(lots);
  assert.deepEqual(kept.map((l) => l.lotId).sort(), ["p1", "pg1"]);
});

// ── 청약철회: 미사용 전액 ──────────────────────────────────────────────────
check("청약철회 미사용: 전액 환불 + 잔여 전량 회수", () => {
  const r = calculateRefund({
    krwPerCredit: 1,
    amountKrw: 10000,
    daysSincePayment: 2,
    lots: [{ lotId: "p1", source: "purchase", initialCredits: 10000, remainingCredits: 10000, bonusCredits: 0 }],
  });
  assert.equal(r.refundable, true);
  assert.equal(r.kind, "withdrawal");
  assert.equal(r.refundKrw, 10000);
  assert.equal(r.recoverCredits, 10000);
  assert.deepEqual(r.targetLotIds, ["p1"]);
});

// ── 청약철회: 보너스만 소진 → 원금 보장 ────────────────────────────────────
check("청약철회 보너스만 소진: 원금 전액 보장(철회권 우선)", () => {
  // 50,000원 = 50,000cr + 2,500 보너스 = 52,500 지급. 보너스 2,500 만 소진(잔여 50,000).
  const r = calculateRefund({
    krwPerCredit: 1,
    amountKrw: 50000,
    daysSincePayment: 3,
    lots: [{ lotId: "p1", source: "purchase", initialCredits: 52500, remainingCredits: 50000, bonusCredits: 2500 }],
  });
  // 소진 2,500 ≤ 보너스 2,500 → 원금 소진 0 → 전액 환불.
  assert.equal(r.refundable, true);
  assert.equal(r.refundKrw, 50000);
  assert.equal(r.recoverCredits, 50000); // 잔여 전량 회수
});

// ── 청약철회: 원금 일부 소진 → 소진분만 차감 ────────────────────────────────
check("청약철회 원금 일부 소진: 원금 소진분만 원화 차감", () => {
  // 52,500 지급(보너스 2,500), 잔여 40,000 → 소진 12,500. 원금 소진 = 12,500 - 2,500 = 10,000.
  const r = calculateRefund({
    krwPerCredit: 1,
    amountKrw: 50000,
    daysSincePayment: 5,
    lots: [{ lotId: "p1", source: "purchase", initialCredits: 52500, remainingCredits: 40000, bonusCredits: 2500 }],
  });
  assert.equal(r.refundable, true);
  assert.equal(r.refundKrw, 50000 - 10000); // 40,000원
  assert.equal(r.recoverCredits, 40000); // 잔여 전량 회수
});

// ── 청약철회: 업그레이드 72h 합산 판정 ──────────────────────────────────────
check("청약철회 업그레이드 72h 합산: 이전 lot 소모분을 소진량에 합산", () => {
  // 신규 플랜 lot 은 미사용(잔여==초기)처럼 보이지만, 72h 내 이전 플랜에서 8,000 소모.
  const r = calculateRefund({
    krwPerCredit: 1,
    amountKrw: 30000,
    daysSincePayment: 1,
    priorUpgradeConsumedCredits: 8000,
    lots: [{ lotId: "pg1", source: "plan_grant", initialCredits: 30000, remainingCredits: 30000, bonusCredits: 3000 }],
  });
  // 소진 = (30000-30000) + 8000 = 8000. 원금 소진 = 8000 - 3000(보너스) = 5000.
  assert.equal(r.refundable, true);
  assert.equal(r.refundKrw, 30000 - 5000); // 25,000원 — 합산 없었으면 30,000 전액이 됐을 것
});

// ── 임의 환불: 보너스 회수 후 부분 환불 ────────────────────────────────────
check("임의 환불: 보너스 전액 회수 후 잔여 원금 환불", () => {
  // 52,500 지급(보너스 2,500), 잔여 40,000. 임의 환불 → 보너스 2,500 회수.
  // 환불 대상 = 40,000 - 2,500 = 37,500. 회수 크레딧 = 잔여 40,000 전체.
  const r = calculateRefund({
    krwPerCredit: 1,
    amountKrw: 50000,
    daysSincePayment: 30,
    lots: [{ lotId: "p1", source: "purchase", initialCredits: 52500, remainingCredits: 40000, bonusCredits: 2500 }],
  });
  assert.equal(r.refundable, true);
  assert.equal(r.kind, "discretionary");
  assert.equal(r.refundKrw, 37500);
  assert.equal(r.recoverCredits, 40000);
});

// ── 임의 환불: 보너스 회수로 잔액 부족 → 환불 불가 ──────────────────────────
check("임의 환불 잔액 부족: 보너스 회수 필요 > 잔여 → 환불 불가", () => {
  // 보너스 2,500 인데 잔여 2,000(원금까지 소진) → 보너스 회수 불가 → 환불 불가.
  const r = calculateRefund({
    krwPerCredit: 1,
    amountKrw: 50000,
    daysSincePayment: 20,
    lots: [{ lotId: "p1", source: "purchase", initialCredits: 52500, remainingCredits: 2000, bonusCredits: 2500 }],
  });
  assert.equal(r.refundable, false);
  assert.equal(r.refundKrw, 0);
  assert.equal(r.recoverCredits, 0);
});

// ── 환불 불가: 유료 lot 없음 ────────────────────────────────────────────────
check("환불 불가: 유료 lot 이 없으면(보너스/운영자 지급뿐) 환불 불가", () => {
  const r = calculateRefund({
    krwPerCredit: 1,
    amountKrw: 0,
    daysSincePayment: 1,
    lots: [
      { lotId: "b1", source: "signup_bonus", initialCredits: 1000, remainingCredits: 1000, bonusCredits: 0 },
      { lotId: "a1", source: "admin_grant", initialCredits: 5000, remainingCredits: 5000, bonusCredits: 0 },
    ],
  });
  assert.equal(r.refundable, false);
  assert.equal(r.targetLotIds.length, 0);
});

// ── 환율 스냅샷 적용(1이 아닌 경우) ────────────────────────────────────────
check("환율 스냅샷 반영: krwPerCredit=2 이면 소진분 원화 = 소진×2", () => {
  const r = calculateRefund({
    krwPerCredit: 2,
    amountKrw: 20000,
    daysSincePayment: 3,
    lots: [{ lotId: "p1", source: "purchase", initialCredits: 10000, remainingCredits: 8000, bonusCredits: 0 }],
  });
  // 소진 2,000, 보너스 0 → 원금 소진 2,000 × 2 = 4,000원 차감.
  assert.equal(r.refundKrw, 20000 - 4000);
});

console.log(`\n환불 계산: ${passed} passed`);
