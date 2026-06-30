import { randomUUID } from "node:crypto";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { getOutboundEmailProviderStatus, sendOutboundEmail, type OutboundEmailDeliveryResult } from "@/lib/server/email/outboundEmail";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";
import {
  renderSupportTicketIntakeEmailText,
  SUPPORT_TICKET_INTAKE_EMAIL_TAG,
  supportTicketIntakeEmailSubject,
} from "./supportTicketIntakeEmailHandoff";

export type SupportTicketCategory = "product" | "account" | "privacy" | "billing" | "bug";

export interface SubmitSupportTicketInput {
  email: string;
  name?: string | null;
  category: SupportTicketCategory;
  subject: string;
  message: string;
  access?: CompanyAccess | null;
  session?: WebSession | null;
  metadata?: Record<string, unknown>;
}

export interface SupportTicketReceipt {
  id: string;
  status: "open" | "queued";
  receivedAt: string;
  persisted: boolean;
  emailDelivery: OutboundEmailDeliveryResult;
}

export async function submitSupportTicket(input: SubmitSupportTicketInput): Promise<SupportTicketReceipt> {
  const now = new Date();
  if (!hasDatabaseUrl()) {
    const receipt = fallbackReceipt(now);
    return withEmailDelivery(receipt, input);
  }

  try {
    const db = getCunoteDb();
    const [row] = await db.insert(schema.supportTickets).values({
      companyId: input.access?.companyId ?? null,
      userId: input.session?.user.id ?? input.access?.userId ?? null,
      email: input.email,
      name: input.name,
      category: input.category,
      subject: input.subject,
      message: input.message,
      status: "open",
      priority: priorityFor(input.category),
      source: "web",
      metadata: {
        mode: input.access?.mode ?? "public",
        sessionProvider: input.session?.provider ?? null,
        ...input.metadata,
      },
      createdAt: now,
      updatedAt: now,
    }).returning({
      id: schema.supportTickets.id,
      status: schema.supportTickets.status,
      createdAt: schema.supportTickets.createdAt,
    });
    if (!row) return withEmailDelivery(fallbackReceipt(now), input);
    return withEmailDelivery({
      id: row.id,
      status: row.status === "open" ? "open" : "queued",
      receivedAt: row.createdAt.toISOString(),
      persisted: true,
      emailDelivery: skippedEmailDelivery(),
    }, input);
  } catch {
    return withEmailDelivery(fallbackReceipt(now), input);
  }
}

function priorityFor(category: SupportTicketCategory): "normal" | "high" {
  return category === "privacy" || category === "bug" ? "high" : "normal";
}

function fallbackReceipt(now: Date): SupportTicketReceipt {
  return {
    id: `queued-${randomUUID()}`,
    status: "queued",
    receivedAt: now.toISOString(),
    persisted: false,
    emailDelivery: skippedEmailDelivery(),
  };
}

async function withEmailDelivery(
  receipt: SupportTicketReceipt,
  input: SubmitSupportTicketInput,
): Promise<SupportTicketReceipt> {
  return {
    ...receipt,
    emailDelivery: await deliverSupportTicketIntakeEmail({ receipt, input }),
  };
}

async function deliverSupportTicketIntakeEmail(input: {
  receipt: SupportTicketReceipt;
  input: SubmitSupportTicketInput;
}): Promise<OutboundEmailDeliveryResult> {
  const legal = getLegalConfig();
  try {
    return await sendOutboundEmail({
      message: {
        to: { email: legal.supportEmail, name: "창업노트 고객지원" },
        from: { email: input.input.email, name: input.input.name ?? "창업노트 문의자" },
        replyTo: { email: input.input.email },
        subject: supportTicketIntakeEmailSubject(input.input),
        text: renderSupportTicketIntakeEmailText({
          category: input.input.category,
          email: input.input.email,
          name: input.input.name ?? null,
          subject: input.input.subject,
          message: input.input.message,
          ticketId: input.receipt.id,
          generatedAt: new Date(input.receipt.receivedAt),
        }),
        tags: [SUPPORT_TICKET_INTAKE_EMAIL_TAG],
      },
    });
  } catch (error) {
    if (error instanceof Error && "result" in error) {
      const result = (error as { result?: OutboundEmailDeliveryResult }).result;
      if (result) return result;
    }
    return { ...getOutboundEmailProviderStatus(), status: "failed" };
  }
}

function skippedEmailDelivery(): OutboundEmailDeliveryResult {
  return { ...getOutboundEmailProviderStatus(), status: "skipped" };
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}
