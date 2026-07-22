// 공모 딥분석 실험실 — 검수 시트 저장소 (dev 전용, DB 미사용).
// 검수 시트는 런 파일과 같은 디렉토리의 <runId>.review.json 에 저장한다.
// 런과 달리 사람 산출물이므로 **덮어쓰기 허용**(기본 flag) — 단 createdAt 은 최초 저장 시각을,
// startedAt(검수 시트 최초 오픈 시각)은 최초 계측 값을 보존한다.
// 이 검수가 공고 criterion 골든셋의 1차 원천이다: Gate 1 순환성 가드와 동일 원칙으로
// AI 라벨러 식별자는 검수자로 거부하고 사람 이메일만 허용한다.
// import 방향: review-store → run-store 단방향만 (역방향 금지 — run-store 는 검수 파일을
// 표시용으로만 관대하게 읽는다).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LabReview } from "@/features/dev/analysis-lab/contract";
import { labRunFilePath, readLabRun } from "./run-store";

/**
 * AI 라벨러로 간주하여 검수자에서 거부하는 패턴.
 * dev 전용 복제 — 원본: src/lib/server/db/field-map-review-guard.ts 의 AI_LABELER_PATTERNS.
 * (실험실 트랙은 프로덕션 DB 코드와 격리를 유지하므로 원본을 import 하지 않고 관행만 복제한다.
 *  원본이 갱신되면 여기도 맞춰줄 것.)
 */
const AI_LABELER_PATTERNS: readonly RegExp[] = [
  /prelabel/i,
  /\bopus\b/i,
  /\bsonnet\b/i,
  /\bhaiku\b/i,
  /\bclaude\b/i,
  /\bgpt\b/i,
  /\bgemini\b/i,
  /\bllm\b/i,
  /(^|[^a-z])ai([^a-z]|$)/i,
  /-?model$/i,
  /auto-?label/i,
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ReviewerEmailCheck = { ok: true; email: string } | { ok: false; reason: string };

/**
 * 검수자 이메일 검증 — ① 이메일 형식 ② AI 라벨러 식별자 거부.
 * 통과 시 trim 된 이메일을, 실패 시 한국어 이유를 반환한다.
 */
export function validateReviewerEmail(email: string): ReviewerEmailCheck {
  const trimmed = email.trim();
  if (!EMAIL_PATTERN.test(trimmed)) {
    return { ok: false, reason: "검수자 이메일 형식이 올바르지 않습니다." };
  }
  if (AI_LABELER_PATTERNS.some((re) => re.test(trimmed))) {
    return {
      ok: false,
      reason: "AI 라벨러 식별자는 검수자로 쓸 수 없습니다 — 사람 검수자의 이메일을 입력해주세요.",
    };
  }
  return { ok: true, email: trimmed };
}

/** 검수 파일 경로: 런 파일(<runId>.json)과 같은 디렉토리의 <runId>.review.json. */
export function labReviewFilePath(source: string, sourceId: string, runId: string): string {
  // labRunFilePath 가 runId 형식(RUN_ID_PATTERN)을 검증하므로 여기서 재검증하지 않는다.
  return labRunFilePath(source, sourceId, runId).replace(/\.json$/, ".review.json");
}

/**
 * 검수 시트 단건 읽기 — 런과 동일하게 grantId + runId 키.
 * 하위 디렉토리 스캔 없이 readLabRun 으로 런을 먼저 찾고, 그 런의 source/sourceId 로
 * 경로를 만들어 읽는다. 런 또는 검수 파일이 없으면 null.
 */
export async function readLabReview(grantId: string, runId: string): Promise<LabReview | null> {
  const run = await readLabRun(grantId, runId);
  if (!run) return null;
  return readReviewFile(labReviewFilePath(run.source, run.sourceId, run.runId));
}

/**
 * 검수 시트 저장(덮어쓰기 허용). 기존 파일이 있으면 createdAt 을 보존하고 updatedAt 만
 * 요청 값으로 갱신한다. startedAt(검수 시작 시각)도 최초 값 보존 — 기존 파일에 있으면
 * 유지하고, 없으면 이번 요청 값을 쓰며, 요청에도 없으면 null(미계측 — 파일럿 등 구 파일
 * 하위 호환). 실제 저장된 LabReview 를 반환한다.
 */
export async function saveLabReview(review: LabReview): Promise<LabReview> {
  const run = await readLabRun(review.grantId, review.runId);
  if (!run) {
    // 라우트가 먼저 런 존재를 확인하므로 정상 흐름에서는 도달하지 않는다.
    throw new Error("검수 대상 런을 찾지 못했습니다 — 검수 시트는 런 없이 저장할 수 없습니다.");
  }
  const path = labReviewFilePath(run.source, run.sourceId, run.runId);
  const existing = await readReviewFile(path);
  const saved: LabReview = {
    ...review,
    createdAt: existing?.createdAt ?? review.createdAt,
    startedAt: existing?.startedAt ?? review.startedAt ?? null,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return saved;
}

async function readReviewFile(path: string): Promise<LabReview | null> {
  try {
    const body = await readFile(path, "utf8");
    const parsed = JSON.parse(body) as LabReview;
    return typeof parsed.runId === "string" &&
      typeof parsed.grantId === "string" &&
      typeof parsed.reviewerEmail === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}
