import assert from "node:assert/strict";
import {
  formatDraftResumeCaption,
  formatDraftSavedAt,
  summarizeDraftResume,
  type DraftResumeRow,
} from "./draftResume";

function row(
  input: Omit<Partial<DraftResumeRow>, "updatedAt"> & { documentKey: string; updatedAt: string },
): DraftResumeRow {
  return {
    documentKey: input.documentKey,
    status: input.status ?? "draft",
    updatedAt: new Date(input.updatedAt),
    headSavedAt: input.headSavedAt ?? null,
  };
}

// 저장본이 없으면 재개 CTA 근거도 없다.
assert.equal(summarizeDraftResume([]), null);
assert.equal(
  summarizeDraftResume([row({ documentKey: "plan", status: "archived", updatedAt: "2026-09-30T09:00:00Z" })]),
  null,
);

// 문서 키별 최신 1건만 세고, 마지막 저장은 초안 갱신·revision head 중 늦은 쪽이다.
const twoDocuments = summarizeDraftResume([
  row({ documentKey: "form", updatedAt: "2026-09-30T08:00:00Z", headSavedAt: new Date("2026-09-30T09:06:00Z") }),
  row({ documentKey: "plan", status: "exported", updatedAt: "2026-09-29T10:00:00Z" }),
  row({ documentKey: "form", updatedAt: "2026-09-28T08:00:00Z" }),
]);
assert.deepEqual(twoDocuments, { savedCount: 2, lastSavedAt: new Date("2026-09-30T09:06:00Z") });

// 입력 순서와 무관하게 최신 행이 archived 면 그 문서는 폐기로 보고 과거 행으로 되살리지 않는다.
const archivedLatest = summarizeDraftResume([
  row({ documentKey: "plan", updatedAt: "2026-09-27T10:00:00Z" }),
  row({ documentKey: "plan", status: "archived", updatedAt: "2026-09-29T10:00:00Z" }),
  row({ documentKey: "form", status: "needs_input", updatedAt: "2026-09-28T01:00:00Z" }),
]);
assert.deepEqual(archivedLatest, { savedCount: 1, lastSavedAt: new Date("2026-09-28T01:00:00Z") });

// 서울 기준 표기. UTC 날짜와 KST 날짜가 갈리는 경계도 서울 날짜로 판단한다.
const now = new Date("2026-09-30T12:00:00Z"); // KST 2026-09-30 21:00
assert.equal(formatDraftSavedAt(new Date("2026-09-30T09:06:00Z"), now), "오늘 18:06");
assert.equal(formatDraftSavedAt(new Date("2026-09-29T15:30:00Z"), now), "오늘 00:30");
assert.equal(formatDraftSavedAt(new Date("2026-09-29T14:30:00Z"), now), "9월 29일 23:30");
assert.equal(formatDraftSavedAt(new Date("2025-12-31T00:00:00Z"), now), "2025년 12월 31일 09:00");

assert.equal(
  formatDraftResumeCaption({ savedCount: 3, lastSavedAt: new Date("2026-09-30T09:06:00Z"), now }),
  "저장본 3 · 마지막 서버 저장 오늘 18:06 · 같은 문서와 작성 상태로 돌아가요",
);
assert.equal(
  formatDraftResumeCaption({ savedCount: 1, lastSavedAt: new Date("2026-09-12T02:15:00Z"), now }),
  "저장본 1 · 마지막 서버 저장 9월 12일 11:15 · 같은 문서와 작성 상태로 돌아가요",
);

console.log("draft resume: saved-count folding, Seoul timestamps and resume caption passed");
