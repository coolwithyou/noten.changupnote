import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess, type CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession, type WebSession } from "@/lib/server/auth/session";
import {
  submitSupportTicket,
  type SupportTicketCategory,
  type SupportTicketReceipt,
} from "@/lib/server/support/supportTickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORY_VALUES: SupportTicketCategory[] = ["product", "account", "privacy", "billing", "bug"];

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = requiredString(body.email, "email", 160);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return actionError("invalid_email", "답변을 받을 이메일을 확인해주세요.", "email", 400);
    }
    const category = categoryValue(body.category);
    const subject = requiredString(body.subject, "subject", 120);
    const message = requiredString(body.message, "message", 4000);
    if (message.length < 10) {
      return actionError("message_too_short", "문의 내용을 10자 이상 입력해주세요.", "message", 400);
    }
    const [session, access] = await Promise.all([
      getOptionalWebSession(),
      optionalCompanyAccess(),
    ]);
    const receipt = await submitSupportTicket({
      email,
      name: optionalString(body.name, 80),
      category,
      subject,
      message,
      access,
      session,
      metadata: {
        userAgent: request.headers.get("user-agent"),
        referrer: request.headers.get("referer"),
      },
    });

    return NextResponse.json<ActionResult<SupportTicketReceipt>>(
      { ok: true, data: receipt },
      { status: receipt.persisted ? 201 : 202 },
    );
  } catch (error) {
    if (error instanceof SupportTicketValidationError) {
      return actionError(error.code, error.message, error.field, 400);
    }
    return actionError("support_ticket_failed", "문의를 접수하지 못했습니다.", undefined, 500);
  }
}

async function optionalCompanyAccess(): Promise<CompanyAccess | null> {
  try {
    return await requireCompanyAccess();
  } catch {
    return null;
  }
}

function categoryValue(value: unknown): SupportTicketCategory {
  if (typeof value === "string" && CATEGORY_VALUES.includes(value as SupportTicketCategory)) {
    return value as SupportTicketCategory;
  }
  throw new SupportTicketValidationError("invalid_category", "문의 유형을 선택해주세요.", "category");
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  const result = optionalString(value, maxLength);
  if (!result) throw new SupportTicketValidationError("required_field", "필수 입력값을 확인해주세요.", field);
  return result;
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function actionError(code: string, message: string, field?: string, status = 400) {
  return NextResponse.json<ActionResult<null>>({
    ok: false,
    error: {
      code,
      message,
      ...(field ? { field } : {}),
    },
  }, { status });
}

class SupportTicketValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "SupportTicketValidationError";
  }
}
