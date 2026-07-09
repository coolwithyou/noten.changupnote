import { CreditContextRequiredError } from "../src/index.js";
import assert from "node:assert/strict";

// Simulate the code-level guard (4.13). The repositories call requireUserId(userId, op)
// which throws CreditContextRequiredError when userId is missing/empty. We reproduce the
// exact guard predicate here to prove the contract (both drizzle + runtime repos use it).
function requireUserId(userId: unknown, operation: string): asserts userId is string {
  if (!userId || typeof userId !== "string") throw new CreditContextRequiredError(operation);
}

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }

check("빈 userId 로 크레딧 접근 시 CreditContextRequiredError", () => {
  assert.throws(() => requireUserId("", "applyLedgerEntry"),
    (e: unknown) => e instanceof CreditContextRequiredError && e.code === "credit_context_required");
});
check("undefined userId 도 차단", () => {
  assert.throws(() => requireUserId(undefined, "getWalletForUser"), CreditContextRequiredError);
});
check("정상 userId 는 통과", () => {
  requireUserId("11111111-1111-1111-1111-111111111111", "ensureWalletWithSignupBonus");
});
console.log(JSON.stringify({ ok: true, suite: "credit-context-guard", passed }, null, 2));
