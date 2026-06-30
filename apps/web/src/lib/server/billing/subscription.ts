import { count, desc, eq } from "drizzle-orm";
import type { AdminAccess } from "@/lib/server/auth/adminGuard";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export type BillingSubscriptionStatus =
  | "early_access"
  | "trialing"
  | "active"
  | "manual_review"
  | "past_due"
  | "paused"
  | "canceled";

export interface BillingSubscriptionSnapshot {
  source: "database" | "environment" | "early_access";
  sourceLabel: string;
  persisted: boolean;
  provider: string;
  providerLabel: string;
  providerConfigured: boolean;
  status: BillingSubscriptionStatus;
  statusLabel: string;
  planCode: string;
  planName: string;
  priceLabel: string;
  renewalLabel: string;
  seatLimit: number;
  included: string[];
  nextSteps: string[];
  paymentMethodLabel: string;
  invoiceStatusLabel: string;
  providerPortalUrl: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  updatedAt: string | null;
  automation: {
    autoBillingEnabled: boolean;
    invoicesEnabled: boolean;
    paymentMethodManaged: boolean;
  };
}

export interface BillingSubscriptionUpdateResult {
  companyId: string;
  persisted: boolean;
  updatedAt: string;
  subscription: BillingSubscriptionSnapshot;
}

export interface AdminBillingSubscriptionItem {
  companyId: string;
  companyName: string;
  status: BillingSubscriptionStatus;
  statusLabel: string;
  planName: string;
  providerLabel: string;
  autoBillingEnabled: boolean;
  invoicesEnabled: boolean;
  seatLimit: number;
  updatedAt: string;
}

type BillingSubscriptionRow = typeof schema.billingSubscriptions.$inferSelect;

const DEFAULT_INCLUDED = [
  "지원사업 매칭과 로드맵",
  "신청 파이프라인",
  "AI 초안 작성과 Markdown export",
  "사업자 검증과 동의 관리",
];

const DEFAULT_NEXT_STEPS = [
  "유료 플랜은 팀 좌석, 대량 초안, 서식 export가 붙는 시점에 분리합니다.",
  "현재 결제 정보는 수집하지 않고, 필요 시 고객지원으로 전환 상담을 연결합니다.",
];

const ACTIVE_NEXT_STEPS = [
  "청구 주기와 좌석 변경은 운영팀 상담 또는 provider 포털에서 확인합니다.",
  "결제 실패, 영수증, 세금계산서 관련 문의는 고객지원으로 접수합니다.",
];

export class BillingSubscriptionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "BillingSubscriptionError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

export function getBillingSubscriptionSnapshot(): BillingSubscriptionSnapshot {
  return getEnvironmentBillingSubscriptionSnapshot();
}

export async function loadBillingSubscriptionSnapshot(input: {
  access: CompanyAccess;
}): Promise<BillingSubscriptionSnapshot> {
  const fallback = getEnvironmentBillingSubscriptionSnapshot();
  if (input.access.mode === "demo" || !hasDatabaseUrl()) return fallback;

  try {
    const db = getCunoteDb();
    const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.companyId, input.access.companyId))
      .limit(1));
    return row ? rowToSnapshot(row, fallback) : fallback;
  } catch {
    return fallback;
  }
}

export async function updateBillingSubscription(input: {
  companyId: string;
  admin: AdminAccess;
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
  const patch = normalizePatch(input);
  const now = new Date();
  const fallback = mergeSnapshot(getEnvironmentBillingSubscriptionSnapshot(), patch, now.toISOString(), false);

  if (!hasDatabaseUrl()) {
    return {
      companyId,
      persisted: false,
      updatedAt: now.toISOString(),
      subscription: fallback,
    };
  }

  try {
    const db = getCunoteDb();
    const [existing] = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.companyId, companyId))
      .limit(1);
    const base = existing ? rowToSnapshot(existing, getEnvironmentBillingSubscriptionSnapshot()) : getEnvironmentBillingSubscriptionSnapshot();
    const next = mergeSnapshot(base, patch, now.toISOString(), true);
    const values = snapshotToRowValues({
      companyId,
      snapshot: next,
      patch,
      source: "admin_flywheel",
      actorUserId: input.admin.userId,
      actorMode: input.admin.mode,
      now,
    });
    const row = existing
      ? await updateExistingBillingSubscription(existing.id, values)
      : await insertBillingSubscription(values);
    return {
      companyId,
      persisted: true,
      updatedAt: row.updatedAt.toISOString(),
      subscription: rowToSnapshot(row, getEnvironmentBillingSubscriptionSnapshot()),
    };
  } catch {
    return {
      companyId,
      persisted: false,
      updatedAt: now.toISOString(),
      subscription: fallback,
    };
  }
}

export async function syncBillingSubscriptionFromWebhook(input: {
  companyId: string;
  provider: unknown;
  eventId: string;
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
  const patch = normalizePatch(input);
  const now = new Date();
  const fallback = mergeSnapshot(getEnvironmentBillingSubscriptionSnapshot(), patch, now.toISOString(), false);

  if (!hasDatabaseUrl()) {
    return {
      companyId,
      persisted: false,
      updatedAt: now.toISOString(),
      subscription: fallback,
    };
  }

  try {
    const db = getCunoteDb();
    const [existing] = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.companyId, companyId))
      .limit(1);
    const base = existing ? rowToSnapshot(existing, getEnvironmentBillingSubscriptionSnapshot()) : getEnvironmentBillingSubscriptionSnapshot();
    const next = mergeSnapshot(base, patch, now.toISOString(), true);
    const values = snapshotToRowValues({
      companyId,
      snapshot: next,
      patch,
      source: "billing_webhook",
      actorUserId: input.eventId,
      actorMode: "webhook",
      now,
    });
    const row = existing
      ? await updateExistingBillingSubscription(existing.id, values)
      : await insertBillingSubscription(values);
    return {
      companyId,
      persisted: true,
      updatedAt: row.updatedAt.toISOString(),
      subscription: rowToSnapshot(row, getEnvironmentBillingSubscriptionSnapshot()),
    };
  } catch {
    return {
      companyId,
      persisted: false,
      updatedAt: now.toISOString(),
      subscription: fallback,
    };
  }
}

export async function countAdminBillingSubscriptions(): Promise<number> {
  if (!hasDatabaseUrl()) return 0;
  try {
    const db = getCunoteDb();
    return (await db.select({ value: count() }).from(schema.billingSubscriptions))[0]?.value ?? 0;
  } catch {
    return 0;
  }
}

export async function listAdminBillingSubscriptions(limit = 8): Promise<AdminBillingSubscriptionItem[]> {
  if (!hasDatabaseUrl()) return [];
  const safeLimit = Math.max(1, Math.min(20, limit));
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({
        companyId: schema.billingSubscriptions.companyId,
        companyName: schema.companies.name,
        provider: schema.billingSubscriptions.provider,
        status: schema.billingSubscriptions.status,
        planName: schema.billingSubscriptions.planName,
        seatLimit: schema.billingSubscriptions.seatLimit,
        autoBillingEnabled: schema.billingSubscriptions.autoBillingEnabled,
        invoicesEnabled: schema.billingSubscriptions.invoicesEnabled,
        updatedAt: schema.billingSubscriptions.updatedAt,
      })
      .from(schema.billingSubscriptions)
      .leftJoin(schema.companies, eq(schema.companies.id, schema.billingSubscriptions.companyId))
      .orderBy(desc(schema.billingSubscriptions.updatedAt))
      .limit(safeLimit);
    return rows.map((row) => {
      const status = normalizeStatus(row.status) ?? "manual_review";
      const provider = providerInfo(row.provider);
      return {
        companyId: row.companyId,
        companyName: row.companyName ?? "이름 없는 회사",
        status,
        statusLabel: subscriptionStatusLabel(status),
        planName: row.planName,
        providerLabel: provider.label,
        autoBillingEnabled: row.autoBillingEnabled,
        invoicesEnabled: row.invoicesEnabled,
        seatLimit: row.seatLimit,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  } catch {
    return [];
  }
}

export function subscriptionStatusLabel(status: BillingSubscriptionStatus): string {
  if (status === "active") return "활성";
  if (status === "trialing") return "체험 중";
  if (status === "manual_review") return "운영 확인";
  if (status === "past_due") return "결제 확인 필요";
  if (status === "paused") return "일시 중지";
  if (status === "canceled") return "해지됨";
  return "Early Access";
}

function getEnvironmentBillingSubscriptionSnapshot(): BillingSubscriptionSnapshot {
  const provider = resolveBillingProvider();
  const hasBillingEnv = hasAnyBillingEnv();
  const status = normalizeStatus(env("CUNOTE_BILLING_SUBSCRIPTION_STATUS"))
    ?? (provider.configured ? "manual_review" : "early_access");
  const automation = {
    autoBillingEnabled: booleanEnv("CUNOTE_BILLING_AUTO_BILLING_ENABLED"),
    invoicesEnabled: booleanEnv("CUNOTE_BILLING_INVOICES_ENABLED"),
    paymentMethodManaged: booleanEnv("CUNOTE_BILLING_PAYMENT_METHOD_MANAGED"),
  };
  const source: BillingSubscriptionSnapshot["source"] = hasBillingEnv || provider.configured
    ? "environment"
    : "early_access";

  return completeSnapshot({
    source,
    sourceLabel: source === "environment" ? "운영 설정" : "Early Access 기본값",
    persisted: false,
    provider: provider.key,
    providerLabel: provider.label,
    providerConfigured: provider.configured,
    status,
    planCode: env("CUNOTE_BILLING_PLAN_CODE") ?? "early_access",
    planName: env("CUNOTE_BILLING_PLAN_NAME") ?? "Early Access",
    priceLabel: env("CUNOTE_BILLING_PRICE_LABEL") ?? "월 0원",
    renewalLabel: env("CUNOTE_BILLING_RENEWAL_LABEL") ?? "결제 연동 전",
    seatLimit: positiveIntEnv("CUNOTE_BILLING_SEAT_LIMIT") ?? 5,
    included: listEnv("CUNOTE_BILLING_INCLUDED_FEATURES", DEFAULT_INCLUDED),
    nextSteps: status === "active" || status === "trialing"
      ? listEnv("CUNOTE_BILLING_NEXT_STEPS", ACTIVE_NEXT_STEPS)
      : listEnv("CUNOTE_BILLING_NEXT_STEPS", DEFAULT_NEXT_STEPS),
    paymentMethodLabel: automation.paymentMethodManaged
      ? `${provider.label}에서 결제 수단을 관리합니다.`
      : "결제 연동 전이라 카드 정보를 보관하지 않습니다.",
    invoiceStatusLabel: automation.invoicesEnabled
      ? `${provider.label} 청구서/영수증 발행 설정이 켜져 있습니다.`
      : "아직 발행된 청구서는 없습니다.",
    providerPortalUrl: urlEnv("CUNOTE_BILLING_PROVIDER_PORTAL_URL"),
    trialEndsAt: dateEnv("CUNOTE_BILLING_TRIAL_ENDS_AT"),
    currentPeriodEnd: dateEnv("CUNOTE_BILLING_CURRENT_PERIOD_END"),
    updatedAt: null,
    automation,
  });
}

function rowToSnapshot(row: BillingSubscriptionRow, fallback: BillingSubscriptionSnapshot): BillingSubscriptionSnapshot {
  const provider = providerInfo(row.provider);
  const status = normalizeStatus(row.status) ?? fallback.status;
  const automation = {
    autoBillingEnabled: row.autoBillingEnabled,
    invoicesEnabled: row.invoicesEnabled,
    paymentMethodManaged: row.paymentMethodManaged,
  };

  return completeSnapshot({
    source: "database",
    sourceLabel: "DB 저장 상태",
    persisted: true,
    provider: provider.key,
    providerLabel: provider.label,
    providerConfigured: provider.configured,
    status,
    planCode: row.planCode,
    planName: row.planName,
    priceLabel: row.priceLabel,
    renewalLabel: row.renewalLabel,
    seatLimit: row.seatLimit,
    included: fallback.included,
    nextSteps: status === "active" || status === "trialing" ? ACTIVE_NEXT_STEPS : fallback.nextSteps,
    paymentMethodLabel: automation.paymentMethodManaged
      ? `${provider.label}에서 결제 수단을 관리합니다.`
      : "결제 연동 전이라 카드 정보를 보관하지 않습니다.",
    invoiceStatusLabel: automation.invoicesEnabled
      ? `${provider.label} 청구서/영수증 발행 설정이 켜져 있습니다.`
      : "아직 발행된 청구서는 없습니다.",
    providerPortalUrl: validUrl(row.providerPortalUrl),
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    automation,
  });
}

function completeSnapshot(input: Omit<BillingSubscriptionSnapshot, "statusLabel">): BillingSubscriptionSnapshot {
  return {
    ...input,
    statusLabel: subscriptionStatusLabel(input.status),
  };
}

function mergeSnapshot(
  base: BillingSubscriptionSnapshot,
  patch: NormalizedPatch,
  updatedAt: string,
  persisted: boolean,
): BillingSubscriptionSnapshot {
  const provider = patch.provider ? providerInfo(patch.provider) : providerInfo(base.provider);
  const status = patch.status ?? base.status;
  const automation = {
    autoBillingEnabled: patch.autoBillingEnabled ?? base.automation.autoBillingEnabled,
    invoicesEnabled: patch.invoicesEnabled ?? base.automation.invoicesEnabled,
    paymentMethodManaged: patch.paymentMethodManaged ?? base.automation.paymentMethodManaged,
  };
  return completeSnapshot({
    ...base,
    source: persisted ? "database" : base.source,
    sourceLabel: persisted ? "DB 저장 상태" : base.sourceLabel,
    persisted,
    provider: provider.key,
    providerLabel: provider.label,
    providerConfigured: provider.configured,
    status,
    planCode: patch.planCode ?? base.planCode,
    planName: patch.planName ?? base.planName,
    priceLabel: patch.priceLabel ?? base.priceLabel,
    renewalLabel: patch.renewalLabel ?? base.renewalLabel,
    seatLimit: patch.seatLimit ?? base.seatLimit,
    included: base.included,
    nextSteps: status === "active" || status === "trialing" ? ACTIVE_NEXT_STEPS : base.nextSteps,
    paymentMethodLabel: automation.paymentMethodManaged
      ? `${provider.label}에서 결제 수단을 관리합니다.`
      : "결제 연동 전이라 카드 정보를 보관하지 않습니다.",
    invoiceStatusLabel: automation.invoicesEnabled
      ? `${provider.label} 청구서/영수증 발행 설정이 켜져 있습니다.`
      : "아직 발행된 청구서는 없습니다.",
    providerPortalUrl: patch.providerPortalUrl.provided ? patch.providerPortalUrl.value : base.providerPortalUrl,
    trialEndsAt: patch.trialEndsAt.provided ? patch.trialEndsAt.value?.toISOString() ?? null : base.trialEndsAt,
    currentPeriodEnd: patch.currentPeriodEnd.provided ? patch.currentPeriodEnd.value?.toISOString() ?? null : base.currentPeriodEnd,
    updatedAt,
    automation,
  });
}

interface NormalizedPatch {
  provider?: string;
  providerCustomerId: OptionalString;
  providerSubscriptionId: OptionalString;
  status?: BillingSubscriptionStatus;
  planCode?: string;
  planName?: string;
  priceLabel?: string;
  renewalLabel?: string;
  seatLimit?: number;
  autoBillingEnabled?: boolean;
  invoicesEnabled?: boolean;
  paymentMethodManaged?: boolean;
  providerPortalUrl: OptionalString;
  trialEndsAt: OptionalDate;
  currentPeriodEnd: OptionalDate;
}

interface OptionalString {
  provided: boolean;
  value: string | null;
}

interface OptionalDate {
  provided: boolean;
  value: Date | null;
}

function normalizePatch(input: {
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
}): NormalizedPatch {
  const status = normalizeOptionalStatus(input.status);
  return {
    ...(input.provider !== undefined ? { provider: normalizeText(input.provider, "provider", 40) } : {}),
    providerCustomerId: normalizeOptionalString(input.providerCustomerId, "providerCustomerId", 120),
    providerSubscriptionId: normalizeOptionalString(input.providerSubscriptionId, "providerSubscriptionId", 120),
    ...(status ? { status } : {}),
    ...(input.planCode !== undefined ? { planCode: normalizeText(input.planCode, "planCode", 80) } : {}),
    ...(input.planName !== undefined ? { planName: normalizeText(input.planName, "planName", 80) } : {}),
    ...(input.priceLabel !== undefined ? { priceLabel: normalizeText(input.priceLabel, "priceLabel", 80) } : {}),
    ...(input.renewalLabel !== undefined ? { renewalLabel: normalizeText(input.renewalLabel, "renewalLabel", 80) } : {}),
    ...(input.seatLimit !== undefined ? { seatLimit: normalizeSeatLimit(input.seatLimit) } : {}),
    ...(input.autoBillingEnabled !== undefined ? { autoBillingEnabled: normalizeBoolean(input.autoBillingEnabled, "autoBillingEnabled") } : {}),
    ...(input.invoicesEnabled !== undefined ? { invoicesEnabled: normalizeBoolean(input.invoicesEnabled, "invoicesEnabled") } : {}),
    ...(input.paymentMethodManaged !== undefined ? { paymentMethodManaged: normalizeBoolean(input.paymentMethodManaged, "paymentMethodManaged") } : {}),
    providerPortalUrl: normalizeOptionalUrl(input.providerPortalUrl, "providerPortalUrl"),
    trialEndsAt: normalizeOptionalDate(input.trialEndsAt, "trialEndsAt"),
    currentPeriodEnd: normalizeOptionalDate(input.currentPeriodEnd, "currentPeriodEnd"),
  };
}

function snapshotToRowValues(input: {
  companyId: string;
  snapshot: BillingSubscriptionSnapshot;
  patch: NormalizedPatch;
  source: "admin_flywheel" | "billing_webhook";
  actorUserId: string;
  actorMode: string;
  now: Date;
}) {
  return {
    companyId: input.companyId,
    provider: input.snapshot.provider,
    providerCustomerId: input.patch.providerCustomerId.provided ? input.patch.providerCustomerId.value : undefined,
    providerSubscriptionId: input.patch.providerSubscriptionId.provided ? input.patch.providerSubscriptionId.value : undefined,
    status: input.snapshot.status,
    planCode: input.snapshot.planCode,
    planName: input.snapshot.planName,
    priceLabel: input.snapshot.priceLabel,
    renewalLabel: input.snapshot.renewalLabel,
    seatLimit: input.snapshot.seatLimit,
    autoBillingEnabled: input.snapshot.automation.autoBillingEnabled,
    invoicesEnabled: input.snapshot.automation.invoicesEnabled,
    paymentMethodManaged: input.snapshot.automation.paymentMethodManaged,
    providerPortalUrl: input.snapshot.providerPortalUrl,
    trialEndsAt: input.snapshot.trialEndsAt ? new Date(input.snapshot.trialEndsAt) : null,
    currentPeriodEnd: input.snapshot.currentPeriodEnd ? new Date(input.snapshot.currentPeriodEnd) : null,
    metadata: {
      lastSource: input.source,
      lastActorId: input.actorUserId,
      lastActorMode: input.actorMode,
      updatedAt: input.now.toISOString(),
    },
    updatedBy: uuidOrNull(input.actorUserId),
    updatedAt: input.now,
    createdAt: input.now,
  };
}

async function insertBillingSubscription(values: ReturnType<typeof snapshotToRowValues>): Promise<BillingSubscriptionRow> {
  const db = getCunoteDb();
  const [row] = await db
    .insert(schema.billingSubscriptions)
    .values({
      ...values,
      providerCustomerId: values.providerCustomerId ?? null,
      providerSubscriptionId: values.providerSubscriptionId ?? null,
    })
    .returning();
  if (!row) throw new BillingSubscriptionError("billing_subscription_insert_failed", "구독 상태를 저장하지 못했습니다.", 500);
  return row;
}

async function updateExistingBillingSubscription(
  id: string,
  values: ReturnType<typeof snapshotToRowValues>,
): Promise<BillingSubscriptionRow> {
  const db = getCunoteDb();
  const [row] = await db
    .update(schema.billingSubscriptions)
    .set({
      provider: values.provider,
      ...(values.providerCustomerId !== undefined ? { providerCustomerId: values.providerCustomerId } : {}),
      ...(values.providerSubscriptionId !== undefined ? { providerSubscriptionId: values.providerSubscriptionId } : {}),
      status: values.status,
      planCode: values.planCode,
      planName: values.planName,
      priceLabel: values.priceLabel,
      renewalLabel: values.renewalLabel,
      seatLimit: values.seatLimit,
      autoBillingEnabled: values.autoBillingEnabled,
      invoicesEnabled: values.invoicesEnabled,
      paymentMethodManaged: values.paymentMethodManaged,
      providerPortalUrl: values.providerPortalUrl,
      trialEndsAt: values.trialEndsAt,
      currentPeriodEnd: values.currentPeriodEnd,
      metadata: values.metadata,
      updatedBy: values.updatedBy,
      updatedAt: values.updatedAt,
    })
    .where(eq(schema.billingSubscriptions.id, id))
    .returning();
  if (!row) throw new BillingSubscriptionError("billing_subscription_update_failed", "구독 상태를 저장하지 못했습니다.", 500);
  return row;
}

function resolveBillingProvider(): {
  key: string;
  label: string;
  configured: boolean;
} {
  const configured = env("CUNOTE_BILLING_PROVIDER");
  if (configured) return providerInfo(configured);
  if (env("TOSS_PAYMENTS_SECRET_KEY")) {
    return { key: "toss_payments", label: "Toss Payments", configured: true };
  }
  if (env("STRIPE_SECRET_KEY")) {
    return { key: "stripe", label: "Stripe", configured: true };
  }
  return { key: "none", label: "미연동", configured: false };
}

function providerInfo(value: string): {
  key: string;
  label: string;
  configured: boolean;
} {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_") || "none";
  if (key === "toss" || key === "toss_payments") return { key: "toss_payments", label: "Toss Payments", configured: true };
  if (key === "stripe") return { key: "stripe", label: "Stripe", configured: true };
  if (key === "manual") return { key: "manual", label: "운영팀 수동 관리", configured: false };
  if (key === "none") return { key: "none", label: "미연동", configured: false };
  return { key, label: value.trim(), configured: true };
}

function normalizeOptionalStatus(value: unknown): BillingSubscriptionStatus | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new BillingSubscriptionError("invalid_billing_subscription_status", "구독 상태를 확인해주세요.", 400, "status");
  }
  const status = normalizeStatus(value);
  if (!status) {
    throw new BillingSubscriptionError("invalid_billing_subscription_status", "구독 상태를 확인해주세요.", 400, "status");
  }
  return status;
}

function normalizeStatus(value: string | null): BillingSubscriptionStatus | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "early_access"
    || normalized === "trialing"
    || normalized === "active"
    || normalized === "manual_review"
    || normalized === "past_due"
    || normalized === "paused"
    || normalized === "canceled"
  ) {
    return normalized;
  }
  return null;
}

function hasAnyBillingEnv(): boolean {
  return [
    "CUNOTE_BILLING_SUBSCRIPTION_STATUS",
    "CUNOTE_BILLING_PLAN_CODE",
    "CUNOTE_BILLING_PLAN_NAME",
    "CUNOTE_BILLING_PRICE_LABEL",
    "CUNOTE_BILLING_RENEWAL_LABEL",
    "CUNOTE_BILLING_SEAT_LIMIT",
    "CUNOTE_BILLING_PROVIDER_PORTAL_URL",
    "CUNOTE_BILLING_TRIAL_ENDS_AT",
    "CUNOTE_BILLING_CURRENT_PERIOD_END",
  ].some((key) => Boolean(env(key)));
}

function listEnv(key: string, fallback: string[]): string[] {
  const raw = env(key);
  if (!raw) return fallback;
  const items = raw
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new BillingSubscriptionError("invalid_billing_subscription_field", "구독 상태 입력값을 확인해주세요.", 400, field);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BillingSubscriptionError("required_billing_subscription_field", "구독 상태 입력값을 확인해주세요.", 400, field);
  }
  return trimmed.slice(0, maxLength);
}

function normalizeOptionalString(value: unknown, field: string, maxLength: number): OptionalString {
  if (value === undefined) return { provided: false, value: null };
  if (value === null || value === "") return { provided: true, value: null };
  if (typeof value !== "string") {
    throw new BillingSubscriptionError("invalid_billing_subscription_field", "구독 상태 입력값을 확인해주세요.", 400, field);
  }
  const trimmed = value.trim();
  return { provided: true, value: trimmed ? trimmed.slice(0, maxLength) : null };
}

function normalizeOptionalUrl(value: unknown, field: string): OptionalString {
  const normalized = normalizeOptionalString(value, field, 500);
  if (!normalized.value) return normalized;
  const valid = validUrl(normalized.value);
  if (!valid) {
    throw new BillingSubscriptionError("invalid_billing_subscription_url", "provider 포털 URL을 확인해주세요.", 400, field);
  }
  return { provided: true, value: valid };
}

function normalizeOptionalDate(value: unknown, field: string): OptionalDate {
  if (value === undefined) return { provided: false, value: null };
  if (value === null || value === "") return { provided: true, value: null };
  if (typeof value !== "string") {
    throw new BillingSubscriptionError("invalid_billing_subscription_date", "구독 날짜를 확인해주세요.", 400, field);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BillingSubscriptionError("invalid_billing_subscription_date", "구독 날짜를 확인해주세요.", 400, field);
  }
  return { provided: true, value: date };
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  }
  throw new BillingSubscriptionError("invalid_billing_subscription_boolean", "구독 boolean 값을 확인해주세요.", 400, field);
}

function normalizeSeatLimit(value: unknown): number {
  const limit = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    throw new BillingSubscriptionError("invalid_billing_subscription_seat_limit", "좌석 한도는 1 이상 1000 이하로 입력해주세요.", 400, "seatLimit");
  }
  return Math.floor(limit);
}

function positiveIntEnv(key: string): number | null {
  const raw = env(key);
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function booleanEnv(key: string): boolean {
  const raw = env(key)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function urlEnv(key: string): string | null {
  return validUrl(env(key));
}

function validUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function dateEnv(key: string): string | null {
  const value = env(key);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BillingSubscriptionError("invalid_billing_subscription_company", "회사 ID를 확인해주세요.", 400, field);
  }
  return value;
}

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
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
