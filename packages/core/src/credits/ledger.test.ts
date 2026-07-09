/**
 * 크레딧 원장(ledger) 도메인 단위 테스트 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/core/src/credits/ledger.test.ts
 *
 * 커버(설계 16.1):
 *   - 멱등 키 빌더 형식 (plan 키가 orderId 기반인지 포함)
 *   - lot 배분: 만료 임박 우선 정렬, 걸침 배분(한 차감이 여러 lot), 부족 시 shortfall
 *   - targetLotIds 모드가 지정 lot 만 깎는지(expiry 가 다른 lot 을 잠식하지 않는지 — 레드팀 M1)
 *   - chainHash 결정성·genesis·변경 민감도
 */
import assert from "node:assert/strict";
import {
  allocateFromLots,
  allocateFromTargetLots,
  computeChainHash,
  genesisHash,
  grantLotBreakdown,
  idempotencyKeys,
  planReversalRestore,
  sortLotsForConsumption,
  type AllocatableLot,
  type LotAllocationLine,
  type ReversalTargetLot,
} from "./ledger.js";
import { InvalidLedgerEntryError } from "./errors.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 멱등 키 (4.3 표) ──────────────────────────────────────────────────

check("멱등 키 형식이 4.3 표와 일치", () => {
  assert.equal(idempotencyKeys.signup("u1"), "signup:u1");
  assert.equal(idempotencyKeys.purchase("o1"), "purchase:o1");
  assert.equal(idempotencyKeys.plan("o1"), "plan:o1"); // ★ orderId 기반(subId 아님)
  assert.equal(idempotencyKeys.usage("ue1"), "usage:ue1");
  assert.equal(idempotencyKeys.refund("o1", "c1"), "refund:o1:c1");
  assert.equal(idempotencyKeys.expiry("lot1"), "expiry:lot1");
  assert.equal(idempotencyKeys.admin("nonce1"), "admin:nonce1");
  assert.equal(idempotencyKeys.reversal("e1"), "reversal:e1");
});

// ── lot 정렬 (2.5) ────────────────────────────────────────────────────

const d = (iso: string) => new Date(iso);

check("만료 임박 우선, 만료 없음은 마지막, 동률은 createdAt", () => {
  const lots: AllocatableLot[] = [
    { id: "purchase", remainingCredits: 100, expiresAt: d("2031-01-01"), createdAt: d("2026-01-01") },
    { id: "signup", remainingCredits: 100, expiresAt: d("2026-04-01"), createdAt: d("2026-01-01") },
    { id: "plan", remainingCredits: 100, expiresAt: d("2026-09-01"), createdAt: d("2026-07-01") },
    { id: "nonexpire", remainingCredits: 100, expiresAt: null, createdAt: d("2026-01-01") },
  ];
  const sorted = sortLotsForConsumption(lots).map((l) => l.id);
  assert.deepEqual(sorted, ["signup", "plan", "purchase", "nonexpire"]);
});

check("만료 동일 시각이면 createdAt 오름차순", () => {
  const lots: AllocatableLot[] = [
    { id: "later", remainingCredits: 10, expiresAt: d("2026-06-01"), createdAt: d("2026-03-01") },
    { id: "earlier", remainingCredits: 10, expiresAt: d("2026-06-01"), createdAt: d("2026-02-01") },
  ];
  assert.deepEqual(sortLotsForConsumption(lots).map((l) => l.id), ["earlier", "later"]);
});

// ── consume_order 배분 (5.2 3-b) ──────────────────────────────────────

check("걸침 배분: 한 차감이 여러 lot 에 나뉜다", () => {
  const sorted = sortLotsForConsumption([
    { id: "a", remainingCredits: 30, expiresAt: d("2026-04-01"), createdAt: d("2026-01-01") },
    { id: "b", remainingCredits: 50, expiresAt: d("2026-05-01"), createdAt: d("2026-01-01") },
  ]);
  const { lines, allocated, shortfall } = allocateFromLots(sorted, 60);
  assert.deepEqual(lines, [
    { lotId: "a", amount: 30 },
    { lotId: "b", amount: 30 },
  ]);
  assert.equal(allocated, 60);
  assert.equal(shortfall, 0);
});

check("정확히 채우면 두 번째 lot 은 건드리지 않는다", () => {
  const sorted = sortLotsForConsumption([
    { id: "a", remainingCredits: 30, expiresAt: d("2026-04-01"), createdAt: d("2026-01-01") },
    { id: "b", remainingCredits: 50, expiresAt: d("2026-05-01"), createdAt: d("2026-01-01") },
  ]);
  const { lines, shortfall } = allocateFromLots(sorted, 30);
  assert.deepEqual(lines, [{ lotId: "a", amount: 30 }]);
  assert.equal(shortfall, 0);
});

check("총 잔여보다 많이 요청하면 shortfall 반환(음수 잔액 금지)", () => {
  const sorted = sortLotsForConsumption([
    { id: "a", remainingCredits: 30, expiresAt: d("2026-04-01"), createdAt: d("2026-01-01") },
  ]);
  const { lines, allocated, shortfall } = allocateFromLots(sorted, 100);
  assert.deepEqual(lines, [{ lotId: "a", amount: 30 }]);
  assert.equal(allocated, 30);
  assert.equal(shortfall, 70);
});

check("remaining 0 인 lot 은 건너뛴다", () => {
  const sorted = sortLotsForConsumption([
    { id: "empty", remainingCredits: 0, expiresAt: d("2026-03-01"), createdAt: d("2026-01-01") },
    { id: "b", remainingCredits: 50, expiresAt: d("2026-05-01"), createdAt: d("2026-01-01") },
  ]);
  const { lines } = allocateFromLots(sorted, 20);
  assert.deepEqual(lines, [{ lotId: "b", amount: 20 }]);
});

check("음수 필요량은 예외", () => {
  assert.throws(() => allocateFromLots([], -1), InvalidLedgerEntryError);
});

// ── targetLotIds 배분 (5.2 3-c, 레드팀 M1) ─────────────────────────────

check("targetLotIds 는 지정 lot 만 깎는다(다른 lot 잠식 금지)", () => {
  // expiry 시나리오: 만료 대상은 'expiring' 하나. consume_order 라면 만료 안 된 'fresh'가 먼저
  // 정렬되어 잠식되지만, targetLotIds 는 오직 'expiring' 만 대상으로 한다.
  const target: AllocatableLot[] = [
    { id: "expiring", remainingCredits: 40, expiresAt: d("2026-07-08"), createdAt: d("2026-05-08") },
  ];
  const { lines, allocated, shortfall } = allocateFromTargetLots(target, 40);
  assert.deepEqual(lines, [{ lotId: "expiring", amount: 40 }]);
  assert.equal(allocated, 40);
  assert.equal(shortfall, 0);
});

check("targetLotIds 지정 lot 잔여가 부족하면 shortfall (콘솔 취소 회수 부족 케이스)", () => {
  const target: AllocatableLot[] = [
    { id: "lot1", remainingCredits: 10, expiresAt: null, createdAt: d("2026-01-01") },
  ];
  const { allocated, shortfall } = allocateFromTargetLots(target, 30);
  assert.equal(allocated, 10);
  assert.equal(shortfall, 20);
});

// ── 지급 lotBreakdown (I4) ─────────────────────────────────────────────

check("지급 분개 lotBreakdown = [{lotId, initialCredits}]", () => {
  assert.deepEqual(grantLotBreakdown("lot-new", 1000), [{ lotId: "lot-new", amount: 1000 }]);
});

check("지급액 0 이하는 예외", () => {
  assert.throws(() => grantLotBreakdown("lot", 0), InvalidLedgerEntryError);
  assert.throws(() => grantLotBreakdown("lot", -5), InvalidLedgerEntryError);
});

// ── chainHash (4.3) ───────────────────────────────────────────────────

check("genesisHash 형식", () => {
  assert.equal(genesisHash("w1"), "genesis:w1");
});

check("computeChainHash 는 결정적(동일 입력 → 동일 해시)", () => {
  const input = {
    prevChainHash: genesisHash("w1"),
    id: "e1",
    walletId: "w1",
    entryType: "signup_bonus_grant",
    amountCredits: 1000,
    balanceAfter: 1000,
    idempotencyKey: "signup:u1",
    createdAt: d("2026-07-09T00:00:00.000Z"),
  };
  const h1 = computeChainHash(input);
  const h2 = computeChainHash({ ...input });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

check("computeChainHash 는 어느 필드가 바뀌어도 해시가 달라진다(변조 탐지)", () => {
  const base = {
    prevChainHash: genesisHash("w1"),
    id: "e1",
    walletId: "w1",
    entryType: "usage_capture",
    amountCredits: -504,
    balanceAfter: 496,
    idempotencyKey: "usage:ue1",
    createdAt: d("2026-07-09T00:00:00.000Z"),
  };
  const h = computeChainHash(base);
  assert.notEqual(h, computeChainHash({ ...base, amountCredits: -503 }));
  assert.notEqual(h, computeChainHash({ ...base, balanceAfter: 497 }));
  assert.notEqual(h, computeChainHash({ ...base, prevChainHash: "tampered" }));
  assert.notEqual(h, computeChainHash({ ...base, createdAt: d("2026-07-09T00:00:01.000Z") }));
});

check("체인 연결: 다음 분개의 prev 는 직전 해시", () => {
  const first = computeChainHash({
    prevChainHash: genesisHash("w1"),
    id: "e1",
    walletId: "w1",
    entryType: "signup_bonus_grant",
    amountCredits: 1000,
    balanceAfter: 1000,
    idempotencyKey: "signup:u1",
    createdAt: d("2026-07-09T00:00:00.000Z"),
  });
  const second = computeChainHash({
    prevChainHash: first,
    id: "e2",
    walletId: "w1",
    entryType: "usage_capture",
    amountCredits: -504,
    balanceAfter: 496,
    idempotencyKey: "usage:ue1",
    createdAt: d("2026-07-09T01:00:00.000Z"),
  });
  assert.notEqual(first, second);
  assert.match(second, /^[0-9a-f]{64}$/);
});

check("CHAIN_SEP 은 실제 NUL 이라 공백/다른 구분자와 해시가 다르다(구분자 주입 방어)", () => {
  // 인접 필드가 구분자 없이 이어붙는 경계 케이스: NUL 구분자면 두 배치가 다른 해시를 낸다.
  // "ab"|"c" 와 "a"|"bc" 는 값 자체가 다르지만, 구분자가 값에 등장하면 두 조합이 같은 해시가 될 수 있다.
  // 공백을 값에 포함시켜 구분자가 공백이었다면 충돌했을 케이스가 NUL 에서는 충돌하지 않음을 확인한다.
  const left = computeChainHash({
    prevChainHash: "p",
    id: "a b", // 값에 공백 포함
    walletId: "w1",
    entryType: "usage_capture",
    amountCredits: -1,
    balanceAfter: 0,
    idempotencyKey: "usage:x",
    createdAt: d("2026-07-09T00:00:00.000Z"),
  });
  const right = computeChainHash({
    prevChainHash: "p",
    id: "a",
    walletId: "b w1", // 인접 필드 쪽으로 공백을 옮김
    entryType: "usage_capture",
    amountCredits: -1,
    balanceAfter: 0,
    idempotencyKey: "usage:x",
    createdAt: d("2026-07-09T00:00:00.000Z"),
  });
  // 구분자가 공백이었다면 "a b w1" 로 병합되어 같은 해시가 나온다. NUL 구분자면 달라야 한다.
  assert.notEqual(left, right);
});

// ── reversal 복원 배분 (4.3, 레드팀 M5 / 16.1) ─────────────────────────

check("음수 분개 reversal: active/exhausted lot 에 remaining 원위치 복원", () => {
  // 원분개가 lot A 에서 30, lot B 에서 20 을 깎았다. reversal 은 두 lot 에 그대로 복원.
  const original: LotAllocationLine[] = [
    { lotId: "A", amount: 30 },
    { lotId: "B", amount: 20 },
  ];
  const current = new Map<string, ReversalTargetLot>([
    ["A", { id: "A", remainingCredits: 70, initialCredits: 100, status: "active" }],
    ["B", { id: "B", remainingCredits: 0, initialCredits: 20, status: "exhausted" }],
  ]);
  const plan = planReversalRestore(original, current);
  assert.equal(plan.totalRestored, 50);
  assert.equal(plan.replacementCount, 0);
  assert.deepEqual(plan.actions, [
    { kind: "restore", lotId: "A", amount: 30 },
    { kind: "restore", lotId: "B", amount: 20 },
  ]);
});

check("reversal 복원량이 lot 초기값을 초과하면 예외(remaining <= initial CHECK 준수)", () => {
  const original: LotAllocationLine[] = [{ lotId: "A", amount: 40 }];
  // remaining 80 + 복원 40 = 120 > initial 100 → 위반.
  const current = new Map<string, ReversalTargetLot>([
    ["A", { id: "A", remainingCredits: 80, initialCredits: 100, status: "active" }],
  ]);
  assert.throws(() => planReversalRestore(original, current), InvalidLedgerEntryError);
});

check("reversal: expired/revoked lot 은 대체 lot 신규 생성 지시로 나온다", () => {
  const original: LotAllocationLine[] = [
    { lotId: "expired", amount: 15 },
    { lotId: "revoked", amount: 25 },
  ];
  const current = new Map<string, ReversalTargetLot>([
    ["expired", { id: "expired", remainingCredits: 0, initialCredits: 15, status: "expired" }],
    ["revoked", { id: "revoked", remainingCredits: 0, initialCredits: 25, status: "revoked" }],
  ]);
  const plan = planReversalRestore(original, current);
  assert.equal(plan.replacementCount, 2);
  assert.equal(plan.totalRestored, 40);
  assert.deepEqual(plan.actions, [
    { kind: "replace", replacesLotId: "expired", amount: 15 },
    { kind: "replace", replacesLotId: "revoked", amount: 25 },
  ]);
});

check("reversal: 조회 안 되는 lot(맵에 없음)도 대체 생성 대상", () => {
  const original: LotAllocationLine[] = [{ lotId: "gone", amount: 10 }];
  const plan = planReversalRestore(original, new Map());
  assert.deepEqual(plan.actions, [{ kind: "replace", replacesLotId: "gone", amount: 10 }]);
  assert.equal(plan.replacementCount, 1);
});

check("reversal: restore 와 replace 혼합 — 살아있는 lot 은 복원, 만료 lot 은 대체", () => {
  const original: LotAllocationLine[] = [
    { lotId: "alive", amount: 30 },
    { lotId: "dead", amount: 20 },
  ];
  const current = new Map<string, ReversalTargetLot>([
    ["alive", { id: "alive", remainingCredits: 10, initialCredits: 100, status: "active" }],
    ["dead", { id: "dead", remainingCredits: 0, initialCredits: 20, status: "expired" }],
  ]);
  const plan = planReversalRestore(original, current);
  assert.deepEqual(plan.actions, [
    { kind: "restore", lotId: "alive", amount: 30 },
    { kind: "replace", replacesLotId: "dead", amount: 20 },
  ]);
  assert.equal(plan.totalRestored, 50);
  assert.equal(plan.replacementCount, 1);
});

check("reversal: 원분개 배분 금액이 양수가 아니면 예외", () => {
  assert.throws(
    () => planReversalRestore([{ lotId: "A", amount: 0 }], new Map()),
    InvalidLedgerEntryError,
  );
});

check("reversal 멱등 키는 reversal:{원분개 entryId} 형식", () => {
  // 원분개당 1회 제한 키 형식(reversal_of_entry_id partial unique 와 정합).
  assert.equal(idempotencyKeys.reversal("entry-123"), "reversal:entry-123");
});

console.log(JSON.stringify({ ok: true, suite: "credits/ledger", passed }, null, 2));
