import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import { appData, appError } from "@/lib/server/appApi/envelope";
import { getAdminRuntimeStatus } from "@/lib/server/admin/runtimeStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireAdminAccess();
    return appData({
      ok: true,
      role: access.role,
      mode: access.mode,
      surfaces: [
        "extraction_log",
        "feedback",
        "review_queue",
        "match_events",
        "golden_set",
        "eval_runs",
        "grant_insight_snapshots",
        "grant_attachment_archives",
        "support_tickets",
        "billing_subscriptions",
        "billing_tax_profiles",
        "billing_tax_documents",
        "billing_invoices",
        "billing_payment_methods",
        "billing_webhook_events",
        "legal_readiness",
        "saas_readiness",
        "saas_release_checklist",
      ],
      runtime: getAdminRuntimeStatus(),
    });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    return appError("admin_status_failed", error instanceof Error ? error.message : "어드민 상태 확인에 실패했습니다.");
  }
}
