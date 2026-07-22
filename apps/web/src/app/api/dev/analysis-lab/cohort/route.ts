// 공모 딥분석 실험실 — 코호트 조회 (dev 전용: production 이면 404).
// GET /api/dev/analysis-lab/cohort → LabCohortResponse(+cohortMeta)
//   ?refresh=1        저장 코호트를 버리고 재선정(검수 보유 공고는 보존)
//   ?size=30          코호트 크기(기본 3, 재선정 시에만 의미)
//   ?stratified=1     소스×두께 6층 층화 선정(확대 실험 계획 §3)
//   ?seed=123         층 내 샘플링 시드(미지정 시 생성 후 파일 기록)
//   ?label=expansion-s1  실험 라벨(파일 기록)
import { NextResponse } from "next/server";
import { loadLabCohort, type LabCohortResult } from "@/lib/server/analysis-lab/cohort";

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

function parseInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: Request) {
  if (isProduction()) return notFound();

  const params = new URL(request.url).searchParams;
  const label = params.get("label")?.trim();
  const cohort: LabCohortResult = await loadLabCohort({
    refresh: parseBoolean(params.get("refresh")),
    size: parseInteger(params.get("size")),
    stratified: parseBoolean(params.get("stratified")),
    seed: parseInteger(params.get("seed")),
    experimentLabel: label && label.length > 0 ? label : undefined,
  });
  return NextResponse.json(cohort);
}
