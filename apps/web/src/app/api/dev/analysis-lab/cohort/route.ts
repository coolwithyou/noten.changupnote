// 공모 딥분석 실험실 — 코호트 조회 (dev 전용: production 이면 404).
// GET /api/dev/analysis-lab/cohort?refresh=1 → LabCohortResponse
import { NextResponse } from "next/server";
import { loadLabCohort } from "@/lib/server/analysis-lab/cohort";
import type { LabCohortResponse } from "@/features/dev/analysis-lab/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function GET(request: Request) {
  if (isProduction()) return notFound();

  const refreshParam = new URL(request.url).searchParams.get("refresh");
  const refresh = refreshParam === "1" || refreshParam === "true";
  const cohort: LabCohortResponse = await loadLabCohort({ refresh });
  return NextResponse.json(cohort);
}
