import { getAdminSql } from "@/lib/server/db/client";
import type { AdminSession } from "@/lib/server/auth/adminSession";

export interface BillingSubscriptionSnapshot {
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  status: string;
  planCode: string;
  planName: string;
  priceLabel: string;
  renewalLabel: string;
  seatLimit: number;
  autoBillingEnabled: boolean;
  invoicesEnabled: boolean;
  paymentMethodManaged: boolean;
  providerPortalUrl: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  updatedAt: string;
  persisted: boolean;
}

export interface BillingSubscriptionUpdateResult {
  companyId: string;
  persisted: boolean;
  updatedAt: string;
  subscription: BillingSubscriptionSnapshot;
}

interface BillingSubscriptionRow {
  id: string;
  company_id: string;
  provider: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  status: string;
  plan_code: string;
  plan_name: string;
  price_label: string;
  renewal_label: string;
  seat_limit: number;
  auto_billing_enabled: boolean;
  invoices_enabled: boolean;
  payment_method_managed: boolean;
  provider_portal_url: string | null;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  metadata: Record<string, unknown>;
  updated_at: Date;
}

export class BillingSubscriptionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "BillingSubscriptionError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const DEFAULT_SNAPSHOT: Omit<BillingSubscriptionSnapshot, "updatedAt" | "persisted"> = {
  provider: "manual",
  providerCustomerId: null,
  providerSubscriptionId: null,
  status: "early_access",
  planCode: "early_access",
  planName: "Early Access",
  priceLabel: "월 0원",
  renewalLabel: "결제 연동 전",
  seatLimit: 5,
  autoBillingEnabled: false,
  invoicesEnabled: false,
  paymentMethodManaged: false,
  providerPortalUrl: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
};

export async function updateBillingSubscription(input: {
  companyId: string;
  admin: AdminSession;
  provider?: unknown;
  providerCustomerId?: unknown;
  providerSubscriptionId?: unknown;
  status?: unknown;
  planCode?: unknown;
  planName?: unknown;
  priceLabel?: unknown;
  renewalLabel?: unknown;
  seatLimit?: unknown;
  autoBillingEnabled?: unknown;
  invoicesEnabled?: unknown;
  paymentMethodManaged?: unknown;
  providerPortalUrl?: unknown;
  trialEndsAt?: unknown;
  currentPeriodEnd?: unknown;
}): Promise<BillingSubscriptionUpdateResult> {
  const companyId = normalizeUuid(input.companyId, "companyId");
  const now = new Date();
  const patch = normalizePatch(input);
  const sql = getAdminSql();

  const companies = await sql<{ id: string }[]>`
    select id from companies where id = ${companyId} limit 1
  `;
  if (!companies[0]) {
    throw new BillingSubscriptionError("company_not_found", "회사를 찾지 못했습니다.", 404, "companyId");
  }

  const existingRows = await sql<BillingSubscriptionRow[]>`
    select *
    from billing_subscriptions
    where company_id = ${companyId}
    limit 1
  `;
  const existing = existingRows[0];
  const base = existing ? rowToSnapshot(existing, true) : {
    ...DEFAULT_SNAPSHOT,
    updatedAt: now.toISOString(),
    persisted: false,
  };
  const next = mergeSnapshot(base, patch, now.toISOString(), true);
  const metadata = {
    ...(existing?.metadata ?? {}),
    lastAdminUpdate: {
      adminUserId: input.admin.user.id,
      adminEmail: input.admin.user.email,
      adminRole: input.admin.user.role,
      at: now.toISOString(),
      source: "ops_admin",
    },
  };

  const rows = await sql<BillingSubscriptionRow[]>`
    insert into billing_subscriptions (
      company_id,
      provider,
      provider_customer_id,
      provider_subscription_id,
      status,
      plan_code,
      plan_name,
      price_label,
      renewal_label,
      seat_limit,
      auto_billing_enabled,
      invoices_enabled,
      payment_method_managed,
      provider_portal_url,
      trial_ends_at,
      current_period_end,
      metadata,
      updated_by,
      updated_at
    )
    values (
      ${companyId},
      ${next.provider},
      ${next.providerCustomerId},
      ${next.providerSubscriptionId},
      ${next.status},
      ${next.planCode},
      ${next.planName},
      ${next.priceLabel},
      ${next.renewalLabel},
      ${next.seatLimit},
      ${next.autoBillingEnabled},
      ${next.invoicesEnabled},
      ${next.paymentMethodManaged},
      ${next.providerPortalUrl},
      ${dateOrNull(next.trialEndsAt)},
      ${dateOrNull(next.currentPeriodEnd)},
      ${JSON.stringify(metadata)}::jsonb,
      null,
      ${now}
    )
    on conflict (company_id)
    do update set
      provider = excluded.provider,
      provider_customer_id = excluded.provider_customer_id,
      provider_subscription_id = excluded.provider_subscription_id,
      status = excluded.status,
      plan_code = excluded.plan_code,
      plan_name = excluded.plan_name,
      price_label = excluded.price_label,
      renewal_label = excluded.renewal_label,
      seat_limit = excluded.seat_limit,
      auto_billing_enabled = excluded.auto_billing_enabled,
      invoices_enabled = excluded.invoices_enabled,
      payment_method_managed = excluded.payment_method_managed,
      provider_portal_url = excluded.provider_portal_url,
      trial_ends_at = excluded.trial_ends_at,
      current_period_end = excluded.current_period_end,
      metadata = excluded.metadata,
      updated_by = null,
      updated_at = excluded.updated_at
    returning *
  `;

  const row = rows[0];
  if (!row) {
    throw new BillingSubscriptionError("billing_subscription_update_failed", "구독 상태를 저장하지 못했습니다.", 500);
  }

  return {
    companyId,
    persisted: true,
    updatedAt: row.updated_at.toISOString(),
    subscription: rowToSnapshot(row, true),
  };
}

function normalizePatch(input: Record<string, unknown>): Partial<BillingSubscriptionSnapshot> {
  const patch: Partial<BillingSubscriptionSnapshot> = {};
  assignIfProvided(patch, "provider", optionalText(input.provider, 60));
  assignIfProvided(patch, "providerCustomerId", optionalNullableText(input.providerCustomerId, 160));
  assignIfProvided(patch, "providerSubscriptionId", optionalNullableText(input.providerSubscriptionId, 160));
  assignIfProvided(patch, "status", optionalText(input.status, 80));
  assignIfProvided(patch, "planCode", optionalText(input.planCode, 80));
  assignIfProvided(patch, "planName", optionalText(input.planName, 120));
  assignIfProvided(patch, "priceLabel", optionalText(input.priceLabel, 120));
  assignIfProvided(patch, "renewalLabel", optionalText(input.renewalLabel, 120));
  assignIfProvided(patch, "seatLimit", optionalInteger(input.seatLimit, "seatLimit"));
  assignIfProvided(patch, "autoBillingEnabled", optionalBoolean(input.autoBillingEnabled, "autoBillingEnabled"));
  assignIfProvided(patch, "invoicesEnabled", optionalBoolean(input.invoicesEnabled, "invoicesEnabled"));
  assignIfProvided(patch, "paymentMethodManaged", optionalBoolean(input.paymentMethodManaged, "paymentMethodManaged"));
  assignIfProvided(patch, "providerPortalUrl", optionalNullableText(input.providerPortalUrl, 500));
  assignIfProvided(patch, "trialEndsAt", optionalDate(input.trialEndsAt, "trialEndsAt"));
  assignIfProvided(patch, "currentPeriodEnd", optionalDate(input.currentPeriodEnd, "currentPeriodEnd"));
  return patch;
}

function mergeSnapshot(
  base: BillingSubscriptionSnapshot,
  patch: Partial<BillingSubscriptionSnapshot>,
  updatedAt: string,
  persisted: boolean,
): BillingSubscriptionSnapshot {
  return {
    ...base,
    ...dropUndefined(patch),
    updatedAt,
    persisted,
  };
}

function rowToSnapshot(row: BillingSubscriptionRow, persisted: boolean): BillingSubscriptionSnapshot {
  return {
    provider: row.provider,
    providerCustomerId: row.provider_customer_id,
    providerSubscriptionId: row.provider_subscription_id,
    status: row.status,
    planCode: row.plan_code,
    planName: row.plan_name,
    priceLabel: row.price_label,
    renewalLabel: row.renewal_label,
    seatLimit: row.seat_limit,
    autoBillingEnabled: row.auto_billing_enabled,
    invoicesEnabled: row.invoices_enabled,
    paymentMethodManaged: row.payment_method_managed,
    providerPortalUrl: row.provider_portal_url,
    trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    persisted,
  };
}

function normalizeUuid(value: string, field: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  throw new BillingSubscriptionError("invalid_uuid", "식별자 형식을 확인해주세요.", 400, field);
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function optionalNullableText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10000) {
    throw new BillingSubscriptionError("invalid_integer", "숫자 값을 확인해주세요.", 400, field);
  }
  return Math.trunc(parsed);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BillingSubscriptionError("invalid_boolean", "참/거짓 값을 확인해주세요.", 400, field);
}

function optionalDate(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new BillingSubscriptionError("invalid_date", "날짜 값을 확인해주세요.", 400, field);
  }
  return date.toISOString();
}

function dateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as Partial<T>;
}

function assignIfProvided<K extends keyof BillingSubscriptionSnapshot>(
  patch: Partial<BillingSubscriptionSnapshot>,
  key: K,
  value: BillingSubscriptionSnapshot[K] | undefined,
) {
  if (value !== undefined) patch[key] = value;
}
