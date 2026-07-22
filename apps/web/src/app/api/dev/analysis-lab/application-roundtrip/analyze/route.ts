import { NextResponse } from "next/server";
import {
  ApplicationRoundtripAnalyzeError,
  runApplicationRoundtripAnalysis,
} from "@/lib/server/analysis-lab/application-roundtrip/analyze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { grantId?: unknown } | null;
  const grantId = typeof body?.grantId === "string" ? body.grantId.trim() : "";
  if (!grantId) return NextResponse.json({ error: "invalid_grant_id", message: "grantId가 필요합니다." }, { status: 400 });
  try {
    return NextResponse.json({ run: await runApplicationRoundtripAnalysis(grantId) });
  } catch (error) {
    if (error instanceof ApplicationRoundtripAnalyzeError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Kordoc 왕복 분석에 실패했습니다.";
    return NextResponse.json({ error: "analysis_failed", message }, { status: 500 });
  }
}
