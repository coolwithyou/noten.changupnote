import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { getLessonInboxData, isLessonStatus } from "@/lib/server/knowledge/lessonInboxData";
import { LessonInboxView } from "@/features/review/LessonInboxView";
import { ReviewWorkspaceShell } from "@/features/review/ReviewWorkspaceShell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ status?: string; sourceId?: string }>;
}

/**
 * 지식 인박스 — 운영 보고 문서에서 추출한 lesson 후보 검수 화면.
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §7 Step 2.
 * 인증 가드는 기존 검수 워크스페이스와 동일(getReviewerIdentity → 미인가 notFound).
 * 초기 데이터는 서버에서 조립해 넘기고(플래시 방지), 이후 탭 전환·큐레이션은 클라이언트가 API 왕복.
 */
export default async function LessonInboxPage({ searchParams }: PageProps) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) notFound();

  const sp = await searchParams;
  const status = isLessonStatus(sp.status) ? sp.status : "proposed";
  const sourceId =
    typeof sp.sourceId === "string" && sp.sourceId.trim().length > 0 ? sp.sourceId.trim() : undefined;

  const data = await getLessonInboxData({ status, sourceId });

  const backLink = (
    <Link
      href="/internal/review"
      className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
    >
      <ArrowLeft data-icon="inline-start" />
      검수 워크스페이스
    </Link>
  );

  return (
    <ReviewWorkspaceShell
      reviewerEmail={reviewer.email}
      currentPath="/internal/review/lessons"
      title="지식 인박스 — lesson 후보 검수"
      description="원문 인용과 지침을 대조해 승인·수정·기각하세요. 승인은 곧 지식 레이어 주입입니다."
      badge="지식 루프 · lesson 큐레이션"
      actions={backLink}
      metrics={[
        { label: "제안됨", value: data.counts.proposed },
        { label: "승인됨", value: data.counts.approved },
        { label: "기각됨", value: data.counts.rejected },
        { label: "철회됨", value: data.counts.retired },
      ]}
    >
      <LessonInboxView initialData={data} />
    </ReviewWorkspaceShell>
  );
}
