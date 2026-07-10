// POST /api/internal/credits/reconcile (설계 14.3 수동 재실행 + 9.3 "admin 결제 실행 경로")
//
// admin(apps/admin) 의 11.8 재실행 버튼 → 서버 간 시크릿으로만 이 엔드포인트를 호출한다. 대사 로직은
// 웹앱에 단일 구현으로 존재하고(reconciliationService), admin 은 role(admin+)·audit·호출만 담당한다.
//
// body: { scopes?: string[], actorId?: string }
//   scopes 미지정이면 5 scope 전부. 지정 시 해당 scope 만 즉시 실행(동일 로직).
//   actorId: 실행 admin 식별자(recon.mismatch audit 의 actor 로 기록).
//
// ★ 원장 변이 없음. 읽기 + recon_runs INSERT + audit INSERT 만.
// 인증: authorizeInternalRequest(INTERNAL_API_SECRET). 미설정·불일치 시 401.
import { NextResponse } from "next/server";
import { authorizeInternalRequest } from "@/lib/server/auth/internalAuth";
import { getCunoteDb } from "@/lib/server/db/client";
import { getPortoneClient } from "@/lib/server/payments/portone";
import { runReconciliation } from "@/lib/server/credits/reconciliationService";
import { loadReconcileThresholds } from "@/lib/server/credits/reconcileSettings";
import { RECONCILE_SCOPES, type ReconcileScope } from "@cunote/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const auth = authorizeInternalRequest(request);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // scope 선택(화이트리스트 검증 — 알 수 없는 scope 는 무시).
  let scopes: ReconcileScope[] | undefined;
  if (Array.isArray(body.scopes)) {
    const requested = body.scopes.filter((s): s is string => typeof s === "string");
    const valid = requested.filter((s): s is ReconcileScope => (RECONCILE_SCOPES as readonly string[]).includes(s));
    if (requested.length > 0 && valid.length === 0) {
      return NextResponse.json(
        { ok: false, error: { code: "invalid_scope", message: `알 수 없는 scope. 허용: ${RECONCILE_SCOPES.join(", ")}` } },
        { status: 400 },
      );
    }
    scopes = valid.length > 0 ? valid : undefined;
  }

  const actorId = typeof body.actorId === "string" && body.actorId.trim() ? body.actorId.trim() : "system:reconcile-manual";

  const db = getCunoteDb();
  try {
    const portone = getPortoneClient();
    const thresholds = await loadReconcileThresholds(db);
    const { results, overallStatus } = await runReconciliation(db, {
      ...(scopes ? { scopes } : {}),
      portone: portone.isConfigured() ? portone : null,
      actorId,
      adminGrantAlertThreshold: thresholds.adminGrantAlertThreshold,
      companyNewMemberWindowDays: thresholds.companyNewMemberWindowDays,
      companyNewMemberThreshold: thresholds.companyNewMemberThreshold,
    });
    return NextResponse.json({
      ok: true,
      data: {
        overallStatus,
        scopes: results.map((r) => ({ scope: r.scope, status: r.status })),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: { code: "reconcile_error", message: error instanceof Error ? error.message : "대사 실행 실패" } },
      { status: 500 },
    );
  }
}
