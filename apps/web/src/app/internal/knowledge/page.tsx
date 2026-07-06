import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { buildKnowledgeDashboardData } from "@/lib/server/knowledge/knowledgeDashboardData";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { KnowledgeDashboardView } from "@/features/knowledge/KnowledgeDashboardView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "지식 대시보드",
};

/**
 * 지식 관리 대시보드 — 운영 지식 축적 현황판.
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §8(성숙도 지표).
 * 인증 가드는 리뷰어 워크스페이스와 동일(getReviewerIdentity → 미인가 notFound → 404).
 * 초기 데이터는 서버에서 조립해 넘기고(플래시 방지), 이후 업로드·추출·갱신은 클라이언트가 API 왕복.
 */
export default async function KnowledgeDashboardPage() {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) notFound();

  const data = await buildKnowledgeDashboardData();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-screen-2xl p-4 lg:p-8">
        <KnowledgeDashboardView initialData={data} />
      </div>
    </main>
  );
}
