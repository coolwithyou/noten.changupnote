// 공모 딥분석 실험실 — 검수 시트 조회·저장 (dev 전용: production 이면 404).
// GET /api/dev/analysis-lab/review?grantId=&runId= → LabReviewResponse (없으면 {review:null})
// PUT /api/dev/analysis-lab/review 본문 LabReviewUpsertRequest → 검증 후 저장 → LabReviewResponse
import { NextResponse } from "next/server";
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";
import {
  readLabReview,
  saveLabReview,
  validateReviewerEmail,
} from "@/lib/server/analysis-lab/review-store";
import { readLabRun } from "@/lib/server/analysis-lab/run-store";
import type {
  LabAxisReview,
  LabCriterionReview,
  LabCriterionVerdict,
  LabEmptyAxisVerdict,
  LabReview,
  LabReviewResponse,
  LabRun,
} from "@/features/dev/analysis-lab/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Response body 는 일회성 스트림이라 인스턴스를 재사용하면 두 번째 응답부터 깨진다 — 매번 새로 만든다.
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

const badRequest = (message: string) =>
  NextResponse.json({ error: "invalid_review", message }, { status: 400 });

const CRITERION_VERDICTS: readonly LabCriterionVerdict[] = [
  "correct",
  "needs_edit",
  "wrong",
  "unsure",
];
const EMPTY_AXIS_VERDICTS: readonly LabEmptyAxisVerdict[] = [
  "confirmed_absent",
  "missed_condition",
];

const NOTE_MAX_CHARS = 2_000;
const OVERALL_NOTE_MAX_CHARS = 4_000;

export async function GET(request: Request) {
  if (isProduction()) return notFound();

  const params = new URL(request.url).searchParams;
  const grantId = params.get("grantId")?.trim() ?? "";
  const runId = params.get("runId")?.trim() ?? "";
  if (!grantId || !runId) {
    return NextResponse.json(
      { error: "invalid_params", message: "grantId 와 runId 쿼리 파라미터가 필요합니다." },
      { status: 400 },
    );
  }

  const review = await readLabReview(grantId, runId);
  const response: LabReviewResponse = { review };
  return NextResponse.json(response);
}

export async function PUT(request: Request) {
  if (isProduction()) return notFound();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return badRequest("요청 본문(JSON)을 읽지 못했습니다.");
  }

  const grantId = typeof body.grantId === "string" ? body.grantId.trim() : "";
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  if (!grantId || !runId) {
    return badRequest("grantId 와 runId 를 본문에 넣어주세요.");
  }

  const run = await readLabRun(grantId, runId);
  if (!run) {
    return NextResponse.json(
      { error: "run_not_found", message: "저장된 런을 찾지 못했습니다." },
      { status: 404 },
    );
  }
  // 실패한 런의 검수는 골든 신호가 아니다 — 집계·검수 완료 판정 오염을 서버에서 차단.
  if (run.error) {
    return badRequest("실패한 런은 검수 대상이 아닙니다 — 성공한 런을 검수해주세요.");
  }

  const reviewerCheck = validateReviewerEmail(
    typeof body.reviewerEmail === "string" ? body.reviewerEmail : "",
  );
  if (!reviewerCheck.ok) {
    return badRequest(reviewerCheck.reason);
  }

  const criterionResult = parseCriterionReviews(body.criterionReviews, run);
  if ("message" in criterionResult) return badRequest(criterionResult.message);

  const axisResult = parseAxisReviews(body.axisReviews, run);
  if ("message" in axisResult) return badRequest(axisResult.message);

  const overallResult = parseOverallNote(body.overallNote);
  if ("message" in overallResult) return badRequest(overallResult.message);

  const now = new Date().toISOString();
  const review: LabReview = {
    grantId,
    runId,
    reviewerEmail: reviewerCheck.email,
    createdAt: now, // 기존 파일이 있으면 review-store 가 createdAt 을 보존한다.
    updatedAt: now,
    criterionReviews: criterionResult.value,
    axisReviews: axisResult.value,
    overallNote: overallResult.value,
  };
  const saved = await saveLabReview(review);
  const response: LabReviewResponse = { review: saved };
  return NextResponse.json(response);
}

/** note 공통 정규화: trim 후 빈 문자열 → null. 초과 시 한국어 오류 메시지 반환. */
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

function parseCriterionReviews(
  raw: unknown,
  run: LabRun,
): { value: LabCriterionReview[] } | { message: string } {
  if (!Array.isArray(raw)) return { message: "criterionReviews 는 배열이어야 합니다." };

  const value: LabCriterionReview[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { message: "criterionReviews 항목이 올바르지 않습니다." };
    }
    const entry = item as Record<string, unknown>;

    const index = entry.criterionIndex;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= run.criteria.length
    ) {
      return {
        message: `criterionIndex 는 0 이상 ${run.criteria.length} 미만의 정수여야 합니다.`,
      };
    }
    if (seen.has(index)) {
      return { message: `criterionIndex ${index} 판정이 중복되었습니다.` };
    }
    seen.add(index);

    const verdict = entry.verdict;
    if (
      typeof verdict !== "string" ||
      !CRITERION_VERDICTS.includes(verdict as LabCriterionVerdict)
    ) {
      return {
        message: "criterion 판정(verdict)은 correct·needs_edit·wrong·unsure 중 하나여야 합니다.",
      };
    }

    const note = normalizeNote(
      entry.note,
      NOTE_MAX_CHARS,
      "criterion 메모는 2,000자 이내로 입력해주세요.",
    );
    if ("message" in note) return note;

    value.push({
      criterionIndex: index,
      verdict: verdict as LabCriterionVerdict,
      note: note.value,
    });
  }
  return { value };
}

function parseAxisReviews(
  raw: unknown,
  run: LabRun,
): { value: LabAxisReview[] } | { message: string } {
  if (!Array.isArray(raw)) return { message: "axisReviews 는 배열이어야 합니다." };

  // 빈 축 확인은 "제안이 없는 축"만 대상 — 제안 criterion 이 있는 축은 criterionReviews 소관.
  const proposedDimensions = new Set<CriterionDimension>(run.criteria.map((c) => c.dimension));

  const value: LabAxisReview[] = [];
  const seen = new Set<CriterionDimension>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { message: "axisReviews 항목이 올바르지 않습니다." };
    }
    const entry = item as Record<string, unknown>;

    const dimension = entry.dimension;
    if (
      typeof dimension !== "string" ||
      !(CRITERION_DIMENSIONS as readonly string[]).includes(dimension)
    ) {
      return { message: `유효한 축(dimension)이 아닙니다: ${String(dimension)}` };
    }
    const dim = dimension as CriterionDimension;
    if (seen.has(dim)) {
      return { message: `축 ${dim} 확인이 중복되었습니다.` };
    }
    seen.add(dim);
    if (proposedDimensions.has(dim)) {
      return {
        message: `축 ${dim} 에는 제안된 criterion 이 있습니다 — 빈 축 확인 대상이 아닙니다.`,
      };
    }

    const verdict = entry.verdict;
    if (
      typeof verdict !== "string" ||
      !EMPTY_AXIS_VERDICTS.includes(verdict as LabEmptyAxisVerdict)
    ) {
      return {
        message: "빈 축 판정(verdict)은 confirmed_absent·missed_condition 중 하나여야 합니다.",
      };
    }

    const note = normalizeNote(
      entry.note,
      NOTE_MAX_CHARS,
      "축 메모는 2,000자 이내로 입력해주세요.",
    );
    if ("message" in note) return note;
    if (verdict === "missed_condition" && note.value === null) {
      return { message: "누락 요건을 서술해주세요." };
    }

    value.push({ dimension: dim, verdict: verdict as LabEmptyAxisVerdict, note: note.value });
  }
  return { value };
}

/** overallNote: trim, 4,000자 캡, 빈 문자열 → null. */
function parseOverallNote(raw: unknown): { value: string | null } | { message: string } {
  return normalizeNote(raw, OVERALL_NOTE_MAX_CHARS, "총평은 4,000자 이내로 입력해주세요.");
}
