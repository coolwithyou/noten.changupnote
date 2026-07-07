import { NextResponse } from "next/server";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { approveReviewDoc, type ReviewLabelJson } from "@/lib/server/review/reviewDocsRepo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

/**
 * 검수 확정: reviewStatus='approved' + golden_set 승격.
 * body.labelJson 이 오면 마지막 편집분을 반영해 확정한다.
 * 미인가 404. 순환성 가드 실패는 409.
 */
export async function POST(request: Request, context: RouteContext) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  const { docId } = await context.params;
  let labelJson: ReviewLabelJson | undefined;
  try {
    const body = (await request.json()) as { labelJson?: ReviewLabelJson };
    if (body.labelJson && typeof body.labelJson === "object" && Array.isArray(body.labelJson.fields)) {
      labelJson = body.labelJson;
    }
  } catch {
    // body 없이 확정하면 저장된 labelJson 으로 확정한다.
  }

  const result = await approveReviewDoc(docId, reviewer.email, labelJson);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 409;
    return NextResponse.json({ ok: false, error: result.reason }, { status });
  }
  // applied: surface 문서면 grant_document_fields 반영 결과(B3 브리지). 스파이크 문서면 미포함.
  return NextResponse.json({ ok: true, goldenAction: result.goldenAction, applied: result.applied ?? null });
}
