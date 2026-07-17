// 공모 딥분석 실험실 — 저장된 런 단건 조회 (dev 전용: production 이면 404).
// GET /api/dev/analysis-lab/run?grantId=&runId= → LabRunResponse
import { NextResponse } from "next/server";
import { readLabRun } from "@/lib/server/analysis-lab/run-store";
import type { LabRunResponse } from "@/features/dev/analysis-lab/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function GET(request: Request) {
  if (isProduction()) return notFound();

  const params = new URL(request.url).searchParams;
  const grantId = params.get("grantId")?.trim() ?? "";
  const runId = params.get("runId")?.trim() ?? "";
  if (!grantId || !runId) {
    return NextResponse.json(
      { error: "invalid_params", message: "grantId 와 runId 쿼리 파라미터가 필요합니다." },
      { status: 400 },
    );
  }

  const run = await readLabRun(grantId, runId);
  if (!run) {
    return NextResponse.json(
      { error: "run_not_found", message: "저장된 런을 찾지 못했습니다." },
      { status: 404 },
    );
  }
  const response: LabRunResponse = { run };
  return NextResponse.json(response);
}
