/**
 * 포트원 웹훅 서명 검증 단위 테스트 (설계 7.3).
 * 실행: pnpm exec tsx --tsconfig apps/web/tsconfig.json apps/web/src/lib/server/payments/portoneWebhook.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyPortoneWebhook, WebhookVerificationError } from "./portoneWebhook";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SECRET_B64 = Buffer.from("test-secret-key-material").toString("base64");
const SECRET = `whsec_${SECRET_B64}`;
const now = () => new Date(1_700_000_000_000); // 고정 시각.

function sign(webhookId: string, ts: string, body: string): string {
  const secretBytes = Buffer.from(SECRET_B64, "base64");
  const sig = createHmac("sha256", secretBytes).update(`${webhookId}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}

function headersFor(webhookId: string, ts: string, signature: string): Headers {
  return new Headers({
    "webhook-id": webhookId,
    "webhook-timestamp": ts,
    "webhook-signature": signature,
  });
}

console.log("포트원 웹훅 서명 검증 (7.3)");

check("유효 서명 → 파싱 성공", () => {
  const body = JSON.stringify({ type: "Transaction.Paid", data: { paymentId: "cnord_x" } });
  const ts = String(Math.floor(now().getTime() / 1000));
  const wid = "wh_1";
  const payload = verifyPortoneWebhook(body, headersFor(wid, ts, sign(wid, ts, body)), { secret: SECRET, now });
  assert.equal(payload.type, "Transaction.Paid");
  assert.equal(payload.data?.paymentId, "cnord_x");
});

check("서명 불일치 → 401 WebhookVerificationError", () => {
  const body = JSON.stringify({ type: "Transaction.Paid" });
  const ts = String(Math.floor(now().getTime() / 1000));
  assert.throws(
    () => verifyPortoneWebhook(body, headersFor("wh_2", ts, "v1,AAAA"), { secret: SECRET, now }),
    (e) => e instanceof WebhookVerificationError && e.status === 401,
  );
});

check("변조된 본문 → 서명 불일치(401)", () => {
  const original = JSON.stringify({ type: "Transaction.Paid", data: { paymentId: "a" } });
  const tampered = JSON.stringify({ type: "Transaction.Paid", data: { paymentId: "b" } });
  const ts = String(Math.floor(now().getTime() / 1000));
  const wid = "wh_3";
  const sig = sign(wid, ts, original);
  assert.throws(
    () => verifyPortoneWebhook(tampered, headersFor(wid, ts, sig), { secret: SECRET, now }),
    WebhookVerificationError,
  );
});

check("타임스탬프 허용 범위 초과 → 401", () => {
  const body = JSON.stringify({ type: "Transaction.Paid" });
  const staleTs = String(Math.floor(now().getTime() / 1000) - 3600); // 1시간 전.
  const wid = "wh_4";
  assert.throws(
    () => verifyPortoneWebhook(body, headersFor(wid, staleTs, sign(wid, staleTs, body)), { secret: SECRET, now }),
    WebhookVerificationError,
  );
});

check("시크릿 미설정 → 401(검증 불가 웹훅 미처리)", () => {
  const body = JSON.stringify({ type: "Transaction.Paid" });
  const ts = String(Math.floor(now().getTime() / 1000));
  assert.throws(
    () => verifyPortoneWebhook(body, headersFor("wh_5", ts, "v1,x"), { secret: "", now }),
    WebhookVerificationError,
  );
});

check("헤더 누락 → 401", () => {
  const body = JSON.stringify({ type: "Transaction.Paid" });
  assert.throws(
    () => verifyPortoneWebhook(body, new Headers(), { secret: SECRET, now }),
    WebhookVerificationError,
  );
});

console.log(`\n웹훅 서명: ${passed} passed`);
