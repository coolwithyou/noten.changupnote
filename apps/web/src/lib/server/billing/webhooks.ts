import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import {
  syncBillingSubscriptionFromWebhook,
  type BillingSubscriptionUpdateResult,
} from "./subscription";
import {
  upsertBillingInvoiceFromWebhook,
  type BillingInvoiceItem,
} from "./invoices";
import {
  upsertBillingPaymentMethodFromWebhook,
  type BillingPaymentMethodItem,
} from "./paymentMethods";

export interface BillingWebhookResult {
  provider: string;
  eventId: string;
  eventType: string;
  persisted: boolean;
  duplicate: boolean;
  processingStatus: "processed" | "ignored" | "received";
  subscription: BillingSubscriptionUpdateResult | null;
  invoice: BillingInvoiceItem | null;
  paymentMethod: BillingPaymentMethodItem | null;
}

export interface AdminBillingWebhookEventItem {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  companyId: string | null;
  processingStatus: string;
  signatureVerified: boolean;
  receivedAt: string;
  processedAt: string | null;
}

export class BillingWebhookError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "BillingWebhookError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

export async function handleBillingWebhook(input: {
  provider: string;
  rawBody: string;
  headers: Headers;
}): Promise<BillingWebhookResult> {
  const provider = normalizeProvider(input.provider);
  verifyBillingWebhookSignature({
    provider,
    rawBody: input.rawBody,
    headers: input.headers,
  });
  const payload = parsePayload(input.rawBody);
  const event = normalizeBillingWebhookEvent({ provider, payload });
  const existing = await findStoredBillingWebhookEvent({
    provider,
    eventId: event.eventId,
  });
  if (existing) {
    return {
      provider,
      eventId: event.eventId,
      eventType: event.eventType,
      persisted: true,
      duplicate: true,
      processingStatus: "received",
      subscription: null,
      invoice: null,
      paymentMethod: null,
    };
  }

  const subscription = event.hasSubscriptionSignal && event.companyId
    ? await syncBillingSubscriptionFromWebhook({
      companyId: event.companyId,
      provider,
      eventId: event.eventId,
      providerCustomerId: event.providerCustomerId,
      providerSubscriptionId: event.providerSubscriptionId,
      status: event.status,
      planCode: event.planCode,
      planName: event.planName,
      priceLabel: event.priceLabel,
      renewalLabel: event.renewalLabel,
      seatLimit: event.seatLimit,
      autoBillingEnabled: event.autoBillingEnabled,
      invoicesEnabled: event.invoicesEnabled,
      paymentMethodManaged: event.paymentMethodManaged,
      providerPortalUrl: event.providerPortalUrl,
      trialEndsAt: event.trialEndsAt,
      currentPeriodEnd: event.currentPeriodEnd,
    })
    : null;
  const invoice = await upsertBillingInvoiceFromWebhook({
    companyId: event.companyId,
    provider,
    providerInvoiceId: event.providerInvoiceId,
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    invoiceNumber: event.invoiceNumber,
    status: event.invoiceStatus,
    currency: event.currency,
    amountDue: event.amountDue,
    amountPaid: event.amountPaid,
    taxAmount: event.taxAmount,
    hostedInvoiceUrl: event.hostedInvoiceUrl,
    receiptUrl: event.receiptUrl,
    issuedAt: event.issuedAt,
    dueAt: event.dueAt,
    paidAt: event.paidAt,
    periodStart: event.periodStart,
    periodEnd: event.periodEnd,
    payload,
  });
  const paymentMethod = await upsertBillingPaymentMethodFromWebhook({
    companyId: event.companyId,
    provider,
    providerCustomerId: event.providerCustomerId,
    providerPaymentMethodId: event.providerPaymentMethodId,
    type: event.paymentMethodType,
    brand: event.paymentMethodBrand,
    last4: event.paymentMethodLast4,
    expMonth: event.paymentMethodExpMonth,
    expYear: event.paymentMethodExpYear,
    holderName: event.paymentMethodHolderName,
    billingEmail: event.paymentMethodBillingEmail,
    status: event.paymentMethodStatus,
    isDefault: event.paymentMethodIsDefault,
    providerPortalUrl: event.providerPortalUrl,
    lastUsedAt: event.paymentMethodLastUsedAt,
    payload,
  });
  const processingStatus = event.companyId ? "processed" : "ignored";
  const stored = await storeBillingWebhookEvent({
    provider,
    eventId: event.eventId,
    eventType: event.eventType,
    companyId: event.companyId,
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    payload,
    processingStatus,
  });

  return {
    provider,
    eventId: event.eventId,
    eventType: event.eventType,
    persisted: stored.persisted,
    duplicate: stored.duplicate,
    processingStatus,
    subscription,
    invoice,
    paymentMethod,
  };
}

export async function countAdminBillingWebhookEvents(): Promise<number> {
  if (!hasDatabaseUrl()) return 0;
  try {
    const db = getCunoteDb();
    return (await db.select({ value: count() }).from(schema.billingWebhookEvents))[0]?.value ?? 0;
  } catch {
    return 0;
  }
}

export async function listAdminBillingWebhookEvents(limit = 8): Promise<AdminBillingWebhookEventItem[]> {
  if (!hasDatabaseUrl()) return [];
  const safeLimit = Math.max(1, Math.min(20, limit));
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({
        id: schema.billingWebhookEvents.id,
        provider: schema.billingWebhookEvents.provider,
        eventId: schema.billingWebhookEvents.eventId,
        eventType: schema.billingWebhookEvents.eventType,
        companyId: schema.billingWebhookEvents.companyId,
        processingStatus: schema.billingWebhookEvents.processingStatus,
        signatureVerified: schema.billingWebhookEvents.signatureVerified,
        receivedAt: schema.billingWebhookEvents.receivedAt,
        processedAt: schema.billingWebhookEvents.processedAt,
      })
      .from(schema.billingWebhookEvents)
      .orderBy(desc(schema.billingWebhookEvents.receivedAt))
      .limit(safeLimit);
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      eventId: row.eventId,
      eventType: row.eventType,
      companyId: row.companyId,
      processingStatus: row.processingStatus,
      signatureVerified: row.signatureVerified,
      receivedAt: row.receivedAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
    }));
  } catch {
    return [];
  }
}

export function signBillingWebhookPayload(input: {
  rawBody: string;
  secret: string;
}): string {
  return createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
}

function verifyBillingWebhookSignature(input: {
  provider: string;
  rawBody: string;
  headers: Headers;
}) {
  const secret = webhookSecret(input.provider);
  if (!secret) {
    throw new BillingWebhookError(
      "billing_webhook_secret_missing",
      "결제 webhook secret이 설정되지 않았습니다.",
      503,
      "secret",
    );
  }

  const genericSignature = input.headers.get("x-cunote-signature")
    ?? input.headers.get("x-billing-signature");
  if (genericSignature) {
    const expected = signBillingWebhookPayload({ rawBody: input.rawBody, secret });
    if (safeEqual(cleanSignature(genericSignature), expected)) return;
  }

  const stripeSignature = input.headers.get("stripe-signature");
  if (stripeSignature) {
    const parsed = parseStripeSignature(stripeSignature);
    if (parsed) {
      const expected = createHmac("sha256", secret)
        .update(`${parsed.timestamp}.${input.rawBody}`)
        .digest("hex");
      if (safeEqual(parsed.signature, expected)) return;
    }
  }

  throw new BillingWebhookError(
    "invalid_billing_webhook_signature",
    "결제 webhook 서명을 확인하지 못했습니다.",
    401,
    "signature",
  );
}

function parsePayload(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // handled below
  }
  throw new BillingWebhookError("invalid_billing_webhook_payload", "결제 webhook payload를 확인해주세요.", 400, "payload");
}

function normalizeBillingWebhookEvent(input: {
  provider: string;
  payload: Record<string, unknown>;
}) {
  const object = objectValue(input.payload.subscription)
    ?? objectValue(objectValue(input.payload.data)?.object)
    ?? objectValue(input.payload.data)
    ?? input.payload;
  const eventId = stringValue(input.payload.eventId)
    ?? stringValue(input.payload.id)
    ?? stablePayloadId(input.provider, input.payload);
  const eventType = stringValue(input.payload.eventType)
    ?? stringValue(input.payload.type)
    ?? "billing.subscription.updated";
  const paymentMethodObject = objectValue(object.paymentMethod)
    ?? objectValue(object.payment_method)
    ?? objectValue(object.default_payment_method)
    ?? objectValue(object.paymentMethodDetails)
    ?? objectValue(object.payment_method_details)
    ?? (eventType.includes("payment_method") ? object : null);
  const paymentMethodCard = objectValue(paymentMethodObject?.card)
    ?? objectValue(object.card)
    ?? objectValue(objectValue(object.payment_method_details)?.card)
    ?? {};
  const billingDetails = objectValue(paymentMethodObject?.billing_details)
    ?? objectValue(paymentMethodObject?.billingDetails)
    ?? objectValue(object.billing_details)
    ?? {};
  const plan = objectValue(object.plan) ?? {};
  const lines = Array.isArray(object.lines) ? object.lines : [];
  const statusTransitions = objectValue(object.status_transitions) ?? {};
  const defaultPaymentMethodId = stringValue(object.defaultPaymentMethodId)
    ?? stringValue(object.default_payment_method);
  const hasInvoiceSignal = eventType.includes("invoice")
    || eventType.includes("receipt")
    || object.amount_due !== undefined
    || object.amount_paid !== undefined
    || object.invoiceNumber !== undefined
    || object.invoice_number !== undefined;
  const hasPaymentMethodSignal = eventType.includes("payment_method")
    || object.paymentMethodId !== undefined
    || object.payment_method !== undefined
    || object.default_payment_method !== undefined
    || paymentMethodObject !== null;
  const hasSubscriptionSignal = eventType.includes("subscription")
    || object.subscriptionId !== undefined
    || object.providerSubscriptionId !== undefined
    || object.current_period_end !== undefined
    || object.trial_end !== undefined;
  const payloadMetadata = objectValue(input.payload.metadata) ?? {};
  const objectMetadata = objectValue(object.metadata) ?? {};
  const paymentMetadata = objectValue(paymentMethodObject?.metadata) ?? {};
  const metadata = { ...payloadMetadata, ...objectMetadata, ...paymentMetadata };
  const companyId = stringValue(input.payload.companyId)
    ?? stringValue(object.companyId)
    ?? stringValue(metadata.companyId);
  const providerCustomerId = stringValue(input.payload.providerCustomerId)
    ?? stringValue(object.providerCustomerId)
    ?? stringValue(paymentMethodObject?.providerCustomerId)
    ?? stringValue(paymentMethodObject?.customer)
    ?? stringValue(paymentMethodObject?.customerId)
    ?? stringValue(object.customer)
    ?? stringValue(object.customerId);
  const providerSubscriptionId = hasSubscriptionSignal || hasInvoiceSignal
    ? stringValue(input.payload.providerSubscriptionId)
      ?? stringValue(object.providerSubscriptionId)
      ?? stringValue(object.subscription)
      ?? stringValue(object.subscriptionId)
      ?? (eventType.includes("subscription") ? stringValue(object.id) : null)
    : null;
  const providerInvoiceId = hasInvoiceSignal
    ? stringValue(input.payload.providerInvoiceId)
      ?? stringValue(input.payload.invoiceId)
      ?? stringValue(object.providerInvoiceId)
      ?? stringValue(object.invoice)
      ?? stringValue(object.invoiceId)
      ?? stringValue(object.id)
    : null;
  const providerPaymentMethodId = hasPaymentMethodSignal
    ? stringValue(input.payload.providerPaymentMethodId)
      ?? stringValue(input.payload.paymentMethodId)
      ?? stringValue(object.providerPaymentMethodId)
      ?? stringValue(object.paymentMethodId)
      ?? stringValue(object.payment_method)
      ?? stringValue(object.default_payment_method)
      ?? stringValue(paymentMethodObject?.id)
      ?? (eventType.includes("payment_method") ? stringValue(object.id) : null)
    : null;

  return {
    eventId,
    eventType,
    hasSubscriptionSignal,
    companyId,
    providerCustomerId,
    providerSubscriptionId,
    providerInvoiceId,
    invoiceNumber: stringValue(object.invoiceNumber) ?? stringValue(object.invoice_number) ?? stringValue(object.number),
    invoiceStatus: stringValue(object.invoiceStatus) ?? stringValue(object.status),
    currency: stringValue(object.currency),
    amountDue: moneyValue(object.amountDue) ?? moneyValue(object.amount_due) ?? moneyValue(object.total),
    amountPaid: moneyValue(object.amountPaid) ?? moneyValue(object.amount_paid) ?? moneyValue(object.amount_received),
    taxAmount: moneyValue(object.taxAmount) ?? moneyValue(object.tax) ?? moneyValue(object.total_tax_amounts),
    hostedInvoiceUrl: stringValue(object.hostedInvoiceUrl) ?? stringValue(object.hosted_invoice_url),
    receiptUrl: stringValue(object.receiptUrl) ?? stringValue(object.receipt_url) ?? stringValue(object.invoice_pdf),
    issuedAt: stringValue(object.issuedAt) ?? unixSecondsDateString(object.created),
    dueAt: stringValue(object.dueAt) ?? unixSecondsDateString(object.due_date),
    paidAt: stringValue(object.paidAt) ?? unixSecondsDateString(statusTransitions.paid_at),
    periodStart: stringValue(object.periodStart) ?? unixSecondsDateString(object.period_start) ?? firstLinePeriod(lines, "start"),
    periodEnd: stringValue(object.periodEnd) ?? unixSecondsDateString(object.period_end) ?? firstLinePeriod(lines, "end"),
    providerPaymentMethodId,
    paymentMethodType: stringValue(paymentMethodObject?.type) ?? stringValue(object.paymentMethodType) ?? stringValue(object.payment_method_type),
    paymentMethodBrand: stringValue(paymentMethodCard.brand) ?? stringValue(object.paymentMethodBrand),
    paymentMethodLast4: stringValue(paymentMethodCard.last4) ?? stringValue(object.paymentMethodLast4),
    paymentMethodExpMonth: numberValue(paymentMethodCard.exp_month) ?? numberValue(paymentMethodCard.expMonth) ?? numberValue(object.paymentMethodExpMonth),
    paymentMethodExpYear: numberValue(paymentMethodCard.exp_year) ?? numberValue(paymentMethodCard.expYear) ?? numberValue(object.paymentMethodExpYear),
    paymentMethodHolderName: stringValue(billingDetails.name) ?? stringValue(object.paymentMethodHolderName),
    paymentMethodBillingEmail: stringValue(billingDetails.email) ?? stringValue(object.paymentMethodBillingEmail),
    paymentMethodStatus: paymentMethodStatus(eventType, object),
    paymentMethodIsDefault: booleanValue(paymentMethodObject?.isDefault)
      ?? booleanValue(paymentMethodObject?.is_default)
      ?? booleanValue(object.paymentMethodIsDefault)
      ?? booleanValue(object.isDefault)
      ?? (providerPaymentMethodId && defaultPaymentMethodId === providerPaymentMethodId ? true : null),
    paymentMethodLastUsedAt: stringValue(object.paymentMethodLastUsedAt)
      ?? stringValue(object.lastUsedAt)
      ?? (hasInvoiceSignal ? stringValue(object.paidAt) ?? unixSecondsDateString(statusTransitions.paid_at) ?? unixSecondsDateString(object.created) : null),
    status: stringValue(object.status) ?? stringValue(input.payload.status) ?? "manual_review",
    planCode: stringValue(object.planCode) ?? stringValue(plan.id) ?? stringValue(metadata.planCode),
    planName: stringValue(object.planName) ?? stringValue(plan.nickname) ?? stringValue(metadata.planName),
    priceLabel: stringValue(object.priceLabel) ?? stringValue(metadata.priceLabel),
    renewalLabel: stringValue(object.renewalLabel) ?? stringValue(metadata.renewalLabel),
    seatLimit: numberValue(object.seatLimit) ?? numberValue(metadata.seatLimit),
    autoBillingEnabled: booleanValue(object.autoBillingEnabled) ?? true,
    invoicesEnabled: booleanValue(object.invoicesEnabled) ?? true,
    paymentMethodManaged: booleanValue(object.paymentMethodManaged) ?? true,
    providerPortalUrl: stringValue(object.providerPortalUrl) ?? stringValue(metadata.providerPortalUrl),
    trialEndsAt: stringValue(object.trialEndsAt) ?? unixSecondsDateString(object.trial_end),
    currentPeriodEnd: stringValue(object.currentPeriodEnd) ?? unixSecondsDateString(object.current_period_end),
  };
}

function paymentMethodStatus(eventType: string, object: Record<string, unknown>): string | null {
  const explicitStatus = stringValue(object.paymentMethodStatus)
    ?? stringValue(object.payment_method_status);
  if (explicitStatus) return explicitStatus;
  if (eventType.includes("detached") || eventType.includes("deleted")) return "detached";
  if (eventType.includes("expired")) return "expired";
  if (eventType.includes("requires_action")) return "requires_action";
  if (eventType.includes("payment_method")) {
    return stringValue(object.status) ?? "active";
  }
  return "active";
}

async function storeBillingWebhookEvent(input: {
  provider: string;
  eventId: string;
  eventType: string;
  companyId: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  payload: Record<string, unknown>;
  processingStatus: "processed" | "ignored";
}): Promise<{ persisted: boolean; duplicate: boolean }> {
  if (!hasDatabaseUrl()) return { persisted: false, duplicate: false };
  try {
    const existing = await findStoredBillingWebhookEvent({
      provider: input.provider,
      eventId: input.eventId,
    });
    if (existing) return { persisted: true, duplicate: true };
    const db = getCunoteDb();
    const now = new Date();
    await db.insert(schema.billingWebhookEvents).values({
      provider: input.provider,
      eventId: input.eventId,
      eventType: input.eventType,
      companyId: uuidOrNull(input.companyId),
      providerCustomerId: input.providerCustomerId,
      providerSubscriptionId: input.providerSubscriptionId,
      signatureVerified: true,
      processingStatus: input.processingStatus,
      payload: input.payload,
      receivedAt: now,
      processedAt: now,
    });
    return { persisted: true, duplicate: false };
  } catch {
    return { persisted: false, duplicate: false };
  }
}

async function findStoredBillingWebhookEvent(input: {
  provider: string;
  eventId: string;
}): Promise<{ id: string } | null> {
  if (!hasDatabaseUrl()) return null;
  try {
    const db = getCunoteDb();
    const [existing] = await db
      .select({ id: schema.billingWebhookEvents.id })
      .from(schema.billingWebhookEvents)
      .where(and(
        eq(schema.billingWebhookEvents.provider, input.provider),
        eq(schema.billingWebhookEvents.eventId, input.eventId),
      ))
      .limit(1);
    return existing ?? null;
  } catch {
    return null;
  }
}

function parseStripeSignature(value: string): { timestamp: string; signature: string } | null {
  const parts = new Map(value.split(",").map((part) => {
    const [key, ...rest] = part.split("=");
    return [key?.trim(), rest.join("=").trim()] as const;
  }));
  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  return timestamp && signature ? { timestamp, signature } : null;
}

function cleanSignature(value: string): string {
  return value.trim().replace(/^sha256=/i, "");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function webhookSecret(provider: string): string | null {
  const providerKey = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return env(`${providerKey}_WEBHOOK_SECRET`)
    ?? env("CUNOTE_BILLING_WEBHOOK_SECRET")
    ?? null;
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (!normalized) {
    throw new BillingWebhookError("invalid_billing_webhook_provider", "결제 provider를 확인해주세요.", 400, "provider");
  }
  return normalized.slice(0, 40);
}

function stablePayloadId(provider: string, payload: Record<string, unknown>): string {
  return `${provider}_${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24)}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function moneyValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value % 1 === 0 && value >= 1000 ? value : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => {
      const object = objectValue(item);
      const amount = moneyValue(object?.amount);
      return amount === null ? sum : sum + amount;
    }, 0);
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  }
  return null;
}

function unixSecondsDateString(value: unknown): string | null {
  const seconds = numberValue(value);
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstLinePeriod(lines: unknown[], key: "start" | "end"): string | null {
  const first = lines.map(objectValue).find(Boolean);
  const period = objectValue(first?.period);
  return unixSecondsDateString(period?.[key]);
}

function uuidOrNull(value: string | null): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function env(key: string): string | null {
  const value = process.env[key]?.trim();
  return value ? value : null;
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}
