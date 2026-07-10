import { requireAdminRole, handleRoleError } from "@/lib/server/auth/adminRole";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { getAdminSql } from "@/lib/server/db/client";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";
import { insertCreditAuditLog } from "@/lib/server/credits/auditLog";
import { callWebInternal, WebInternalUnavailableError } from "@/lib/server/credits/webInternalClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");

    const params = new URL(request.url).searchParams;
    const date = params.get("date");

    const sql = getAdminSql();
    const runs = await sql`
      SELECT * FROM credit_reconciliation_runs
      WHERE (${date ?? null}::date IS NULL OR run_date::date = ${date ?? null}::date)
      ORDER BY created_at DESC LIMIT 50
    `;

    return adminData({ runs });
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}

// POST — 수동 재실행(11.8 / 14.3). admin+ 만. 대사 로직은 웹앱 단일 구현 — admin 은 role·audit·호출만
// (9.3 "admin 결제 실행 경로" 패턴). 웹 내부 엔드포인트 POST /api/internal/credits/reconcile 를 호출한다.
// body: { scopes?: string[] } — 미지정이면 5 scope 전부.
export async function POST(request: Request) {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "admin");

    const body = await readJson(request);
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === "string")
      : undefined;

    const result = await callWebInternal<{
      overallStatus: string;
      scopes: Array<{ scope: string; status: string }>;
    }>("/api/internal/credits/reconcile", {
      ...(scopes && scopes.length > 0 ? { scopes } : {}),
      actorId: `admin:${session.user.id}`,
    });

    if (!result.ok) {
      return adminError(result.error?.code ?? "reconcile_failed", result.error?.message ?? "대사 재실행 실패", result.status || 502);
    }

    // 수동 재실행 자체를 감사 기록(누가 언제 대사를 돌렸나).
    await insertCreditAuditLog({
      action: "recon.manual_run",
      actorSession: session,
      targetType: "reconciliation",
      targetId: scopes && scopes.length > 0 ? scopes.join(",") : "all",
      after: {
        overallStatus: result.data?.overallStatus ?? null,
        scopes: result.data?.scopes ?? null,
      },
      reason: "manual reconciliation re-run",
    });

    return adminData(result.data ?? {});
  } catch (error) {
    const roleErr = handleRoleError(error);
    if (roleErr) return roleErr;
    if (error instanceof WebInternalUnavailableError) return adminError(error.code, error.message, error.status);
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    return adminError("credits_error", error instanceof Error ? error.message : "오류가 발생했습니다.", 500);
  }
}
