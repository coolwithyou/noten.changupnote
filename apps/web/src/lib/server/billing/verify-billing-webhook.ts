import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleBillingWebhook, signBillingWebhookPayload } from "./webhooks";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalSupabaseDbUrl = process.env.SUPABASE_DB_URL;
const originalDirectUrl = process.env.DIRECT_URL;
const originalSecret = process.env.CUNOTE_BILLING_WEBHOOK_SECRET;

try {
  delete process.env.DATABASE_URL;
  delete process.env.SUPABASE_DB_URL;
  delete process.env.DIRECT_URL;
  const webhookSecret = "verify-webhook-secret";
  process.env.CUNOTE_BILLING_WEBHOOK_SECRET = webhookSecret;

  const rawBody = JSON.stringify({
    eventId: "verify-subscription-invoice-payment-method",
    eventType: "billing.subscription.updated",
    companyId: "00000000-0000-4000-8000-000000000101",
    subscription: {
      id: "sub_verify_001",
      customer: "cus_verify_001",
      status: "active",
      plan: { id: "team", nickname: "Team" },
      priceLabel: "월 99,000원",
      renewalLabel: "매월 자동 갱신",
      seatLimit: 8,
      current_period_end: 1_798_761_600,
      default_payment_method: "pm_verify_001",
      paymentMethod: {
        id: "pm_verify_001",
        type: "card",
        card: {
          brand: "visa",
          last4: "4242",
          exp_month: 12,
          exp_year: 2030,
        },
        billing_details: {
          name: "검증 담당자",
          email: "billing-verify@example.test",
        },
      },
      metadata: {
        providerPortalUrl: "https://billing.example.test/portal",
      },
    },
  });

  const genericSignature = signBillingWebhookPayload({
    rawBody,
    secret: webhookSecret,
  });
  const genericResult = await handleBillingWebhook({
    provider: "manual",
    rawBody,
    headers: new Headers({
      "x-cunote-signature": `sha256=${genericSignature}`,
    }),
  });

  assert.equal(genericResult.provider, "manual");
  assert.equal(genericResult.eventId, "verify-subscription-invoice-payment-method");
  assert.equal(genericResult.duplicate, false);
  assert.equal(genericResult.persisted, false);
  assert.equal(genericResult.processingStatus, "processed");
  assert.equal(genericResult.subscription?.companyId, "00000000-0000-4000-8000-000000000101");
  assert.equal(genericResult.subscription?.subscription.status, "active");
  assert.equal(genericResult.subscription?.subscription.planName, "Team");
  assert.equal(genericResult.subscription?.subscription.seatLimit, 8);

  const stripeTimestamp = "1798761600";
  const stripeRawBody = JSON.stringify({
    id: "evt_verify_invoice",
    type: "invoice.paid",
    data: {
      object: {
        id: "in_verify_001",
        customer: "cus_verify_001",
        subscription: "sub_verify_001",
        status: "paid",
        amount_due: 99000,
        amount_paid: 99000,
        currency: "krw",
        metadata: {
          companyId: "00000000-0000-4000-8000-000000000101",
        },
      },
    },
  });
  const stripeSignature = createHmac("sha256", webhookSecret)
    .update(`${stripeTimestamp}.${stripeRawBody}`)
    .digest("hex");
  const stripeResult = await handleBillingWebhook({
    provider: "stripe",
    rawBody: stripeRawBody,
    headers: new Headers({
      "stripe-signature": `t=${stripeTimestamp},v1=${stripeSignature}`,
    }),
  });

  assert.equal(stripeResult.provider, "stripe");
  assert.equal(stripeResult.eventId, "evt_verify_invoice");
  assert.equal(stripeResult.eventType, "invoice.paid");
  assert.equal(stripeResult.processingStatus, "processed");

  await assert.rejects(
    () => handleBillingWebhook({
      provider: "manual",
      rawBody,
      headers: new Headers({ "x-cunote-signature": "sha256=deadbeef" }),
    }),
    (error) => isWebhookError(error, "invalid_billing_webhook_signature", 401),
  );

  await assert.rejects(
    () => handleBillingWebhook({
      provider: "manual",
      rawBody: "not-json",
      headers: new Headers({ "x-cunote-signature": `sha256=${signBillingWebhookPayload({ rawBody: "not-json", secret: webhookSecret })}` }),
    }),
    (error) => isWebhookError(error, "invalid_billing_webhook_payload", 400),
  );

  delete process.env.CUNOTE_BILLING_WEBHOOK_SECRET;
  await assert.rejects(
    () => handleBillingWebhook({
      provider: "manual",
      rawBody,
      headers: new Headers(),
    }),
    (error) => isWebhookError(error, "billing_webhook_secret_missing", 503),
  );

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "generic_signature_acceptance",
      "stripe_signature_acceptance",
      "subscription_normalization",
      "invalid_signature_boundary",
      "invalid_payload_boundary",
      "missing_secret_boundary",
    ],
  }, null, 2));
} finally {
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("SUPABASE_DB_URL", originalSupabaseDbUrl);
  restoreEnv("DIRECT_URL", originalDirectUrl);
  restoreEnv("CUNOTE_BILLING_WEBHOOK_SECRET", originalSecret);
}

function isWebhookError(error: unknown, code: string, status: number): boolean {
  if (!error || typeof error !== "object") return false;
  return true
    && "code" in error
    && "status" in error
    && (error as { code?: unknown }).code === code
    && (error as { status?: unknown }).status === status;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
