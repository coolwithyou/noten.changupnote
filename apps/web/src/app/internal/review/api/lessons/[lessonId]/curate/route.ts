import { NextResponse } from "next/server";

import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import {
  LESSON_SCOPE_AXES,
  findConflictingLessons,
  listLessons,
  scopeHasAxis,
  updateLessonCuration,
  type LessonCurationInput,
  type LessonScope,
  type LessonStatus,
} from "@/lib/server/knowledge/knowledgeRepo";
import { serializeLesson } from "@/lib/server/knowledge/lessonInboxData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ lessonId: string }>;
}

type LessonAction = "approve" | "reject" | "retire";
const ACTION_TO_STATUS: Record<LessonAction, LessonStatus> = {
  approve: "approved",
  reject: "rejected",
  retire: "retired",
};

interface CurateBody {
  action?: unknown;
  instruction?: unknown;
  scope?: unknown;
  curationNote?: unknown;
  force?: unknown;
}

/** scope 입력을 표준 축만 남기고 정규화(빈 문자열 축 제거). knowledgeRepo 화이트리스트 기준. */
function sanitizeScope(raw: unknown): LessonScope | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const out: LessonScope = {};
  for (const axis of LESSON_SCOPE_AXES) {
    const value = source[axis];
    if (typeof value === "string" && value.trim().length > 0) out[axis] = value.trim();
  }
  return out;
}

/**
 * lesson 큐레이션(승인/기각/철회).
 *
 * body: { action, instruction?, scope?, curationNote?, force? }.
 * - curatedBy 는 인증된 리뷰어 이메일(getReviewerIdentity) — 기존 검수 라우트와 동일한 신원 획득.
 * - action='approve' 는 updateLessonCuration 호출 전에 findConflictingLessons(target, 최종 scope)로
 *   충돌을 검사한다. 충돌이 있고 force!==true 면 409 로 충돌 목록을 반환하고 전이하지 않는다.
 *   force===true 면 충돌을 무시하고 승인한다(경고 확인 후 진행 UX).
 * - curationNote 보존 정책: body 에 curationNote 키가 없으면 기존 값을 읽어 그대로 전달한다
 *   (updateLessonCuration 은 미전달 시 null 로 덮어쓰므로, 상태만 바꿀 때 기존 메모 유실 방지).
 * - 승격 가드 에러(sourceRefs/goldenCaseRef 없음)와 scope 축 에러는 400 으로 변환해 사유를 전달한다.
 */
export async function POST(request: Request, context: RouteContext) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  const { lessonId } = await context.params;

  let body: CurateBody;
  try {
    body = (await request.json()) as CurateBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "approve" && action !== "reject" && action !== "retire") {
    return NextResponse.json(
      { ok: false, error: "invalid_action", message: "action 은 approve|reject|retire 만 허용합니다." },
      { status: 400 },
    );
  }

  // 현재 값(target/scope/curationNote 보존)을 얻기 위해 대상 lesson 을 조회한다.
  // knowledgeRepo 에 단건 조회가 없어 목록에서 찾는다(후보 규모가 작아 비용 무시 가능).
  const existing = (await listLessons({})).find((lesson) => lesson.id === lessonId);
  if (!existing) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const instruction =
    typeof body.instruction === "string" && body.instruction.trim().length > 0
      ? body.instruction
      : undefined;

  const scope = body.scope !== undefined ? sanitizeScope(body.scope) : undefined;
  if (scope !== undefined && !scopeHasAxis(scope)) {
    return NextResponse.json(
      { ok: false, error: "scope_needs_axis", message: "scope 는 최소 1개 축이 필요합니다." },
      { status: 400 },
    );
  }

  // curationNote 보존: 키가 없으면 기존 값을, 있으면(빈 문자열/ null 포함) 그 값을 명시 전달한다.
  const hasNoteKey = Object.prototype.hasOwnProperty.call(body, "curationNote");
  const curationNote: string | null = hasNoteKey
    ? typeof body.curationNote === "string"
      ? body.curationNote
      : null
    : existing.curationNote ?? null;

  if (action === "reject" && (!curationNote || curationNote.trim().length === 0)) {
    return NextResponse.json(
      { ok: false, error: "reject_requires_note", message: "기각 사유(메모)를 입력하세요." },
      { status: 400 },
    );
  }

  // 승인 충돌 검출: 최종 scope(수정본 우선, 없으면 기존) 기준. force 면 건너뛴다.
  if (action === "approve" && body.force !== true) {
    const finalScope = scope ?? existing.scope;
    const conflicts = await findConflictingLessons(existing.target, finalScope, { excludeId: lessonId });
    if (conflicts.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "conflict",
          message: "같은 scope 의 승인된 lesson 과 충돌합니다.",
          conflicts: conflicts.map((c) => ({
            id: c.id,
            instruction: c.instruction,
            scope: c.scope,
            evidenceTier: c.evidenceTier,
          })),
        },
        { status: 409 },
      );
    }
  }

  // exactOptionalPropertyTypes: undefined 를 명시 전달하지 않도록 존재하는 값만 채운다.
  const curationInput: LessonCurationInput = {
    status: ACTION_TO_STATUS[action],
    curationNote,
    curatedBy: reviewer.email,
  };
  if (instruction !== undefined) curationInput.instruction = instruction;
  if (scope !== undefined) curationInput.scope = scope;

  try {
    const updated = await updateLessonCuration(lessonId, curationInput);
    return NextResponse.json({ ok: true, lesson: serializeLesson(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 승격 가드(원문 인용/goldenCaseRef 없음)는 사용자 정정 가능한 400 으로 변환.
    if (message.includes("promotion guard")) {
      return NextResponse.json(
        {
          ok: false,
          error: "promotion_guard",
          message: "원문 인용(sourceRefs) 또는 goldenCaseRef 가 없어 승인할 수 없습니다.",
        },
        { status: 400 },
      );
    }
    if (message.includes("scope")) {
      return NextResponse.json({ ok: false, error: "scope_invalid", message }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "curate_failed", message }, { status: 500 });
  }
}
