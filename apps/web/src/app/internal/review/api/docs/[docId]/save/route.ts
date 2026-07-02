import { NextResponse } from "next/server";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { saveReviewDraft, type ReviewLabelJson } from "@/lib/server/review/reviewDocsRepo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ docId: string }>;
}

/** 초안 저장: labelJson 갱신 + reviewStatus='in_review'. 미인가 404. */
export async function POST(request: Request, context: RouteContext) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  const { docId } = await context.params;
  let body: { labelJson?: ReviewLabelJson };
  try {
    body = (await request.json()) as { labelJson?: ReviewLabelJson };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.labelJson || typeof body.labelJson !== "object" || !Array.isArray(body.labelJson.fields)) {
    return NextResponse.json({ ok: false, error: "labelJson_fields_required" }, { status: 400 });
  }

  const result = await saveReviewDraft(docId, body.labelJson);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.reason }, { status: result.reason === "not_found" ? 404 : 400 });
  }
  return NextResponse.json({ ok: true });
}
