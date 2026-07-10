// 일일 대사 cron (설계 14.1 / 9.2). 일 1회 05:00 KST.
//
// 5 scope(ledger_wallet / lot_ledger / holds / portone_orders / admin_activity)를 각각 실행해
// credit_reconciliation_runs 에 scope 별로 기록(ok/mismatch/error + summary 상세). mismatch 시
// audit_log(recon.mismatch). 회사 멤버 급증(13.1)은 usage.anomaly audit 도 기록.
//
// scope 4(portone_orders)는 포트원 클라이언트 주입형 — 키 미설정 시 이 scope 만 error 로 기록하고 나머지 진행.
// ★ 이 cron 은 읽기 + recon_runs INSERT + audit INSERT 만 한다. 원장 변이 없음(대사는 관찰자).
//
// 시스템 경로(user 컨텍스트 없음, 4.13): CRON_SECRET Bearer 로 보호.
import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/server/auth/cronAuth";
import { getCunoteDb } from "@/lib/server/db/client";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { runReconciliation } from "@/lib/server/credits/reconciliationService";
import { loadReconcileThresholds } from "@/lib/server/credits/reconcileSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const db = getCunoteDb();

  try {
    const portone = getPortoneClient();
    const thresholds = await loadReconcileThresholds(db);

    const { results, overallStatus } = await runReconciliation(db, {
      portone: portone.isConfigured() ? portone : null,
      actorId: "system:reconcile-cron",
      adminGrantAlertThreshold: thresholds.adminGrantAlertThreshold,
      companyNewMemberWindowDays: thresholds.companyNewMemberWindowDays,
      companyNewMemberThreshold: thresholds.companyNewMemberThreshold,
    });

    return NextResponse.json({
      ok: true,
      summary: {
        overallStatus,
        scopes: results.map((r) => ({ scope: r.scope, status: r.status })),
      },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "reconcile_failed",
          message: error instanceof Error ? error.message : "대사 실행에 실패했습니다.",
        },
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}
