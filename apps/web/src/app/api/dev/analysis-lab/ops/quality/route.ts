import { NextResponse } from "next/server";
import {
  ANALYSIS_QUALITY_REPORT_DEFAULT_LIMIT,
  ANALYSIS_QUALITY_REPORT_MAX_LIMIT,
  loadAnalysisQualityReport,
} from "@/lib/server/analysis-lab/quality-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const parsed = rawLimit === null ? ANALYSIS_QUALITY_REPORT_DEFAULT_LIMIT : Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ANALYSIS_QUALITY_REPORT_MAX_LIMIT) {
    return NextResponse.json(
      { error: "invalid_limit", message: `limit은 1~${ANALYSIS_QUALITY_REPORT_MAX_LIMIT} 정수여야 합니다.` },
      { status: 400 },
    );
  }
  return NextResponse.json(await loadAnalysisQualityReport({ limit: parsed }));
}
