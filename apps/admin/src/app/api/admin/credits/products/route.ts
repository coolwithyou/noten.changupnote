import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { getAdminSql } from "@/lib/server/db/client";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProductRow {
  id: string;
  code: string;
  name: string;
  amount_krw: number;
  credits: string;
  bonus_credits: string;
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
    const products = await sql<ProductRow[]>`
      SELECT * FROM credit_products ORDER BY display_order, created_at
    `;
    return adminData({ products });
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
    const amountKrw = typeof body.amountKrw === "number" ? body.amountKrw : null;
    const credits = typeof body.credits === "number" ? body.credits : null;
    const bonusCredits = typeof body.bonusCredits === "number" ? body.bonusCredits : null;
    const isActive = typeof body.isActive === "boolean" ? body.isActive : null;
    const displayOrder = typeof body.displayOrder === "number" ? body.displayOrder : null;

    if (!code) return adminError("invalid_request", "code는 필수입니다.", 400, "code");
    if (!name) return adminError("invalid_request", "name은 필수입니다.", 400, "name");
    if (amountKrw === null) return adminError("invalid_request", "amountKrw는 필수입니다.", 400, "amountKrw");
    if (credits === null) return adminError("invalid_request", "credits는 필수입니다.", 400, "credits");

    const sql = getAdminSql();

    const createdRows = await sql<ProductRow[]>`
      INSERT INTO credit_products
        (code, name, amount_krw, credits, bonus_credits, is_active, display_order)
      VALUES (
        ${code}, ${name}, ${amountKrw}, ${credits},
        ${bonusCredits ?? 0}, ${isActive ?? true}, ${displayOrder ?? 0}
      )
      RETURNING *
    `;
    const created = createdRows[0];
    if (!created) {
      return adminError("credits_error", "상품 생성에 실패했습니다.", 500);
    }

    await insertCreditAuditLog({
      action: "product.created",
      actorSession: session,
      targetType: "product",
      targetId: created.id,
      after: created as unknown as Record<string, unknown>,
      reason: null,
    });

    return adminData({ product: created });
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
    requireAdminRole(session, "admin");

    const body = await readJson(request);

    const id = typeof body.id === "string" ? body.id : null;
    const name = typeof body.name === "string" ? body.name : undefined;
    const amountKrw = typeof body.amountKrw === "number" ? body.amountKrw : undefined;
    const credits = typeof body.credits === "number" ? body.credits : undefined;
    const bonusCredits = typeof body.bonusCredits === "number" ? body.bonusCredits : undefined;
    const isActive = typeof body.isActive === "boolean" ? body.isActive : undefined;
    const displayOrder = typeof body.displayOrder === "number" ? body.displayOrder : undefined;

    if (!id) return adminError("invalid_request", "id는 필수입니다.", 400, "id");

    const sql = getAdminSql();

    const beforeRows = await sql<ProductRow[]>`
      SELECT * FROM credit_products WHERE id = ${id}
    `;
    const before = beforeRows[0] ?? null;
    if (!before) {
      return adminError("product_not_found", "해당 상품을 찾을 수 없습니다.", 404, "id");
    }

    const updatedRows = await sql<ProductRow[]>`
      UPDATE credit_products SET
        name = ${name ?? before.name},
        amount_krw = ${amountKrw ?? before.amount_krw},
        credits = ${credits ?? before.credits},
        bonus_credits = ${bonusCredits ?? before.bonus_credits},
        is_active = ${isActive ?? before.is_active},
        display_order = ${displayOrder ?? before.display_order},
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    const updated = updatedRows[0];
    if (!updated) {
      return adminError("credits_error", "상품 수정에 실패했습니다.", 500);
    }

    await insertCreditAuditLog({
      action: "product.updated",
      actorSession: session,
      targetType: "product",
      targetId: id,
      before: before as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
      reason: null,
    });

    return adminData({ product: updated });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
