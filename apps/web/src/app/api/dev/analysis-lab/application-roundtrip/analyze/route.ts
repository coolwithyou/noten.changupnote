import { NextResponse } from "next/server";
import {
  ApplicationRoundtripAnalyzeError,
} from "@/lib/server/analysis-lab/application-roundtrip/analyze";
import { runLabApplicationRoundtripAnalysis } from "@/lib/server/analysis-lab/application-roundtrip/lab-runner";
import { resolveLabTransport } from "@/lib/server/analysis-lab/claude-cli-transport";
import { getCunoteDb } from "@/lib/server/db/client";
import {
  DeepAnalysisRuntimeControlError,
  localAnalysisOwnerFromRequest,
  runWithLocalSubscriptionLeaseHeartbeat,
} from "@/lib/server/deep-analysis/runtimeControl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { grantId?: unknown } | null;
  const grantId = typeof body?.grantId === "string" ? body.grantId.trim() : "";
  if (!grantId) return NextResponse.json({ error: "invalid_grant_id", message: "grantId가 필요합니다." }, { status: 400 });
  try {
    if (resolveLabTransport() !== "claude-cli") {
      return NextResponse.json(
        {
          error: "subscription_transport_required",
          message: "로컬 Kordoc 분석은 ANALYSIS_LAB_TRANSPORT=claude-cli에서만 실행할 수 있습니다.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      run: await runWithLocalSubscriptionLeaseHeartbeat({
        db: getCunoteDb(),
        ownerId: localAnalysisOwnerFromRequest(request),
        run: () => runLabApplicationRoundtripAnalysis(grantId),
      }),
    });
  } catch (error) {
    if (error instanceof DeepAnalysisRuntimeControlError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof ApplicationRoundtripAnalyzeError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Kordoc 왕복 분석에 실패했습니다.";
    return NextResponse.json({ error: "analysis_failed", message }, { status: 500 });
  }
}
