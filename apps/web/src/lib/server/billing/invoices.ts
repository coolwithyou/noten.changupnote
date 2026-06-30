import { and, count, desc, eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { markdownDownloadResponse, sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";

export interface BillingInvoiceItem {
  id: string;
  provider: string;
  providerInvoiceId: string;
  invoiceNumber: string | null;
  status: string;
  statusLabel: string;
  currency: string;
  amountDue: number;
  amountPaid: number;
  taxAmount: number;
  hostedInvoiceUrl: string | null;
  receiptUrl: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  updatedAt: string;
}

export interface AdminBillingInvoiceItem extends BillingInvoiceItem {
  companyId: string;
  companyName: string;
}

export interface BillingInvoiceReceipt {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export async function listBillingInvoices(input: {
  access: CompanyAccess;
  limit?: number;
}): Promise<BillingInvoiceItem[]> {
  if (input.access.mode === "demo" || !hasDatabaseUrl()) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select()
      .from(schema.billingInvoices)
      .where(eq(schema.billingInvoices.companyId, input.access.companyId))
      .orderBy(desc(schema.billingInvoices.issuedAt), desc(schema.billingInvoices.updatedAt))
      .limit(limit));
    return rows.map(toInvoiceItem);
  } catch {
    return [];
  }
}

export async function upsertBillingInvoiceFromWebhook(input: {
  companyId: string | null;
  provider: string;
  providerInvoiceId: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  invoiceNumber: string | null;
  status: string | null;
  currency: string | null;
  amountDue: number | null;
  amountPaid: number | null;
  taxAmount: number | null;
  hostedInvoiceUrl: string | null;
  receiptUrl: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payload: Record<string, unknown>;
}): Promise<BillingInvoiceItem | null> {
  if (!input.companyId || !input.providerInvoiceId || !hasDatabaseUrl()) return null;
  try {
    const db = getCunoteDb();
    const now = new Date();
    const values = {
      companyId: input.companyId,
      provider: input.provider,
      providerInvoiceId: input.providerInvoiceId,
      providerCustomerId: input.providerCustomerId,
      providerSubscriptionId: input.providerSubscriptionId,
      invoiceNumber: input.invoiceNumber,
      status: normalizeInvoiceStatus(input.status),
      currency: normalizeCurrency(input.currency),
      amountDue: input.amountDue ?? 0,
      amountPaid: input.amountPaid ?? 0,
      taxAmount: input.taxAmount ?? 0,
      hostedInvoiceUrl: input.hostedInvoiceUrl,
      receiptUrl: input.receiptUrl,
      issuedAt: dateOrNull(input.issuedAt),
      dueAt: dateOrNull(input.dueAt),
      paidAt: dateOrNull(input.paidAt),
      periodStart: dateOrNull(input.periodStart),
      periodEnd: dateOrNull(input.periodEnd),
      payload: input.payload,
      updatedAt: now,
    };
    const [existing] = await db
      .select({ id: schema.billingInvoices.id })
      .from(schema.billingInvoices)
      .where(and(
        eq(schema.billingInvoices.provider, input.provider),
        eq(schema.billingInvoices.providerInvoiceId, input.providerInvoiceId),
      ))
      .limit(1);
    const [row] = existing
      ? await db
        .update(schema.billingInvoices)
        .set(values)
        .where(eq(schema.billingInvoices.id, existing.id))
        .returning()
      : await db
        .insert(schema.billingInvoices)
        .values({ ...values, createdAt: now })
        .returning();
    return row ? toInvoiceItem(row) : null;
  } catch (error) {
    if (error instanceof BillingInvoiceError) throw error;
    return null;
  }
}

export async function buildBillingInvoiceReceipt(input: {
  access: CompanyAccess;
  invoiceId: string;
}): Promise<BillingInvoiceReceipt> {
  const invoiceId = normalizeBillingInvoiceId(input.invoiceId);
  const invoice = await loadBillingInvoiceForCompany({ access: input.access, invoiceId });
  if (!invoice) {
    throw new BillingInvoiceError("billing_invoice_not_found", "청구 이력을 찾지 못했습니다.", 404, "invoiceId");
  }
  const label = invoice.invoiceNumber ?? invoice.providerInvoiceId;
  const filenameBase = sanitizeDownloadFilename(label, "청구영수증");
  return {
    filename: `창업노트-${filenameBase}-영수증.md`,
    fallbackFilename: `cunote-billing-receipt-${invoice.id}.md`,
    markdown: renderInvoiceReceipt(invoice),
  };
}

export function billingInvoiceReceiptDownloadResponse(receipt: BillingInvoiceReceipt): Response {
  return markdownDownloadResponse({
    markdown: receipt.markdown,
    filename: receipt.filename,
    fallbackFilename: receipt.fallbackFilename,
  });
}

export async function countAdminBillingInvoices(): Promise<number> {
  if (!hasDatabaseUrl()) return 0;
  try {
    const db = getCunoteDb();
    return (await db.select({ value: count() }).from(schema.billingInvoices))[0]?.value ?? 0;
  } catch {
    return 0;
  }
}

export async function listAdminBillingInvoices(limit = 8): Promise<AdminBillingInvoiceItem[]> {
  if (!hasDatabaseUrl()) return [];
  const safeLimit = Math.max(1, Math.min(20, limit));
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({
        id: schema.billingInvoices.id,
        companyId: schema.billingInvoices.companyId,
        provider: schema.billingInvoices.provider,
        providerInvoiceId: schema.billingInvoices.providerInvoiceId,
        providerCustomerId: schema.billingInvoices.providerCustomerId,
        providerSubscriptionId: schema.billingInvoices.providerSubscriptionId,
        invoiceNumber: schema.billingInvoices.invoiceNumber,
        status: schema.billingInvoices.status,
        currency: schema.billingInvoices.currency,
        amountDue: schema.billingInvoices.amountDue,
        amountPaid: schema.billingInvoices.amountPaid,
        taxAmount: schema.billingInvoices.taxAmount,
        hostedInvoiceUrl: schema.billingInvoices.hostedInvoiceUrl,
        receiptUrl: schema.billingInvoices.receiptUrl,
        issuedAt: schema.billingInvoices.issuedAt,
        dueAt: schema.billingInvoices.dueAt,
        paidAt: schema.billingInvoices.paidAt,
        periodStart: schema.billingInvoices.periodStart,
        periodEnd: schema.billingInvoices.periodEnd,
        payload: schema.billingInvoices.payload,
        createdAt: schema.billingInvoices.createdAt,
        updatedAt: schema.billingInvoices.updatedAt,
        companyName: schema.companies.name,
      })
      .from(schema.billingInvoices)
      .leftJoin(schema.companies, eq(schema.companies.id, schema.billingInvoices.companyId))
      .orderBy(desc(schema.billingInvoices.issuedAt), desc(schema.billingInvoices.updatedAt))
      .limit(safeLimit);
    return rows.map((row) => ({
      ...toInvoiceItem(row),
      companyId: row.companyId,
      companyName: row.companyName ?? "이름 없는 회사",
    }));
  } catch {
    return [];
  }
}

export async function loadBillingInvoiceForCompany(input: {
  access: CompanyAccess;
  invoiceId: string;
}): Promise<BillingInvoiceItem | null> {
  if (input.access.mode === "demo" || !hasDatabaseUrl()) return null;
  try {
    const db = getCunoteDb();
    const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select()
      .from(schema.billingInvoices)
      .where(and(
        eq(schema.billingInvoices.id, input.invoiceId),
        eq(schema.billingInvoices.companyId, input.access.companyId),
      ))
      .limit(1));
    return row ? toInvoiceItem(row) : null;
  } catch (error) {
    if (error instanceof BillingInvoiceError) throw error;
    return null;
  }
}

function toInvoiceItem(row: typeof schema.billingInvoices.$inferSelect): BillingInvoiceItem {
  return {
    id: row.id,
    provider: row.provider,
    providerInvoiceId: row.providerInvoiceId,
    invoiceNumber: row.invoiceNumber,
    status: row.status,
    statusLabel: invoiceStatusLabel(row.status),
    currency: row.currency,
    amountDue: row.amountDue,
    amountPaid: row.amountPaid,
    taxAmount: row.taxAmount,
    hostedInvoiceUrl: row.hostedInvoiceUrl,
    receiptUrl: row.receiptUrl,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    periodStart: row.periodStart?.toISOString() ?? null,
    periodEnd: row.periodEnd?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function renderInvoiceReceipt(invoice: BillingInvoiceItem): string {
  return [
    `# 창업노트 청구 영수증`,
    "",
    `- 청구번호: ${invoice.invoiceNumber ?? invoice.providerInvoiceId}`,
    `- 상태: ${invoice.statusLabel}`,
    `- provider: ${invoice.provider}`,
    `- 발행일: ${formatDate(invoice.issuedAt)}`,
    `- 결제일: ${formatDate(invoice.paidAt)}`,
    `- 결제 금액: ${formatMoney(invoice.amountPaid || invoice.amountDue, invoice.currency)}`,
    `- 부가세/세금: ${formatMoney(invoice.taxAmount, invoice.currency)}`,
    `- 서비스 기간: ${formatDate(invoice.periodStart)} - ${formatDate(invoice.periodEnd)}`,
    "",
    "> 외부 결제 provider에서 수신한 청구 이벤트를 바탕으로 생성한 보관용 문서입니다. 세금계산서와 법정 영수증은 실제 provider 또는 운영팀 발행본을 기준으로 확인해야 합니다.",
    "",
  ].join("\n");
}

export function invoiceStatusLabel(status: string): string {
  if (status === "paid") return "결제 완료";
  if (status === "open") return "청구 대기";
  if (status === "void") return "무효";
  if (status === "uncollectible") return "회수 불가";
  if (status === "draft") return "초안";
  return status;
}

export function formatInvoiceMoney(amount: number, currency: string): string {
  return formatMoney(amount, currency);
}

function formatMoney(amount: number, currency: string): string {
  const safeCurrency = normalizeCurrency(currency);
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: safeCurrency,
    maximumFractionDigits: safeCurrency === "KRW" ? 0 : 2,
  }).format(amount);
}

function normalizeInvoiceStatus(value: string | null): string {
  if (!value) return "draft";
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (["draft", "open", "paid", "void", "uncollectible"].includes(normalized)) return normalized;
  return normalized.slice(0, 40);
}

function normalizeCurrency(value: string | null): string {
  if (!value) return "KRW";
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : "KRW";
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value: string | null): string {
  if (!value) return "해당 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

export function normalizeBillingInvoiceId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BillingInvoiceError("invalid_billing_invoice_id", "청구 이력 ID를 확인해주세요.", 400, "invoiceId");
  }
  return value;
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

export class BillingInvoiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "BillingInvoiceError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}
