import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PlanRow {
  id: string;
  code: string;
  name: string;
  monthly_price_krw: number;
  monthly_credits: string;
  features: unknown;
  is_active: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");
    const sql = getAdminSql();
    const plans = await sql<PlanRow[]>`
      SELECT * FROM credit_plans ORDER BY display_order
    `;
    return adminData({ plans });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "owner");

    const body = await readJson(request);

    const code = typeof body.code === "string" ? body.code : null;
    const name = typeof body.name === "string" ? body.name : null;
    const monthlyPriceKrw = typeof body.monthlyPriceKrw === "number" ? body.monthlyPriceKrw : null;
    const monthlyCredits = typeof body.monthlyCredits === "number" ? body.monthlyCredits : null;
    const features =
      body.features !== null && typeof body.features === "object" && !Array.isArray(body.features)
        ? (body.features as Record<string, unknown>)
        : null;
    const isActive = typeof body.isActive === "boolean" ? body.isActive : null;
    const displayOrder = typeof body.displayOrder === "number" ? body.displayOrder : null;

    if (!code) return adminError("invalid_request", "code는 필수입니다.", 400, "code");
    if (!name) return adminError("invalid_request", "name은 필수입니다.", 400, "name");
    if (monthlyPriceKrw === null) return adminError("invalid_request", "monthlyPriceKrw는 필수입니다.", 400, "monthlyPriceKrw");
    if (monthlyCredits === null) return adminError("invalid_request", "monthlyCredits는 필수입니다.", 400, "monthlyCredits");

    const sql = getAdminSql();

    const createdRows = await sql<PlanRow[]>`
      INSERT INTO credit_plans
        (code, name, monthly_price_krw, monthly_credits, features, is_active, display_order)
      VALUES (
        ${code}, ${name}, ${monthlyPriceKrw}, ${monthlyCredits},
        ${JSON.stringify(features ?? {})}::jsonb, ${isActive ?? true}, ${displayOrder ?? 0}
      )
      RETURNING *
    `;
    const created = createdRows[0];
    if (!created) {
      return adminError("credits_error", "플랜 생성에 실패했습니다.", 500);
    }

    await insertCreditAuditLog({
      action: "plan.created",
      actorSession: session,
      targetType: "plan",
      targetId: created.id,
      after: created as unknown as Record<string, unknown>,
      reason: null,
    });

    return adminData({ plan: created });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "owner");

    const body = await readJson(request);

    const id = typeof body.id === "string" ? body.id : null;
    const name = typeof body.name === "string" ? body.name : undefined;
    const monthlyPriceKrw = typeof body.monthlyPriceKrw === "number" ? body.monthlyPriceKrw : undefined;
    const monthlyCredits = typeof body.monthlyCredits === "number" ? body.monthlyCredits : undefined;
    const features =
      body.features !== null && typeof body.features === "object" && !Array.isArray(body.features)
        ? (body.features as Record<string, unknown>)
        : undefined;
    const isActive = typeof body.isActive === "boolean" ? body.isActive : undefined;
    const displayOrder = typeof body.displayOrder === "number" ? body.displayOrder : undefined;

    if (!id) return adminError("invalid_request", "id는 필수입니다.", 400, "id");

    const sql = getAdminSql();

    const beforeRows = await sql<PlanRow[]>`
      SELECT * FROM credit_plans WHERE id = ${id}
    `;
    const before = beforeRows[0] ?? null;
    if (!before) {
      return adminError("plan_not_found", "해당 플랜을 찾을 수 없습니다.", 404, "id");
    }

    const updatedRows = await sql<PlanRow[]>`
      UPDATE credit_plans SET
        name = ${name ?? before.name},
        monthly_price_krw = ${monthlyPriceKrw ?? before.monthly_price_krw},
        monthly_credits = ${monthlyCredits ?? before.monthly_credits},
        features = ${features !== undefined ? JSON.stringify(features) : JSON.stringify(before.features)}::jsonb,
        is_active = ${isActive ?? before.is_active},
        display_order = ${displayOrder ?? before.display_order},
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    const updated = updatedRows[0];
    if (!updated) {
      return adminError("credits_error", "플랜 수정에 실패했습니다.", 500);
    }

    await insertCreditAuditLog({
      action: "plan.updated",
      actorSession: session,
      targetType: "plan",
      targetId: id,
      before: before as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
      reason: null,
    });

    return adminData({ plan: updated });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
