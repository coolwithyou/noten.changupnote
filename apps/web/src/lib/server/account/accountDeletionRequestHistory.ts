import { and, desc, eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";

export interface AccountDeletionRequestHistoryItem {
  id: string;
  status: string;
  priority: string;
  email: string;
  subject: string;
  messagePreview: string;
  requestedAt: string;
  updatedAt: string;
  responseDueAt: string | null;
}

export async function listAccountDeletionRequestHistory(input: {
  access: CompanyAccess;
  session: WebSession | null;
  limit?: number;
}): Promise<AccountDeletionRequestHistoryItem[]> {
  if (!hasDatabaseUrl()) return [];
  const limit = Math.max(1, Math.min(10, input.limit ?? 5));

  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select({
        id: schema.supportTickets.id,
        userId: schema.supportTickets.userId,
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
        eq(schema.supportTickets.category, "privacy"),
      ))
      .orderBy(desc(schema.supportTickets.createdAt))
      .limit(30));

    return rows
      .filter((row) =>
        row.metadata.kind === "account_deletion_request"
        && canSeeDeletionRequest(row, input.access, input.session)
      )
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        status: row.status,
        priority: row.priority,
        email: row.email,
        subject: row.subject,
        messagePreview: preview(row.message),
        requestedAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        responseDueAt: dateString(row.metadata.slaDueAt),
      }));
  } catch {
    return [];
  }
}

function canSeeDeletionRequest(
  ticket: {
    userId: string | null;
    email: string;
    metadata: Record<string, unknown>;
  },
  access: CompanyAccess,
  session: WebSession | null,
): boolean {
  const userId = session?.user.id ?? access.userId;
  if (ticket.userId && ticket.userId === userId) return true;
  if (stringValue(ticket.metadata.requestedUserId) === userId) return true;
  const email = session?.user.email?.trim().toLowerCase();
  return Boolean(email && ticket.email.trim().toLowerCase() === email);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}
