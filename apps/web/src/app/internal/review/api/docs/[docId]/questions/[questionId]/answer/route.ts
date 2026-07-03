import { NextResponse } from "next/server";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { answerQuestion } from "@/lib/server/review/reviewQuestionsRepo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ docId: string; questionId: string }>;
}

/**
 * 질문 답변: answer 저장 + applyMap 을 서버에서 labelJson 에 결정적 반영 (save 와 동일 경로).
 * '모르겠음'(unsure) 이면 해당 필드 notes 에 '판정 보류:' 접두어 부여.
 * 게이트는 다른 라우트와 동일 — 미인가 404.
 */
export async function POST(request: Request, context: RouteContext) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  const { docId, questionId } = await context.params;

  let body: { value?: unknown; text?: unknown };
  try {
    body = (await request.json()) as { value?: unknown; text?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.value !== "string" || !body.value) {
    return NextResponse.json({ ok: false, error: "value_required" }, { status: 400 });
  }
  const answer: { value: string; text?: string } = { value: body.value };
  if (typeof body.text === "string" && body.text) answer.text = body.text;

  const result = await answerQuestion(docId, questionId, answer, reviewer.email);
  if (!result.ok) {
    const status =
      result.reason === "doc_not_found" || result.reason === "question_not_found" ? 404 : 400;
    return NextResponse.json({ ok: false, error: result.reason }, { status });
  }
  return NextResponse.json({ ok: true, applied: result.applied, held: result.held });
}
