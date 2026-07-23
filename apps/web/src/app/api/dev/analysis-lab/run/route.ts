// 공모 딥분석 실험실 — 저장된 런 단건 조회 (dev 전용: production 이면 404).
// GET /api/dev/analysis-lab/run?grantId=&runId= → LabRunResponse
import { NextResponse } from "next/server";
import { readLabRunWithConfirmations } from "@/lib/server/analysis-lab/confirmations";
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

  // 보강 사이드카(<runId>.confirmations.json, Phase B-0) 병합 로더 — v2 런은 confirmation 이
  // 없어 경량 보강 CLI(lab:confirmations)가 질문을 사이드카로 생성한다. 런 파일은 불변이므로
  // 조회 시점에 병합해 내려줘야 실험실 UI(ConfirmationPreview)가 v3 인라인과 동일하게 렌더한다
  // (인라인 confirmation 보유 criterion 은 인라인 우선).
  const run = await readLabRunWithConfirmations(grantId, runId);
  if (!run) {
    return NextResponse.json(
      { error: "run_not_found", message: "저장된 런을 찾지 못했습니다." },
      { status: 404 },
    );
  }
  const response: LabRunResponse = { run };
  return NextResponse.json(response);
}
