// 공모 딥분석 실험실 — AI 검수 감사 시트 조회·저장 (dev 전용: production 이면 404).
// GET /api/dev/analysis-lab/audit?grantId=&runId=&model= → LabAuditResponse
//   감사 파일이 없으면 §9 대상 산출로 생성한다(생성 시점에 대상 목록 동결 — audit-store).
// PUT /api/dev/analysis-lab/audit 본문 LabAuditUpsertRequest → 검증 후 병합 저장 → LabAuditResponse
//   서버는 저장본 대상 목록에 humanVerdict/note 만 병합한다 — 감사 파일이 없으면 409
//   (로드 없이 저장 금지: 2026-07-22 검수 시트 사고 교훈의 서버측 가드. 클라이언트도
//   로드 실패 시 저장을 차단한다 — review 라우트 선례).
import { NextResponse } from "next/server";
import {
  CRITERION_DIMENSIONS,
  HUMAN_REVIEW_AXIS_VERDICTS,
  HUMAN_REVIEW_CRITERION_VERDICTS,
  type CriterionDimension,
} from "@cunote/contracts";
import {
  loadOrCreateLabAudit,
  saveLabAuditJudgments,
  type LabAuditItemUpdate,
} from "@/lib/server/analysis-lab/audit-store";
import { validateReviewerEmail } from "@/lib/server/analysis-lab/review-store";
import { readLabRun } from "@/lib/server/analysis-lab/run-store";
import {
  AI_REVIEW_ADOPTED,
  type LabAudit,
  type LabAuditResponse,
  type LabCriterionVerdict,
  type LabEmptyAxisVerdict,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

const badRequest = (message: string) =>
  NextResponse.json({ error: "invalid_audit", message }, { status: 400 });

// review 라우트와 동일 캡 — 초과 입력은 클라이언트 maxLength 로도 선차단된다.
const NOTE_MAX_CHARS = 2_000;
const OVERALL_NOTE_MAX_CHARS = 4_000;

/** 표시용 조인 — items 순서대로 criterion 항목이면 런의 제안 원본, 축 항목이면 null. */
function buildResponse(audit: LabAudit, run: LabRun): LabAuditResponse {
  return {
    audit,
    itemCriteria: audit.items.map((item) =>
      item.kind === "criterion" && item.criterionIndex !== undefined
        ? (run.criteria[item.criterionIndex] ?? null)
        : null,
    ),
  };
}

export async function GET(request: Request) {
  if (isProduction()) return notFound();

  const params = new URL(request.url).searchParams;
  const grantId = params.get("grantId")?.trim() ?? "";
  const runId = params.get("runId")?.trim() ?? "";
  const model = params.get("model")?.trim() || AI_REVIEW_ADOPTED.model;
  if (!grantId || !runId) {
    return NextResponse.json(
      { error: "invalid_params", message: "grantId 와 runId 쿼리 파라미터가 필요합니다." },
      { status: 400 },
    );
  }

  const outcome = await loadOrCreateLabAudit({ grantId, runId, model });
  switch (outcome.status) {
    case "run_not_found":
      return NextResponse.json(
        { error: "run_not_found", message: "저장된 런을 찾지 못했습니다." },
        { status: 404 },
      );
    case "human_review_exists":
      return badRequest(
        "이 공고에는 사람 검수(review.json)가 있습니다 — 사람 전수 검수가 우선이며 감사 대상이 아닙니다(§9).",
      );
    case "ai_review_missing":
      return NextResponse.json(
        {
          error: "ai_review_missing",
          message: `이 런에는 ${model} 의 AI 검수 파일이 없습니다 — pnpm lab:ai-review 로 먼저 검수를 생성하세요.`,
        },
        { status: 404 },
      );
    case "audit_parse_failed":
      return NextResponse.json(
        {
          error: "audit_parse_failed",
          message: `기존 감사 파일을 읽지 못했습니다(${outcome.path}) — 재생성하면 사람 판정이 소실되므로 파일을 확인해 주세요.`,
        },
        { status: 500 },
      );
    case "ok":
      return NextResponse.json(buildResponse(outcome.audit, outcome.run));
  }
}

export async function PUT(request: Request) {
  if (isProduction()) return notFound();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return badRequest("요청 본문(JSON)을 읽지 못했습니다.");
  }

  const grantId = typeof body.grantId === "string" ? body.grantId.trim() : "";
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : AI_REVIEW_ADOPTED.model;
  if (!grantId || !runId) {
    return badRequest("grantId 와 runId 를 본문에 넣어주세요.");
  }

  // 감사자도 검수자와 같은 가드 — 사람 이메일 강제, AI 라벨러 식별자 거부(Gate 1 순환성 원칙).
  const auditorCheck = validateReviewerEmail(
    typeof body.auditorEmail === "string" ? body.auditorEmail : "",
  );
  if (!auditorCheck.ok) {
    return badRequest(auditorCheck.reason);
  }

  const itemsResult = parseItemJudgments(body.items);
  if ("message" in itemsResult) return badRequest(itemsResult.message);

  const overallResult = normalizeNote(body.overallNote, OVERALL_NOTE_MAX_CHARS, "총평은 4,000자 이내로 입력해주세요.");
  if ("message" in overallResult) return badRequest(overallResult.message);

  const outcome = await saveLabAuditJudgments({
    grantId,
    runId,
    model,
    auditorEmail: auditorCheck.email,
    items: itemsResult.value,
    overallNote: overallResult.value,
  });
  switch (outcome.status) {
    case "run_not_found":
      return NextResponse.json(
        { error: "run_not_found", message: "저장된 런을 찾지 못했습니다." },
        { status: 404 },
      );
    case "audit_not_found":
      // 로드(생성) 없이 저장 금지 — 대상 목록이 동결되지 않은 상태의 저장은 사고 경로다.
      return NextResponse.json(
        {
          error: "audit_not_found",
          message:
            "감사 파일이 없습니다 — 감사 시트를 먼저 열어(로드) 대상 목록을 생성한 뒤 저장하세요.",
        },
        { status: 409 },
      );
    case "audit_parse_failed":
      return NextResponse.json(
        {
          error: "audit_parse_failed",
          message: `감사 파일을 읽지 못했습니다(${outcome.path}) — 저장을 차단했습니다. 파일을 확인해 주세요.`,
        },
        { status: 500 },
      );
    case "invalid":
      return badRequest(outcome.message);
    case "ok": {
      // 표시용 조인을 위해 런을 다시 읽는다(저장 직후 응답 — 시트 갱신용).
      const run = await readLabRun(grantId, runId);
      if (!run) {
        return NextResponse.json(
          { error: "run_not_found", message: "저장 후 런을 다시 읽지 못했습니다." },
          { status: 404 },
        );
      }
      return NextResponse.json(buildResponse(outcome.audit, run));
    }
  }
}

/** note 공통 정규화(review 라우트와 동일): trim 후 빈 문자열 → null, 초과 시 오류. */
function normalizeNote(
  raw: unknown,
  maxChars: number,
  overMessage: string,
): { value: string | null } | { message: string } {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== "string") return { message: "메모(note)는 문자열이어야 합니다." };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: null };
  if (trimmed.length > maxChars) return { message: overMessage };
  return { value: trimmed };
}

/**
 * 항목 판정 파싱 — 형태·어휘만 검증한다. 저장본 대상 목록과의 대조(존재·kind 별 어휘·
 * 뒤집기 note 필수)는 audit-store 가 저장 시점에 검증한다(대상 목록의 소유자).
 */
function parseItemJudgments(raw: unknown): { value: LabAuditItemUpdate[] } | { message: string } {
  if (!Array.isArray(raw)) return { message: "items 는 배열이어야 합니다." };

  const value: LabAuditItemUpdate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { message: "items 항목이 올바르지 않습니다." };
    }
    const entry = item as Record<string, unknown>;

    const kind = entry.kind;
    if (kind !== "criterion" && kind !== "axis") {
      return { message: "감사 항목 kind 는 criterion·axis 중 하나여야 합니다." };
    }

    const verdict = entry.humanVerdict;
    const vocabulary: readonly string[] =
      kind === "criterion" ? HUMAN_REVIEW_CRITERION_VERDICTS : HUMAN_REVIEW_AXIS_VERDICTS;
    if (typeof verdict !== "string" || !vocabulary.includes(verdict)) {
      return {
        message:
          kind === "criterion"
            ? "criterion 감사 판정은 correct·needs_edit·wrong·unsure 중 하나여야 합니다."
            : "빈 축 감사 판정은 confirmed_absent·missed_condition 중 하나여야 합니다.",
      };
    }

    const note = normalizeNote(entry.note, NOTE_MAX_CHARS, "감사 사유는 2,000자 이내로 입력해주세요.");
    if ("message" in note) return note;

    if (kind === "criterion") {
      const index = entry.criterionIndex;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        return { message: "criterion 감사 항목에는 0 이상의 정수 criterionIndex 가 필요합니다." };
      }
      value.push({
        kind,
        criterionIndex: index,
        humanVerdict: verdict as LabCriterionVerdict,
        note: note.value,
      });
    } else {
      const dimension = entry.dimension;
      if (
        typeof dimension !== "string" ||
        !(CRITERION_DIMENSIONS as readonly string[]).includes(dimension)
      ) {
        return { message: `유효한 축(dimension)이 아닙니다: ${String(dimension)}` };
      }
      value.push({
        kind,
        dimension: dimension as CriterionDimension,
        humanVerdict: verdict as LabEmptyAxisVerdict,
        note: note.value,
      });
    }
  }
  return { value };
}
