import { NextResponse } from "next/server";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { unapproveReviewDoc } from "@/lib/server/review/reviewDocsRepo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

/** 확정 취소(오확정 복구): reviewStatus='in_review' 강등 + golden_set row 제거. 미인가 404. */
export async function POST(_request: Request, context: RouteContext) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  const { docId } = await context.params;
  const result = await unapproveReviewDoc(docId);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 400;
    return NextResponse.json({ ok: false, error: result.reason }, { status });
  }
  // withdrawn: surface 문서면 grant_document_fields 철회 결과(B3 브리지). 스파이크 문서면 미포함.
  return NextResponse.json({ ok: true, goldenDeleted: result.goldenDeleted, withdrawn: result.withdrawn ?? null });
}
