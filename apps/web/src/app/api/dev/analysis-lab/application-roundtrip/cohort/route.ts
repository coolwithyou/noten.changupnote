import { NextResponse } from "next/server";
import { loadApplicationRoundtripCohort } from "@/lib/server/analysis-lab/application-roundtrip/cohort";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    return NextResponse.json(await loadApplicationRoundtripCohort());
  } catch (error) {
    const message = error instanceof Error ? error.message : "지원서 후보 공고를 불러오지 못했습니다.";
    return NextResponse.json({ error: "cohort_failed", message }, { status: 500 });
  }
}
