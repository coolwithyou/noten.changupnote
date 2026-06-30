import { and, count, desc, eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface BillingPaymentMethodItem {
  id: string;
  provider: string;
  providerPaymentMethodId: string;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  holderName: string | null;
  billingEmail: string | null;
  status: string;
  statusLabel: string;
  isDefault: boolean;
  providerPortalUrl: string | null;
  lastUsedAt: string | null;
  updatedAt: string;
  displayLabel: string;
  expiryLabel: string;
}

export interface AdminBillingPaymentMethodItem extends BillingPaymentMethodItem {
  companyId: string;
  companyName: string;
}

export async function listBillingPaymentMethods(input: {
  access: CompanyAccess;
  limit?: number;
}): Promise<BillingPaymentMethodItem[]> {
  if (input.access.mode === "demo" || !hasDatabaseUrl()) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select()
      .from(schema.billingPaymentMethods)
      .where(eq(schema.billingPaymentMethods.companyId, input.access.companyId))
      .orderBy(desc(schema.billingPaymentMethods.isDefault), desc(schema.billingPaymentMethods.updatedAt))
      .limit(limit));
    return rows.map(toPaymentMethodItem);
  } catch {
    return [];
  }
}

export async function upsertBillingPaymentMethodFromWebhook(input: {
  companyId: string | null;
  provider: string;
  providerCustomerId: string | null;
  providerPaymentMethodId: string | null;
  type: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  holderName: string | null;
  billingEmail: string | null;
  status: string | null;
  isDefault: boolean | null;
  providerPortalUrl: string | null;
  lastUsedAt: string | null;
  payload: Record<string, unknown>;
}): Promise<BillingPaymentMethodItem | null> {
  if (!input.companyId || !input.providerPaymentMethodId || !hasDatabaseUrl()) return null;
  try {
    const db = getCunoteDb();
    const now = new Date();
    const values = {
      companyId: input.companyId,
      provider: input.provider,
      providerCustomerId: input.providerCustomerId,
      providerPaymentMethodId: input.providerPaymentMethodId,
      type: normalizeType(input.type),
      brand: normalizeText(input.brand, 40),
      last4: normalizeLast4(input.last4),
      expMonth: normalizeMonth(input.expMonth),
      expYear: normalizeYear(input.expYear),
      holderName: normalizeText(input.holderName, 120),
      billingEmail: normalizeText(input.billingEmail, 160),
      status: normalizePaymentMethodStatus(input.status),
      isDefault: input.isDefault ?? false,
      providerPortalUrl: validUrl(input.providerPortalUrl),
      lastUsedAt: dateOrNull(input.lastUsedAt),
      payload: redactPaymentPayload(input.payload),
      updatedAt: now,
    };
    const [existing] = await db
      .select({ id: schema.billingPaymentMethods.id })
      .from(schema.billingPaymentMethods)
      .where(and(
        eq(schema.billingPaymentMethods.provider, input.provider),
        eq(schema.billingPaymentMethods.providerPaymentMethodId, input.providerPaymentMethodId),
      ))
      .limit(1);
    const [row] = existing
      ? await db
        .update(schema.billingPaymentMethods)
        .set(values)
        .where(eq(schema.billingPaymentMethods.id, existing.id))
        .returning()
      : await db
        .insert(schema.billingPaymentMethods)
        .values({ ...values, createdAt: now })
        .returning();
    return row ? toPaymentMethodItem(row) : null;
  } catch {
    return null;
  }
}

export async function countAdminBillingPaymentMethods(): Promise<number> {
  if (!hasDatabaseUrl()) return 0;
  try {
    const db = getCunoteDb();
    return (await db.select({ value: count() }).from(schema.billingPaymentMethods))[0]?.value ?? 0;
  } catch {
    return 0;
  }
}

export async function listAdminBillingPaymentMethods(limit = 8): Promise<AdminBillingPaymentMethodItem[]> {
  if (!hasDatabaseUrl()) return [];
  const safeLimit = Math.max(1, Math.min(20, limit));
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({
        id: schema.billingPaymentMethods.id,
        companyId: schema.billingPaymentMethods.companyId,
        provider: schema.billingPaymentMethods.provider,
        providerCustomerId: schema.billingPaymentMethods.providerCustomerId,
        providerPaymentMethodId: schema.billingPaymentMethods.providerPaymentMethodId,
        type: schema.billingPaymentMethods.type,
        brand: schema.billingPaymentMethods.brand,
        last4: schema.billingPaymentMethods.last4,
        expMonth: schema.billingPaymentMethods.expMonth,
        expYear: schema.billingPaymentMethods.expYear,
        holderName: schema.billingPaymentMethods.holderName,
        billingEmail: schema.billingPaymentMethods.billingEmail,
        status: schema.billingPaymentMethods.status,
        isDefault: schema.billingPaymentMethods.isDefault,
        providerPortalUrl: schema.billingPaymentMethods.providerPortalUrl,
        lastUsedAt: schema.billingPaymentMethods.lastUsedAt,
        payload: schema.billingPaymentMethods.payload,
        createdAt: schema.billingPaymentMethods.createdAt,
        updatedAt: schema.billingPaymentMethods.updatedAt,
        companyName: schema.companies.name,
      })
      .from(schema.billingPaymentMethods)
      .leftJoin(schema.companies, eq(schema.companies.id, schema.billingPaymentMethods.companyId))
      .orderBy(desc(schema.billingPaymentMethods.isDefault), desc(schema.billingPaymentMethods.updatedAt))
      .limit(safeLimit);
    return rows.map((row) => ({
      ...toPaymentMethodItem(row),
      companyId: row.companyId,
      companyName: row.companyName ?? "이름 없는 회사",
    }));
  } catch {
    return [];
  }
}

function toPaymentMethodItem(row: typeof schema.billingPaymentMethods.$inferSelect): BillingPaymentMethodItem {
  const item = {
    id: row.id,
    provider: row.provider,
    providerPaymentMethodId: row.providerPaymentMethodId,
    type: row.type,
    brand: row.brand,
    last4: row.last4,
    expMonth: row.expMonth,
    expYear: row.expYear,
    holderName: row.holderName,
    billingEmail: row.billingEmail,
    status: row.status,
    statusLabel: paymentMethodStatusLabel(row.status),
    isDefault: row.isDefault,
    providerPortalUrl: row.providerPortalUrl,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    displayLabel: "",
    expiryLabel: "",
  };
  return {
    ...item,
    displayLabel: paymentMethodDisplayLabel(item),
    expiryLabel: expiryLabel(item.expMonth, item.expYear),
  };
}

export function paymentMethodStatusLabel(status: string): string {
  if (status === "active") return "사용 가능";
  if (status === "requires_action") return "확인 필요";
  if (status === "expired") return "만료";
  if (status === "detached") return "연결 해제";
  if (status === "inactive") return "비활성";
  return status;
}

function paymentMethodDisplayLabel(method: {
  type: string;
  brand: string | null;
  last4: string | null;
}): string {
  if (method.type === "card") {
    const brand = method.brand ? brandLabel(method.brand) : "카드";
    return method.last4 ? `${brand} •••• ${method.last4}` : brand;
  }
  if (method.type === "bank_account") return method.last4 ? `계좌 •••• ${method.last4}` : "계좌";
  return method.last4 ? `${method.type} •••• ${method.last4}` : method.type;
}

function brandLabel(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "카드";
  if (normalized.toLowerCase() === "amex") return "American Express";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function expiryLabel(month: number | null, year: number | null): string {
  if (!month || !year) return "만료일 미확인";
  return `${String(month).padStart(2, "0")}/${String(year).slice(-2)}`;
}

function normalizePaymentMethodStatus(value: string | null): string {
  if (!value) return "active";
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (["active", "requires_action", "expired", "detached", "inactive"].includes(normalized)) return normalized;
  return normalized.slice(0, 40);
}

function normalizeType(value: string | null): string {
  if (!value) return "card";
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 40);
  return normalized || "card";
}

function normalizeText(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeLast4(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "").slice(-4);
  return digits.length > 0 ? digits : null;
}

function normalizeMonth(value: number | null): number | null {
  if (!value || value < 1 || value > 12) return null;
  return Math.trunc(value);
}

function normalizeYear(value: number | null): number | null {
  if (!value || value < 2000 || value > 2200) return null;
  return Math.trunc(value);
}

function validUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function redactPaymentPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactObject(payload);
}

function redactObject(payload: Record<string, unknown>): Record<string, unknown> {
  const safePayload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/card(number|_number)?|cvc|cvv|token|secret|client_secret/i.test(key)) {
      safePayload[key] = "[redacted]";
      continue;
    }
    if (Array.isArray(value)) {
      safePayload[key] = value.map(redactValue);
      continue;
    }
    safePayload[key] = redactValue(value);
  }
  return safePayload;
}

function redactValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}
