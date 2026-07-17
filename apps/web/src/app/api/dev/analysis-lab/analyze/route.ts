// 공모 딥분석 실험실 — 딥분석 실행 (dev 전용: production 이면 404).
// POST /api/dev/analysis-lab/analyze {grantId} → LabAnalyzeResponse (동기, 수 분 소요)
import { NextResponse } from "next/server";
import { LabGrantNotFoundError, runLabAnalysis } from "@/lib/server/analysis-lab/analyze";
import type { LabAnalyzeResponse } from "@/features/dev/analysis-lab/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 로컬 dev 라 사실상 무제한이지만, 딥분석이 수 분짜리 동기 호출임을 명시해 둔다.
export const maxDuration = 800;

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function POST(request: Request) {
  if (isProduction()) return notFound();

  const body = (await request.json().catch(() => null)) as { grantId?: unknown } | null;
  const grantId = typeof body?.grantId === "string" ? body.grantId.trim() : "";
  if (!grantId) {
    return NextResponse.json(
      { error: "invalid_grant_id", message: "grantId 를 본문에 넣어주세요." },
      { status: 400 },
    );
  }

  try {
    const run = await runLabAnalysis(grantId);
    const response: LabAnalyzeResponse = { run };
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof LabGrantNotFoundError) {
      return NextResponse.json({ error: "grant_not_found", message: error.message }, { status: 404 });
    }
    // 추출 실패는 runLabAnalysis 가 error 런으로 흡수한다 — 여기 오는 건 로드·저장 등 인프라 실패.
    const message = error instanceof Error ? error.message : "딥분석 실행에 실패했습니다.";
    return NextResponse.json({ error: "analysis_failed", message }, { status: 500 });
  }
}
