import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { submitSupportTicket, type SupportTicketReceipt } from "@/lib/server/support/supportTickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const [access, session, body] = await Promise.all([
      requireCompanyAccess({ permission: "write" }),
      getOptionalWebSession(),
      readBody(request),
    ]);
    const email = session?.user.email?.trim() || optionalString(body.email, 160);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: "email_required",
          message: "삭제 요청 처리 결과를 받을 이메일이 필요합니다.",
          field: "email",
        },
      }, { status: 400 });
    }
    const reason = optionalString(body.reason, 1200);
    const confirmation = optionalString(body.confirmation, 80);
    if (confirmation !== "삭제 요청") {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: "confirmation_required",
          message: "확인 문구를 입력해주세요.",
          field: "confirmation",
        },
      }, { status: 400 });
    }

    const receipt = await submitSupportTicket({
      email,
      name: session?.user.name ?? null,
      category: "privacy",
      subject: "계정 데이터 삭제 요청",
      message: [
        "계정 데이터 삭제 요청이 접수되었습니다.",
        "",
        `요청자: ${session?.user.name ?? "이름 없음"}`,
        `이메일: ${email}`,
        `회사 ID: ${access.companyId}`,
        `사용자 ID: ${session?.user.id ?? access.userId}`,
        "",
        "요청 사유:",
        reason ?? "사유 미입력",
      ].join("\n"),
      access,
      session,
      metadata: {
        kind: "account_deletion_request",
        requestedCompanyId: access.companyId,
        requestedUserId: session?.user.id ?? access.userId,
        confirmation,
        userAgent: request.headers.get("user-agent"),
        referrer: request.headers.get("referer"),
      },
    });

    return NextResponse.json<ActionResult<SupportTicketReceipt>>(
      { ok: true, data: receipt },
      { status: receipt.persisted ? 201 : 202 },
    );
  } catch (error) {
    return webActionError<SupportTicketReceipt>(error, {
      code: "account_deletion_request_failed",
      message: "계정 삭제 요청을 접수하지 못했습니다.",
    });
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}
