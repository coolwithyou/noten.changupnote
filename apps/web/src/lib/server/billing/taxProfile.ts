import { count, desc, eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface BillingTaxProfileItem {
  id: string | null;
  companyId: string;
  businessName: string | null;
  businessRegistrationNumberMasked: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  taxInvoiceEmail: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  postalCode: string | null;
  taxInvoiceEnabled: boolean;
  notes: string | null;
  source: "database" | "company" | "empty";
  updatedAt: string | null;
}

export interface BillingTaxProfileUpdateResult {
  persisted: boolean;
  profile: BillingTaxProfileItem;
}

export interface AdminBillingTaxProfileItem extends BillingTaxProfileItem {
  companyName: string;
}

export class BillingTaxProfileError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "BillingTaxProfileError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

export async function loadBillingTaxProfile(input: {
  access: CompanyAccess;
  session?: WebSession | null;
}): Promise<BillingTaxProfileItem> {
  const fallback = await fallbackProfile(input);
  if (input.access.mode === "demo" || !hasDatabaseUrl()) return fallback;
  try {
    const db = getCunoteDb();
    const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select()
      .from(schema.billingTaxProfiles)
      .where(eq(schema.billingTaxProfiles.companyId, input.access.companyId))
      .limit(1));
    return row ? rowToProfile(row, input.access.companyId, "database") : fallback;
  } catch {
    return fallback;
  }
}

export async function updateBillingTaxProfile(input: {
  access: CompanyAccess;
  session?: WebSession | null;
  businessName: unknown;
  businessRegistrationNumber: unknown;
  recipientName: unknown;
  recipientEmail: unknown;
  recipientPhone: unknown;
  taxInvoiceEmail: unknown;
  billingAddressLine1: unknown;
  billingAddressLine2: unknown;
  postalCode: unknown;
  taxInvoiceEnabled: unknown;
  notes: unknown;
}): Promise<BillingTaxProfileUpdateResult> {
  const normalized = normalizeProfileInput(input);
  const now = new Date();
  const fallback: BillingTaxProfileItem = {
    id: null,
    companyId: input.access.companyId,
    businessName: normalized.businessName,
    businessRegistrationNumberMasked: maskBusinessRegistrationNumber(normalized.businessRegistrationNumber),
    recipientName: normalized.recipientName,
    recipientEmail: normalized.recipientEmail,
    recipientPhone: normalized.recipientPhone,
    taxInvoiceEmail: normalized.taxInvoiceEmail,
    billingAddressLine1: normalized.billingAddressLine1,
    billingAddressLine2: normalized.billingAddressLine2,
    postalCode: normalized.postalCode,
    taxInvoiceEnabled: normalized.taxInvoiceEnabled,
    notes: normalized.notes,
    source: "empty",
    updatedAt: now.toISOString(),
  };
  if (input.access.mode === "demo" || !hasDatabaseUrl()) {
    return {
      persisted: false,
      profile: fallback,
    };
  }

  try {
    const db = getCunoteDb();
    const [existing] = await db
      .select()
      .from(schema.billingTaxProfiles)
      .where(eq(schema.billingTaxProfiles.companyId, input.access.companyId))
      .limit(1);
    const businessRegistrationNumber = normalized.businessRegistrationNumber
      ?? existing?.businessRegistrationNumber
      ?? null;
    const values = {
      companyId: input.access.companyId,
      ...normalized,
      businessRegistrationNumber,
      metadata: {
        lastSource: "web_billing_tax_profile",
        updatedByRole: input.access.role,
        updatedByMode: input.access.mode,
      },
      updatedBy: input.access.userId,
      updatedAt: now,
    };
    const [row] = existing
      ? await db
        .update(schema.billingTaxProfiles)
        .set(values)
        .where(eq(schema.billingTaxProfiles.id, existing.id))
        .returning()
      : await db
        .insert(schema.billingTaxProfiles)
        .values({ ...values, createdAt: now })
        .returning();
    if (!row) {
      throw new BillingTaxProfileError("billing_tax_profile_save_failed", "청구 프로필을 저장하지 못했습니다.", 500);
    }
    return {
      persisted: true,
      profile: rowToProfile(row, input.access.companyId, "database"),
    };
  } catch (error) {
    if (error instanceof BillingTaxProfileError) throw error;
    return {
      persisted: false,
      profile: fallback,
    };
  }
}

export async function countAdminBillingTaxProfiles(): Promise<number> {
  if (!hasDatabaseUrl()) return 0;
  try {
    const db = getCunoteDb();
    return (await db.select({ value: count() }).from(schema.billingTaxProfiles))[0]?.value ?? 0;
  } catch {
    return 0;
  }
}

export async function listAdminBillingTaxProfiles(limit = 8): Promise<AdminBillingTaxProfileItem[]> {
  if (!hasDatabaseUrl()) return [];
  const safeLimit = Math.max(1, Math.min(20, limit));
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({
        id: schema.billingTaxProfiles.id,
        companyId: schema.billingTaxProfiles.companyId,
        businessName: schema.billingTaxProfiles.businessName,
        businessRegistrationNumber: schema.billingTaxProfiles.businessRegistrationNumber,
        recipientName: schema.billingTaxProfiles.recipientName,
        recipientEmail: schema.billingTaxProfiles.recipientEmail,
        recipientPhone: schema.billingTaxProfiles.recipientPhone,
        taxInvoiceEmail: schema.billingTaxProfiles.taxInvoiceEmail,
        billingAddressLine1: schema.billingTaxProfiles.billingAddressLine1,
        billingAddressLine2: schema.billingTaxProfiles.billingAddressLine2,
        postalCode: schema.billingTaxProfiles.postalCode,
        taxInvoiceEnabled: schema.billingTaxProfiles.taxInvoiceEnabled,
        notes: schema.billingTaxProfiles.notes,
        metadata: schema.billingTaxProfiles.metadata,
        updatedBy: schema.billingTaxProfiles.updatedBy,
        createdAt: schema.billingTaxProfiles.createdAt,
        updatedAt: schema.billingTaxProfiles.updatedAt,
        companyName: schema.companies.name,
      })
      .from(schema.billingTaxProfiles)
      .leftJoin(schema.companies, eq(schema.companies.id, schema.billingTaxProfiles.companyId))
      .orderBy(desc(schema.billingTaxProfiles.updatedAt))
      .limit(safeLimit);
    return rows.map((row) => ({
      ...rowToProfile(row, row.companyId, "database"),
      companyName: row.companyName ?? "이름 없는 회사",
    }));
  } catch {
    return [];
  }
}

async function fallbackProfile(input: {
  access: CompanyAccess;
  session?: WebSession | null;
}): Promise<BillingTaxProfileItem> {
  const company = await loadCompanyFallback(input.access.companyId);
  return {
    id: null,
    companyId: input.access.companyId,
    businessName: company.name,
    businessRegistrationNumberMasked: maskBusinessRegistrationNumber(company.bizNo),
    recipientName: input.session?.user.name ?? null,
    recipientEmail: input.session?.user.email ?? null,
    recipientPhone: null,
    taxInvoiceEmail: input.session?.user.email ?? null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    postalCode: null,
    taxInvoiceEnabled: false,
    notes: null,
    source: company.name || company.bizNo ? "company" : "empty",
    updatedAt: null,
  };
}

async function loadCompanyFallback(companyId: string): Promise<{ name: string | null; bizNo: string | null }> {
  if (!hasDatabaseUrl()) return { name: null, bizNo: null };
  try {
    const [row] = await getCunoteDb()
      .select({
        name: schema.companies.name,
        bizNo: schema.companies.bizNo,
      })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    return {
      name: row?.name ?? null,
      bizNo: row?.bizNo ?? null,
    };
  } catch {
    return { name: null, bizNo: null };
  }
}

function rowToProfile(
  row: typeof schema.billingTaxProfiles.$inferSelect,
  companyId: string,
  source: BillingTaxProfileItem["source"],
): BillingTaxProfileItem {
  return {
    id: row.id,
    companyId,
    businessName: row.businessName,
    businessRegistrationNumberMasked: maskBusinessRegistrationNumber(row.businessRegistrationNumber),
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    recipientPhone: row.recipientPhone,
    taxInvoiceEmail: row.taxInvoiceEmail,
    billingAddressLine1: row.billingAddressLine1,
    billingAddressLine2: row.billingAddressLine2,
    postalCode: row.postalCode,
    taxInvoiceEnabled: row.taxInvoiceEnabled,
    notes: row.notes,
    source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeProfileInput(input: {
  businessName: unknown;
  businessRegistrationNumber: unknown;
  recipientName: unknown;
  recipientEmail: unknown;
  recipientPhone: unknown;
  taxInvoiceEmail: unknown;
  billingAddressLine1: unknown;
  billingAddressLine2: unknown;
  postalCode: unknown;
  taxInvoiceEnabled: unknown;
  notes: unknown;
}) {
  const recipientEmail = normalizeEmail(input.recipientEmail, "recipientEmail", false);
  const taxInvoiceEmail = normalizeEmail(input.taxInvoiceEmail, "taxInvoiceEmail", false);
  return {
    businessName: normalizeText(input.businessName, "businessName", 120, false),
    businessRegistrationNumber: normalizeBusinessRegistrationNumber(input.businessRegistrationNumber),
    recipientName: normalizeText(input.recipientName, "recipientName", 80, false),
    recipientEmail,
    recipientPhone: normalizePhone(input.recipientPhone, "recipientPhone"),
    taxInvoiceEmail: taxInvoiceEmail ?? recipientEmail,
    billingAddressLine1: normalizeText(input.billingAddressLine1, "billingAddressLine1", 160, false),
    billingAddressLine2: normalizeText(input.billingAddressLine2, "billingAddressLine2", 160, false),
    postalCode: normalizePostalCode(input.postalCode),
    taxInvoiceEnabled: normalizeBoolean(input.taxInvoiceEnabled),
    notes: normalizeText(input.notes, "notes", 500, false),
  };
}

function normalizeText(value: unknown, field: string, maxLength: number, required: boolean): string | null {
  if (value === null || value === undefined) {
    if (required) throw new BillingTaxProfileError("billing_tax_profile_required", "필수 값을 입력해주세요.", 400, field);
    return null;
  }
  if (typeof value !== "string") {
    throw new BillingTaxProfileError("billing_tax_profile_invalid_text", "문자열로 입력해주세요.", 400, field);
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    if (required) throw new BillingTaxProfileError("billing_tax_profile_required", "필수 값을 입력해주세요.", 400, field);
    return null;
  }
  if (normalized.length > maxLength) {
    throw new BillingTaxProfileError("billing_tax_profile_too_long", `${maxLength}자 이하로 입력해주세요.`, 400, field);
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new BillingTaxProfileError("billing_tax_profile_invalid_text", "제어 문자를 포함할 수 없습니다.", 400, field);
  }
  return normalized;
}

function normalizeEmail(value: unknown, field: string, required: boolean): string | null {
  const normalized = normalizeText(value, field, 160, required);
  if (!normalized) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new BillingTaxProfileError("billing_tax_profile_invalid_email", "이메일 형식을 확인해주세요.", 400, field);
  }
  return normalized.toLowerCase();
}

function normalizePhone(value: unknown, field: string): string | null {
  const normalized = normalizeText(value, field, 40, false);
  if (!normalized) return null;
  if (!/^[0-9+\-\s()]+$/.test(normalized)) {
    throw new BillingTaxProfileError("billing_tax_profile_invalid_phone", "전화번호 형식을 확인해주세요.", 400, field);
  }
  return normalized;
}

function normalizePostalCode(value: unknown): string | null {
  const normalized = normalizeText(value, "postalCode", 20, false);
  if (!normalized) return null;
  return normalized.replace(/\s+/g, "");
}

function normalizeBusinessRegistrationNumber(value: unknown): string | null {
  const normalized = normalizeText(value, "businessRegistrationNumber", 20, false);
  if (!normalized) return null;
  const digits = normalized.replace(/\D/g, "");
  if (digits.length !== 10) {
    throw new BillingTaxProfileError("billing_tax_profile_invalid_biz_no", "사업자등록번호 10자리를 입력해주세요.", 400, "businessRegistrationNumber");
  }
  return digits;
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
  }
  return false;
}

function maskBusinessRegistrationNumber(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 10) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-*****`;
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}
