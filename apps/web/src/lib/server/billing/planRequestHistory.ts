import { and, desc, eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface BillingPlanRequestHistoryItem {
  id: string;
  status: string;
  priority: string;
  desiredPlan: string | null;
  billingCycle: string | null;
  seatCount: number | null;
  email: string;
  subject: string;
  messagePreview: string;
  requestedAt: string;
  updatedAt: string;
}

export interface BillingPlanRequestDetail extends BillingPlanRequestHistoryItem {
  name: string | null;
  message: string;
}

export class BillingPlanRequestHistoryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "BillingPlanRequestHistoryError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export async function listBillingPlanRequestHistory(input: {
  access: CompanyAccess;
  session: WebSession | null;
  limit?: number;
}): Promise<BillingPlanRequestHistoryItem[]> {
  if (!hasDatabaseUrl()) return [];
  const limit = Math.max(1, Math.min(10, input.limit ?? 5));

  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select({
        id: schema.supportTickets.id,
        status: schema.supportTickets.status,
        priority: schema.supportTickets.priority,
        email: schema.supportTickets.email,
        subject: schema.supportTickets.subject,
        message: schema.supportTickets.message,
        metadata: schema.supportTickets.metadata,
        createdAt: schema.supportTickets.createdAt,
        updatedAt: schema.supportTickets.updatedAt,
      })
      .from(schema.supportTickets)
      .where(and(
        eq(schema.supportTickets.companyId, input.access.companyId),
        eq(schema.supportTickets.category, "billing"),
      ))
      .orderBy(desc(schema.supportTickets.createdAt))
      .limit(30));

    return rows
      .filter((row) => row.metadata.kind === "billing_plan_request")
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        status: row.status,
        priority: row.priority,
        desiredPlan: stringValue(row.metadata.desiredPlan),
        billingCycle: stringValue(row.metadata.billingCycle),
        seatCount: numberValue(row.metadata.seatCount),
        email: row.email,
        subject: row.subject,
        messagePreview: preview(row.message),
        requestedAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
  } catch {
    return [];
  }
}

export async function loadBillingPlanRequestForCompany(input: {
  access: CompanyAccess;
  requestId: string;
}): Promise<BillingPlanRequestDetail | null> {
  if (!uuidOrNull(input.requestId)) {
    throw new BillingPlanRequestHistoryError("invalid_billing_plan_request_id", "플랜 전환 요청 번호를 확인해주세요.", 400, "requestId");
  }
  if (!hasDatabaseUrl()) return null;

  const db = getCunoteDb();
  const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
    .select({
      id: schema.supportTickets.id,
      status: schema.supportTickets.status,
      priority: schema.supportTickets.priority,
      email: schema.supportTickets.email,
      name: schema.supportTickets.name,
      subject: schema.supportTickets.subject,
      message: schema.supportTickets.message,
      metadata: schema.supportTickets.metadata,
      createdAt: schema.supportTickets.createdAt,
      updatedAt: schema.supportTickets.updatedAt,
    })
    .from(schema.supportTickets)
    .where(and(
      eq(schema.supportTickets.id, input.requestId),
      eq(schema.supportTickets.companyId, input.access.companyId),
      eq(schema.supportTickets.category, "billing"),
    ))
    .limit(1));

  if (!row || row.metadata.kind !== "billing_plan_request") return null;
  return {
    id: row.id,
    status: row.status,
    priority: row.priority,
    desiredPlan: stringValue(row.metadata.desiredPlan),
    billingCycle: stringValue(row.metadata.billingCycle),
    seatCount: numberValue(row.metadata.seatCount),
    email: row.email,
    name: row.name,
    subject: row.subject,
    message: row.message,
    messagePreview: preview(row.message),
    requestedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 100 ? `${compact.slice(0, 97)}...` : compact;
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

function uuidOrNull(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}
