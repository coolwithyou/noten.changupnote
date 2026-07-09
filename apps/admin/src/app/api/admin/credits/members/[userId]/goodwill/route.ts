import type { NextRequest } from "next/server";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { getNumericSetting } from "@/lib/server/credits/settings";
import { applyAdminGrant } from "@/lib/server/credits/grantTx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GOODWILL_EXPIRY_DAYS = 90;

interface RouteContext {
  params: Promise<{ userId: string }>;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "support");

    const { userId } = await context.params;
    if (!userId) return adminError("invalid_route_param", "요청 경로를 확인해주세요.", 400);

    const body = await readJson(request);
    const credits = typeof body.credits === "number" ? body.credits : NaN;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const ticketRef = typeof body.ticketRef === "string" ? body.ticketRef.trim() : "";
    const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";

    // 1. reason / ticketRef / nonce 필수
    if (!reason) return adminError("reason_required", "사유를 입력해주세요.", 400, "reason");
    if (!ticketRef) return adminError("ticket_ref_required", "티켓 번호를 입력해주세요.", 400, "ticketRef");
    if (!nonce) return adminError("nonce_required", "요청 식별자가 필요합니다.", 400, "nonce");
    if (!Number.isInteger(credits) || credits <= 0) {
      return adminError("invalid_credits", "크레딧은 양의 정수여야 합니다.", 400, "credits");
    }

    const sql = getAdminSql();

    // 2. 티켓당 상한
    const ticketCap = await getNumericSetting("support_grant_ticket_cap", 1_000);
    if (credits > ticketCap) {
      return adminError("ticket_cap_exceeded", `티켓당 지급 한도(${ticketCap})를 초과했습니다.`, 400, "credits");
    }

    // 3. 당일 이 admin의 goodwill 총량 상한
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dailyCap = await getNumericSetting("support_grant_daily_cap", 2_000);
    const todayRows = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(amount_credits),0)::text as total
      FROM credit_ledger
      WHERE actor_id = ${session.user.id}
        AND entry_type = 'promo_grant'
        AND created_at >= ${todayStart}
    `;
    const todayTotal = Number(todayRows[0]?.total ?? "0");
    if (todayTotal + credits > dailyCap) {
      return adminError("daily_cap_exceeded", `당일 지급 한도(${dailyCap})를 초과했습니다.`, 400, "credits");
    }

    // 4. 자기계정 하드차단
    const selfRows = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${session.user.email}
    `;
    if (selfRows[0]?.id === userId) {
      return adminError("self_grant_forbidden", "본인 계정에는 지급할 수 없습니다.", 403);
    }

    const grantReason = `${reason} (ticket: ${ticketRef})`;

    // 5. promo_grant 분개
    const result = await sql.begin(async (tx) =>
      applyAdminGrant(tx, {
        userId,
        credits,
        reason: grantReason,
        expiryDays: GOODWILL_EXPIRY_DAYS,
        nonce,
        actorId: session.user.id,
        entryType: "promo_grant",
        lotSource: "promo",
      }),
    );

    if (!result.idempotent) {
      await insertCreditAuditLog({
        action: "ledger.admin_grant",
        actorSession: session,
        targetType: "user",
        targetId: userId,
        after: { credits, ticketRef, entryId: result.entryId },
        reason: grantReason,
      });
    }

    return adminData(result);
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    if (error instanceof Error && (error as { code?: string }).code === "wallet_frozen") {
      return adminError("wallet_frozen", error.message, 403);
    }
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
