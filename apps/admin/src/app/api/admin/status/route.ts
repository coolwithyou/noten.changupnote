import { requireAdminSession, AdminRequiredError } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireAdminSession();
    requireAdminRole(session, "viewer");
    return Response.json({
      data: {
        ok: true,
        app: "cunote-ops",
        host: "ops.changupnote.com",
        auth: {
          provider: session.provider,
          role: session.user.role,
          email: session.user.email,
        },
        sessionBoundary: {
          sharedWithWeb: false,
          cookieName: process.env.ADMIN_SESSION_COOKIE_NAME ?? "__Secure-cunote-admin.session-token",
          allowedGoogleDomain: process.env.ADMIN_ALLOWED_GOOGLE_DOMAIN ?? "noten.im",
        },
        surfaces: [
          "extraction_log",
          "feedback",
          "review_queue",
          "match_events",
          "golden_set",
          "eval_runs",
          "grant_insight_snapshots",
          "grant_attachment_archives",
          "grant_document_drafts",
          "grant_document_draft_quality_events",
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
          "support_ticket_report",
          "live_match",
          "audit_dispatch_batches",
          "audit_dispatch_notices",
          "audit_dispatch_items",
        ],
        runtime: {
          authRequired: true,
          app: "apps/admin",
          sharedWithWeb: false,
          opsOrigin: process.env.ADMIN_AUTH_URL ?? process.env.NEXTAUTH_URL ?? "https://ops.changupnote.com",
        },
      },
    });
  } catch (error) {
    if (error instanceof AdminRequiredError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    return Response.json({
      error: {
        code: "admin_status_failed",
        message: error instanceof Error ? error.message : "어드민 상태 확인에 실패했습니다.",
      },
    }, { status: 500 });
  }
}
