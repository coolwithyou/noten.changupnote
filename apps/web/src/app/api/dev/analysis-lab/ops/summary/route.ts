// 공모 딥분석 실험실 — 배치 운영 요약 (dev 전용: production 이면 404).
// GET /api/dev/analysis-lab/ops/summary → LabOpsSummary (깔때기 6단계 + transport 현황)
//   ?refresh=1   모듈 메모리 캐시(TTL 30s)를 무효화하고 재집계(파일 전수 스캔 포함)
import { NextResponse } from "next/server";
import { loadLabOpsSummary } from "@/lib/server/analysis-lab/ops-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function parseBoolean(value: string | null): boolean {
  return value === "1" || value === "true";
}

export async function GET(request: Request) {
  if (isProduction()) return notFound();

  const params = new URL(request.url).searchParams;
  const summary = await loadLabOpsSummary({ refresh: parseBoolean(params.get("refresh")) });
  return NextResponse.json(summary);
}
