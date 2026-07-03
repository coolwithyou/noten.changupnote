"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReviewField, ReviewLabelJson, ReviewStatus } from "@/lib/server/review/reviewDocsRepo";

interface ReviewDetailDoc {
  docId: string;
  docRef: string;
  sourceFilename: string | null;
  pageCount: number | null;
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  correctionNotes: string | null;
  reviewerComment: string | null;
  labeledBy: string | null;
  labelJson: ReviewLabelJson;
  pageImageKeys: string[];
}

export type QuestionKind = "quick_confirm" | "question" | "missing_sweep";
export type AnswerType = "confirm" | "yes_no_unsure" | "choice" | "short_text";

export interface ReviewQuestion {
  id: string;
  fieldIndex: number | null;
  page: number | null;
  kind: QuestionKind;
  prompt: string;
  answerType: AnswerType;
  options: Array<{ value: string; label: string }> | null;
  orderIndex: number;
  answer: { value: string; text?: string } | null;
}

const FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "date",
  "currency",
  "checkbox",
  "table",
  "file",
  "signature",
  "stamp",
  "unknown",
] as const;

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "대기",
  in_review: "검수중",
  approved: "확정",
};

/**
 * 보류 접두어 규약 (서버 reviewDocsRepo.HOLD_PREFIX 와 동일 문구여야 함).
 * notes 가 이 문구로 시작하면 "판정 보류" 상태로 취급한다.
 */
const HOLD_PREFIX = "판정 보류:";

function isHeld(notes: string | undefined): boolean {
  return typeof notes === "string" && notes.trimStart().startsWith(HOLD_PREFIX);
}

/** notes 에서 보류 사유(접두어 이후)를 추출. */
function holdReasonOf(notes: string | undefined): string {
  if (!isHeld(notes)) return "";
  const trimmed = (notes ?? "").trimStart();
  return trimmed.slice(HOLD_PREFIX.length).trimStart();
}

function pageImageUrl(key: string): string {
  const encoded = key.split("/").map((p) => encodeURIComponent(p)).join("/");
  return `/internal/review/api/page-image/${encoded}`;
}

function emptyField(page: number): ReviewField {
  return {
    key: "",
    label: "",
    section: "",
    type: "text",
    required: false,
    applicantFills: true,
    manual: false,
    page,
    bbox: null,
    notes: "",
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * 상세 화면 최상위. 질문 모드/전문 모드 토글을 관리하고 라벨(fields) 상태를 두 모드가 공유한다.
 * - 질문이 1개 이상이면 질문 모드가 기본. 0개면 전문 모드로 폴백.
 * - 질문 모드 답변은 서버에서 라벨을 즉시 갱신하므로, 반영분을 fields 에도 반영해 전문 모드가 최신을 본다.
 */
export function ReviewDetailView({
  reviewerEmail,
  doc,
  questions = [],
}: {
  reviewerEmail: string;
  doc: ReviewDetailDoc;
  questions?: ReviewQuestion[];
}) {
  const initialFields: ReviewField[] = Array.isArray(doc.labelJson.fields)
    ? doc.labelJson.fields.map((f) => ({ ...f }))
    : [];

  const [fields, setFields] = useState<ReviewField[]>(initialFields);
  const hasQuestions = questions.length > 0;
  const [mode, setMode] = useState<"question" | "expert">(hasQuestions ? "question" : "expert");

  const modeToggle = (
    <div className="inline-flex overflow-hidden rounded-md border border-slate-300 text-xs font-semibold">
      <button
        onClick={() => setMode("question")}
        disabled={!hasQuestions}
        className={`px-3 py-1.5 ${
          mode === "question" ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
        } ${!hasQuestions ? "cursor-not-allowed opacity-50" : ""}`}
        title={hasQuestions ? "질문에 답하며 검수합니다 (권장)" : "생성된 질문이 없습니다"}
      >
        질문 모드{hasQuestions ? ` (${questions.length})` : ""}
      </button>
      <button
        onClick={() => setMode("expert")}
        className={`border-l border-slate-300 px-3 py-1.5 ${
          mode === "expert" ? "bg-slate-700 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
        }`}
        title="필드를 직접 편집합니다 (운영자·예외 케이스용)"
      >
        전문 모드
      </button>
    </div>
  );

  if (mode === "question" && hasQuestions) {
    return (
      <QuestionMode
        reviewerEmail={reviewerEmail}
        doc={doc}
        questions={questions}
        fields={fields}
        setFields={setFields}
        modeToggle={modeToggle}
        onSwitchToExpert={() => setMode("expert")}
      />
    );
  }

  return (
    <ExpertMode
      reviewerEmail={reviewerEmail}
      doc={doc}
      fields={fields}
      setFields={setFields}
      modeToggle={modeToggle}
    />
  );
}

function ExpertMode({
  reviewerEmail,
  doc,
  fields,
  setFields,
  modeToggle,
}: {
  reviewerEmail: string;
  doc: ReviewDetailDoc;
  fields: ReviewField[];
  setFields: React.Dispatch<React.SetStateAction<ReviewField[]>>;
  modeToggle: ReactNode;
}) {
  const [reviewerComment, setReviewerComment] = useState<string>(doc.reviewerComment ?? "");
  const [status, setStatus] = useState<ReviewStatus>(doc.reviewStatus);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const totalPages = doc.pageImageKeys.length || doc.pageCount || 1;
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);

  const currentImageKey = doc.pageImageKeys[currentPage - 1] ?? null;

  const heldCount = useMemo(() => fields.filter((f) => isHeld(f.notes)).length, [fields]);

  /** 저장 안 된 변경이 있을 때 이탈 경고 (beforeunload). */
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  /** "확인 필요" 필터: 사전 라벨러가 notes 에 표시한 우선 확인 지점만 모아 본다 (전 페이지 대상). */
  const [showNeedsCheckOnly, setShowNeedsCheckOnly] = useState(false);
  const needsCheck = useMemo(
    () => fields.map((f, i) => ({ f, i })).filter(({ f }) => (f.notes ?? "").includes("확인 필요")),
    [fields],
  );

  const searchLower = search.trim().toLowerCase();

  const fieldsOnPage = useMemo(() => {
    const base = showNeedsCheckOnly
      ? needsCheck
      : fields.map((f, i) => ({ f, i })).filter(({ f }) => (f.page ?? 1) === currentPage);
    if (!searchLower) return base;
    return base.filter(
      ({ f }) =>
        (f.key ?? "").toLowerCase().includes(searchLower) ||
        (f.label ?? "").toLowerCase().includes(searchLower),
    );
  }, [fields, currentPage, showNeedsCheckOnly, needsCheck, searchLower]);

  /** 오버레이에 그릴 필드: 검색으로 좁히지 않고 현재 페이지 전체를 유지 (역방향 연동 대상). */
  const overlayFields = useMemo(() => {
    if (showNeedsCheckOnly) return needsCheck;
    return fields.map((f, i) => ({ f, i })).filter(({ f }) => (f.page ?? 1) === currentPage);
  }, [fields, currentPage, showNeedsCheckOnly, needsCheck]);

  const fieldRefs = useRef<Record<number, HTMLDivElement | null>>({});

  /** 필터 모드에서 필드 선택 시 해당 페이지로 점프. */
  function selectField(index: number) {
    setSelectedIndex(index);
    const page = fields[index]?.page;
    if (typeof page === "number" && page >= 1 && page !== currentPage) setCurrentPage(page);
  }

  /** 오버레이 박스 클릭 → 필드 선택 + 목록에서 스크롤 (역방향 연동). */
  function selectFieldFromOverlay(index: number) {
    setSelectedIndex(index);
    // 다음 프레임에 스크롤 (선택 스타일 반영 후).
    requestAnimationFrame(() => {
      fieldRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function updateField(index: number, patch: Partial<ReviewField>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
    setDirty(true);
  }

  function addField() {
    setFields((prev) => [...prev, emptyField(currentPage)]);
    setDirty(true);
    setSelectedIndex(fields.length);
  }

  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
    setSelectedIndex(null);
    setDirty(true);
  }

  // ── bbox 재작도 모드 ──────────────────────────────────────────
  const [redrawMode, setRedrawMode] = useState(false);
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const imageWrapRef = useRef<HTMLDivElement | null>(null);

  const canRedraw = selectedIndex != null;

  const cancelRedraw = useCallback(() => {
    setGhost(null);
    drawStart.current = null;
  }, []);

  // Esc 로 재작도 취소.
  useEffect(() => {
    if (!redrawMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelRedraw();
        setRedrawMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redrawMode, cancelRedraw]);

  function normPoint(e: React.MouseEvent): { x: number; y: number } | null {
    const el = imageWrapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  }

  function onDrawDown(e: React.MouseEvent) {
    if (!redrawMode || selectedIndex == null) return;
    const p = normPoint(e);
    if (!p) return;
    e.preventDefault();
    drawStart.current = p;
    setGhost({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function onDrawMove(e: React.MouseEvent) {
    if (!redrawMode || !drawStart.current) return;
    const p = normPoint(e);
    if (!p) return;
    const s = drawStart.current;
    setGhost({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  }

  function onDrawUp() {
    if (!redrawMode || !drawStart.current || selectedIndex == null) {
      cancelRedraw();
      return;
    }
    const g = ghost;
    drawStart.current = null;
    // 너무 작은 드래그는 무시 (오클릭 방지).
    if (!g || g.w < 0.005 || g.h < 0.005) {
      setGhost(null);
      return;
    }
    const bbox: [number, number, number, number] = [
      Number(g.x.toFixed(4)),
      Number(g.y.toFixed(4)),
      Number(g.w.toFixed(4)),
      Number(g.h.toFixed(4)),
    ];
    updateField(selectedIndex, { bbox });
    setGhost(null);
    setRedrawMode(false);
  }

  function buildLabelJson(): ReviewLabelJson {
    return {
      ...doc.labelJson,
      docRef: doc.docRef,
      ...(doc.pageCount != null ? { pageCount: doc.pageCount } : {}),
      fields,
    };
  }

  async function postJson(path: string, body?: unknown): Promise<{ ok: boolean; data: unknown }> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // no body
    }
    return { ok: res.ok, data };
  }

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    const { ok, data } = await postJson(`/internal/review/api/docs/${doc.docId}/save`, {
      labelJson: buildLabelJson(),
      reviewerComment: reviewerComment.trim() ? reviewerComment : null,
    });
    setBusy(false);
    if (ok) {
      setDirty(false);
      if (status !== "approved") setStatus("in_review");
      setMessage("초안을 저장했습니다.");
    } else {
      setMessage(`저장 실패: ${(data as { error?: string })?.error ?? "unknown"}`);
    }
  }

  async function handleApprove() {
    const warn =
      heldCount > 0
        ? `보류 ${heldCount}건이 있습니다. 그래도 확정하면 golden_set에 승격됩니다. 계속할까요?`
        : "확정하면 golden_set에 승격됩니다. 계속할까요?";
    if (!window.confirm(warn)) return;
    setBusy(true);
    setMessage(null);
    // 확정 직전 리뷰어 코멘트도 반영되도록 먼저 저장.
    await postJson(`/internal/review/api/docs/${doc.docId}/save`, {
      labelJson: buildLabelJson(),
      reviewerComment: reviewerComment.trim() ? reviewerComment : null,
    });
    const { ok, data } = await postJson(`/internal/review/api/docs/${doc.docId}/approve`, {
      labelJson: buildLabelJson(),
    });
    setBusy(false);
    if (ok) {
      setDirty(false);
      setStatus("approved");
      setMessage(`확정 완료 (golden ${(data as { goldenAction?: string })?.goldenAction ?? "upsert"}).`);
    } else {
      setMessage(`확정 실패: ${(data as { error?: string })?.error ?? "unknown"}`);
    }
  }

  async function handleUnapprove() {
    if (!window.confirm("확정을 취소하면 golden_set에서 제거됩니다. 계속할까요?")) return;
    setBusy(true);
    setMessage(null);
    const { ok, data } = await postJson(`/internal/review/api/docs/${doc.docId}/unapprove`);
    setBusy(false);
    if (ok) {
      setStatus("in_review");
      setMessage(`확정 취소 (golden ${(data as { goldenDeleted?: number })?.goldenDeleted ?? 0}건 제거).`);
    } else {
      setMessage(`취소 실패: ${(data as { error?: string })?.error ?? "unknown"}`);
    }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-6 text-slate-900">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/internal/review" className="text-sm text-indigo-600 hover:underline">
            ← 목록
          </Link>
          <h1 className="mt-1 text-xl font-bold">
            {doc.docId}
            <span className="ml-3 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
              {STATUS_LABEL[status]}
            </span>
            {heldCount > 0 && (
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                보류 {heldCount}
              </span>
            )}
          </h1>
          <p className="mt-1 max-w-2xl truncate text-sm text-slate-500" title={doc.docRef}>
            {doc.sourceFilename ?? doc.docRef} · {fields.length} 필드 · {totalPages} 페이지
          </p>
        </div>
        <div className="flex items-center gap-2">
          {modeToggle}
          <button
            onClick={handleSave}
            disabled={busy}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
          >
            초안 저장{dirty ? " *" : ""}
          </button>
          {status === "approved" ? (
            <button
              onClick={handleUnapprove}
              disabled={busy}
              className="rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              확정 취소
            </button>
          ) : (
            <button
              onClick={handleApprove}
              disabled={busy}
              className={`rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                heldCount > 0 ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-600 hover:bg-emerald-700"
              }`}
              title={heldCount > 0 ? `보류 ${heldCount}건이 있습니다` : undefined}
            >
              검수 확정{heldCount > 0 ? ` (보류 ${heldCount})` : ""}
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">{message}</div>
      )}

      {/* 접이식 검수 방법 요약 (인앤 튜토리얼 v1.1). */}
      <details className="mb-4 rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-900">
        <summary className="cursor-pointer font-semibold">검수 방법 요약 (펼치기)</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>&quot;확인 필요만&quot; 먼저 판정 → notes의 &quot;확인 필요&quot; 문구를 결론으로 바꾸기</li>
          <li>누락 필드 찾기 (특히 말미 서명행) → [+ 필드 추가]</li>
          <li>
            분류 확인: <strong>자필·서명 필요(manual)</strong> / <strong>type</strong> / <strong>필수(required)</strong>
          </li>
          <li>상자 위치는 크게 어긋난 것만: 필드 선택 → [bbox 다시 그리기] → 이미지 드래그 (Esc 취소)</li>
          <li>애매하면 필드 [보류] 토글로 남기고 확정하지 않기</li>
        </ol>
        <p className="mt-2">
          자세한 내용은{" "}
          <Link href="/internal/review/guide" className="font-semibold underline hover:text-indigo-700">
            검수 가이드
          </Link>{" "}
          참고.
        </p>
      </details>

      <div className="mb-4 space-y-2">
        {doc.correctionNotes && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            <span className="font-semibold">소급 교정·주의: </span>
            {doc.correctionNotes}
          </div>
        )}
        <div className="text-xs text-slate-500">
          기준서:{" "}
          <Link href="/internal/review/guide" className="text-indigo-600 hover:underline">
            검수 가이드
          </Link>{" "}
          · 원 라벨러: {doc.labeledBy ?? "—"}
          {status === "approved" && doc.reviewedBy && <> · 검수자: {doc.reviewedBy}</>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* 좌: 페이지 이미지 뷰어 */}
        <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-40"
              >
                ‹
              </button>
              <span className="tabular-nums">
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="rounded border border-slate-300 bg-white px-2 py-1 disabled:opacity-40"
              >
                ›
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (redrawMode) {
                    cancelRedraw();
                    setRedrawMode(false);
                  } else if (canRedraw) {
                    setRedrawMode(true);
                  }
                }}
                disabled={!canRedraw}
                className={`rounded border px-2 py-1 text-xs font-semibold ${
                  redrawMode
                    ? "border-indigo-500 bg-indigo-600 text-white"
                    : canRedraw
                      ? "border-slate-300 bg-white hover:bg-slate-50"
                      : "border-slate-200 bg-slate-100 text-slate-400"
                }`}
                title={
                  canRedraw
                    ? "선택한 필드의 상자를 이미지 위 드래그로 다시 그립니다 (Esc 취소)"
                    : "먼저 오른쪽에서 필드를 선택하세요"
                }
              >
                {redrawMode ? "그리는 중… (Esc 취소)" : "bbox 다시 그리기"}
              </button>
              <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="rounded border border-slate-300 bg-white px-2 py-1">
                −
              </button>
              <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((z) => Math.min(3, z + 0.25))} className="rounded border border-slate-300 bg-white px-2 py-1">
                +
              </button>
            </div>
          </div>
          <div className="max-h-[80vh] overflow-auto rounded border border-slate-200 bg-white">
            {currentImageKey ? (
              <div
                ref={imageWrapRef}
                className={`relative inline-block ${redrawMode ? "cursor-crosshair" : ""}`}
                style={{ width: `${zoom * 100}%` }}
                onMouseDown={onDrawDown}
                onMouseMove={onDrawMove}
                onMouseUp={onDrawUp}
                onMouseLeave={() => {
                  if (drawStart.current) onDrawUp();
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pageImageUrl(currentImageKey)}
                  alt={`${doc.docId} page ${currentPage}`}
                  className="pointer-events-none block w-full select-none"
                  draggable={false}
                />
                {overlayFields.map(({ f, i }) => {
                  const bbox = Array.isArray(f.bbox) ? f.bbox : null;
                  if (!bbox) return null;
                  const [x, y, w, h] = bbox;
                  const active = i === selectedIndex;
                  const held = isHeld(f.notes);
                  return (
                    <button
                      key={i}
                      onClick={() => !redrawMode && selectFieldFromOverlay(i)}
                      title={f.label || f.key || `field ${i}`}
                      className={`absolute border ${
                        redrawMode ? "pointer-events-none" : ""
                      } ${
                        active
                          ? "border-2 border-indigo-600 bg-indigo-400/25"
                          : held
                            ? "border-amber-500 bg-amber-400/20"
                            : "border-amber-400 bg-amber-300/10"
                      }`}
                      style={{
                        left: `${x * 100}%`,
                        top: `${y * 100}%`,
                        width: `${w * 100}%`,
                        height: `${h * 100}%`,
                      }}
                    />
                  );
                })}
                {ghost && (
                  <div
                    className="pointer-events-none absolute border-2 border-dashed border-indigo-600 bg-indigo-400/20"
                    style={{
                      left: `${ghost.x * 100}%`,
                      top: `${ghost.y * 100}%`,
                      width: `${ghost.w * 100}%`,
                      height: `${ghost.h * 100}%`,
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="p-10 text-center text-sm text-slate-400">이 페이지의 이미지가 없습니다.</div>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            {redrawMode
              ? "이미지 위에서 드래그해 새 상자를 그리세요. Esc로 취소합니다."
              : "필드를 선택한 뒤 [bbox 다시 그리기]로 상자를 다시 그릴 수 있습니다. 상자 클릭 시 해당 필드로 이동합니다."}
          </p>
        </section>

        {/* 우: 필드 목록/편집 */}
        <section className="rounded-lg border border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
            <h2 className="text-sm font-semibold">
              필드 ({fieldsOnPage.length} / {fields.length}
              {showNeedsCheckOnly ? " · 확인 필요" : ` · p${currentPage}`})
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="key/label 검색"
                className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                title="key/label 부분일치로 필드를 좁힙니다 (페이지·확인 필요 필터와 함께 동작)"
              />
              <button
                onClick={() => setShowNeedsCheckOnly((v) => !v)}
                className={`rounded border px-3 py-1 text-xs font-semibold ${
                  showNeedsCheckOnly
                    ? "border-amber-400 bg-amber-50 text-amber-800"
                    : "border-slate-300 bg-white hover:bg-slate-50"
                }`}
                title="사전 라벨러가 '확인 필요'로 표시한 필드만 전 페이지에서 모아 봅니다"
              >
                확인 필요만 ({needsCheck.length})
              </button>
              <button onClick={addField} className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold hover:bg-slate-50">
                + 필드 추가 (p{currentPage})
              </button>
            </div>
          </div>
          {/* 체크박스 용어 범례 1줄 (용어 한국어화 v1.1). */}
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-1.5 text-[11px] text-slate-500">
            범례 — <strong>필수</strong>: 반드시 채워야 하는 칸 · <strong>지원자가 작성</strong>: 지원자 몫(발급기관 몫 아님) ·{" "}
            <strong>자필·서명 필요</strong>: 사람이 직접 서명·직인·자필해야 하는 항목
          </div>
          <div className="max-h-[74vh] divide-y divide-slate-100 overflow-auto">
            {fieldsOnPage.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                {searchLower ? "검색 결과가 없습니다." : "이 페이지에 라벨된 필드가 없습니다."}
              </p>
            )}
            {fieldsOnPage.map(({ f, i }) => (
              <FieldEditor
                key={i}
                index={i}
                field={f}
                selected={i === selectedIndex}
                registerRef={(el) => {
                  fieldRefs.current[i] = el;
                }}
                onSelect={() => selectField(i)}
                onChange={(patch) => updateField(i, patch)}
                onRemove={() => removeField(i)}
              />
            ))}
          </div>
        </section>
      </div>

      {/* 문서별 리뷰어 코멘트 (피드백 채널 v1.1). */}
      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-slate-700">
            리뷰어 코멘트{" "}
            <span className="font-normal text-slate-400">— 운영자에게 남기는 문서별 메모 (원본 요청 등)</span>
          </span>
          <textarea
            value={reviewerComment}
            onChange={(e) => {
              setReviewerComment(e.target.value);
              setDirty(true);
            }}
            rows={2}
            placeholder="예: doc28 원본 HWP 파일 필요 / 5페이지 표 구조 애매"
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <p className="mt-1 text-xs text-slate-400">저장 시 함께 기록됩니다.</p>
      </section>

      <p className="mt-6 text-xs text-slate-400">검수자 {reviewerEmail} · 확정 시 labeledBy가 검수자 이메일로 갱신됩니다.</p>
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 질문 모드 (v2 기본): 카드 흐름으로 질문에 답한다.
// ──────────────────────────────────────────────────────────────────────────

const KIND_BADGE: Record<QuestionKind, { label: string; cls: string }> = {
  question: { label: "확인 질문", cls: "bg-indigo-100 text-indigo-800" },
  quick_confirm: { label: "빠른 확인", cls: "bg-slate-100 text-slate-700" },
  missing_sweep: { label: "누락 점검", cls: "bg-amber-100 text-amber-800" },
};

/**
 * bbox 주변 확대 크롭. 컨테이너는 고정 크기, img 를 absolute 로 배치하고
 * left/top 을 bbox 기준 음수 offset 으로 밀어 해당 칸만 확대해 보여준다.
 * bbox 가 없으면 페이지 전체를 컨테이너에 맞춰 축소한다.
 */
function BboxCrop({
  imageUrl,
  bbox,
}: {
  imageUrl: string | null;
  bbox: [number, number, number, number] | null | undefined;
}) {
  const BOX_W = 460;
  const BOX_H = 300;

  if (!imageUrl) {
    return (
      <div
        className="flex items-center justify-center rounded border border-slate-200 bg-slate-50 text-xs text-slate-400"
        style={{ width: BOX_W, height: BOX_H }}
      >
        이 페이지 이미지가 없습니다
      </div>
    );
  }

  const box = Array.isArray(bbox) ? bbox : null;
  if (!box) {
    // 페이지 전체 축소 표시.
    return (
      <div
        className="overflow-hidden rounded border border-slate-200 bg-white"
        style={{ width: BOX_W, height: BOX_H }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="page" className="h-full w-full object-contain" draggable={false} />
      </div>
    );
  }

  const [x, y, w, h] = box;
  // 목표 배율: bbox 가 컨테이너의 절반 정도 차지하도록. clamp 2~3x 상당(폭 기준).
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rawScale = w > 0 ? 0.5 / w : 2.5;
  const scale = Math.max(1.8, Math.min(3, rawScale));

  // 렌더 이미지의 표시 폭(=BOX_W * scale). bbox 중심이 컨테이너 중심에 오도록 offset.
  const dispW = BOX_W * scale;
  const dispH = BOX_H * scale;
  let left = BOX_W / 2 - cx * dispW;
  let top = BOX_H / 2 - cy * dispH;
  // 이미지가 컨테이너를 벗어나지 않게 clamp (여백 방지).
  left = Math.min(0, Math.max(BOX_W - dispW, left));
  top = Math.min(0, Math.max(BOX_H - dispH, top));

  // 하이라이트 박스(이미지 좌표계 → 컨테이너 좌표계).
  const hlLeft = left + x * dispW;
  const hlTop = top + y * dispH;
  const hlW = w * dispW;
  const hlH = h * dispH;

  return (
    <div
      className="relative overflow-hidden rounded border border-slate-200 bg-white"
      style={{ width: BOX_W, height: BOX_H }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="crop"
        className="absolute max-w-none select-none"
        style={{ left, top, width: dispW, height: dispH }}
        draggable={false}
      />
      <div
        className="pointer-events-none absolute border-2 border-indigo-500 bg-indigo-400/10"
        style={{ left: hlLeft, top: hlTop, width: hlW, height: hlH }}
      />
    </div>
  );
}

type LocalAnswers = Record<string, { value: string; text?: string }>;

function QuestionMode({
  reviewerEmail,
  doc,
  questions,
  fields,
  setFields,
  modeToggle,
  onSwitchToExpert,
}: {
  reviewerEmail: string;
  doc: ReviewDetailDoc;
  questions: ReviewQuestion[];
  fields: ReviewField[];
  setFields: React.Dispatch<React.SetStateAction<ReviewField[]>>;
  modeToggle: ReactNode;
  onSwitchToExpert: () => void;
}) {
  // 서버에서 온 기존 답변으로 로컬 상태 초기화.
  const [answers, setAnswers] = useState<LocalAnswers>(() => {
    const init: LocalAnswers = {};
    for (const q of questions) if (q.answer) init[q.id] = q.answer;
    return init;
  });
  const [idx, setIdx] = useState<number>(() => {
    const firstUnanswered = questions.findIndex((q) => !q.answer);
    return firstUnanswered === -1 ? questions.length : firstUnanswered;
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<ReviewStatus>(doc.reviewStatus);

  const answeredCount = useMemo(() => Object.keys(answers).length, [answers]);
  const total = questions.length;
  const done = idx >= total;

  const current = done ? null : questions[idx];

  function imageUrlForPage(page: number | null): string | null {
    if (page == null) return doc.pageImageKeys[0] ? pageImageUrl(doc.pageImageKeys[0]) : null;
    const key = doc.pageImageKeys[page - 1];
    return key ? pageImageUrl(key) : null;
  }

  /** applyMap 반영은 서버가 하지만, 전문 모드가 최신을 보도록 로컬 fields 에도 patch 를 반영. */
  function applyLocalPatch(q: ReviewQuestion, value: string, held: boolean, text?: string) {
    if (q.fieldIndex == null) return;
    setFields((prev) =>
      prev.map((f, i) => {
        if (i !== q.fieldIndex) return f;
        const next = { ...f };
        if (held) {
          const reason = text?.trim() || "모르겠음(질문 모드)";
          const rest = (next.notes ?? "").trim();
          const cleaned = rest.startsWith(HOLD_PREFIX) ? rest.slice(HOLD_PREFIX.length).trim() : rest;
          const merged = [reason, cleaned].filter(Boolean).join(" / ");
          next.notes = `${HOLD_PREFIX} ${merged}`;
        }
        return next;
      }),
    );
  }

  async function submitAnswer(q: ReviewQuestion, value: string, text?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(
        `/internal/review/api/docs/${doc.docId}/questions/${q.id}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value, ...(text ? { text } : {}) }),
        },
      );
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; held?: boolean; error?: string }
        | null;
      if (res.ok && data?.ok) {
        setAnswers((prev) => ({ ...prev, [q.id]: { value, ...(text ? { text } : {}) } }));
        applyLocalPatch(q, value, Boolean(data.held), text);
        if (status !== "approved") setStatus("in_review");
        setIdx((i) => i + 1);
      } else {
        setMessage(`저장 실패: ${data?.error ?? "unknown"}`);
      }
    } catch {
      setMessage("저장 실패: 네트워크 오류");
    } finally {
      setBusy(false);
    }
  }

  const heldCount = useMemo(() => fields.filter((f) => isHeld(f.notes)).length, [fields]);

  async function handleApprove() {
    const warn =
      heldCount > 0
        ? `보류 ${heldCount}건이 있습니다. 그래도 확정하면 golden_set에 승격됩니다. 계속할까요?`
        : "확정하면 golden_set에 승격됩니다. 계속할까요?";
    if (!window.confirm(warn)) return;
    setBusy(true);
    setMessage(null);
    // 확정 직전 현재 라벨(질문 반영분)을 저장.
    const labelJson: ReviewLabelJson = { ...doc.labelJson, docRef: doc.docRef, fields };
    await fetch(`/internal/review/api/docs/${doc.docId}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelJson }),
    });
    const res = await fetch(`/internal/review/api/docs/${doc.docId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelJson }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; goldenAction?: string; error?: string } | null;
    setBusy(false);
    if (res.ok && data?.ok) {
      setStatus("approved");
      setMessage(`확정 완료 (golden ${data.goldenAction ?? "upsert"}).`);
    } else {
      setMessage(`확정 실패: ${data?.error ?? "unknown"}`);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-6 text-slate-900">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/internal/review" className="text-sm text-indigo-600 hover:underline">
            ← 목록
          </Link>
          <h1 className="mt-1 text-xl font-bold">
            {doc.docId}
            <span className="ml-3 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
              {status === "approved" ? "확정" : status === "in_review" ? "검수중" : "대기"}
            </span>
          </h1>
          <p className="mt-1 max-w-2xl truncate text-sm text-slate-500" title={doc.docRef}>
            {doc.sourceFilename ?? doc.docRef}
          </p>
        </div>
        <div className="flex items-center gap-2">{modeToggle}</div>
      </div>

      {doc.correctionNotes && (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900">
          <span className="font-semibold">소급 교정·주의: </span>
          {doc.correctionNotes}
        </div>
      )}

      {/* 진행률 */}
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
          <span>
            진행 {Math.min(answeredCount, total)}/{total}
          </span>
          <Link href="/internal/review/guide" className="text-indigo-600 hover:underline">
            검수 가이드
          </Link>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-indigo-500 transition-all"
            style={{ width: `${total > 0 ? (Math.min(answeredCount, total) / total) * 100 : 0}%` }}
          />
        </div>
      </div>

      {message && (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">{message}</div>
      )}

      {current ? (
        <QuestionCard
          key={current.id}
          question={current}
          imageUrl={imageUrlForPage(current.page)}
          bbox={current.fieldIndex != null ? fields[current.fieldIndex]?.bbox : null}
          fieldLabel={current.fieldIndex != null ? fields[current.fieldIndex]?.label : undefined}
          existing={answers[current.id]?.value}
          busy={busy}
          position={`${idx + 1} / ${total}`}
          onAnswer={(value, text) => submitAnswer(current, value, text)}
          onPrev={idx > 0 ? () => setIdx((i) => i - 1) : undefined}
          onNext={() => setIdx((i) => i + 1)}
        />
      ) : (
        // 완료 화면
        <section className="rounded-lg border border-slate-200 p-6">
          <h2 className="text-lg font-bold">검수 질문 완료</h2>
          <p className="mt-2 text-sm text-slate-600">
            {total}개 질문 중 {answeredCount}개에 답했습니다.
            {answeredCount < total && " 아직 답하지 않은 질문이 있습니다 (이전으로 돌아가 답할 수 있습니다)."}
          </p>
          {heldCount > 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
              보류 {heldCount}건이 있습니다. 확정은 가능하지만, 운영자가 전문 모드에서 확인하는 것이 좋습니다.
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {status === "approved" ? (
              <span className="rounded-md bg-emerald-100 px-4 py-2 text-sm font-semibold text-emerald-800">확정 완료</span>
            ) : (
              <button
                onClick={handleApprove}
                disabled={busy}
                className={`rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
                  heldCount > 0 ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-600 hover:bg-emerald-700"
                }`}
              >
                검수 확정{heldCount > 0 ? ` (보류 ${heldCount})` : ""}
              </button>
            )}
            <button
              onClick={() => setIdx(0)}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              처음부터 다시 보기
            </button>
            <button
              onClick={onSwitchToExpert}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              전문 모드로 검토
            </button>
          </div>
        </section>
      )}

      <p className="mt-6 text-xs text-slate-400">검수자 {reviewerEmail} · 답변은 즉시 저장되며 라벨에 반영됩니다.</p>
    </main>
  );
}

function QuestionCard({
  question,
  imageUrl,
  bbox,
  fieldLabel,
  existing,
  busy,
  position,
  onAnswer,
  onPrev,
  onNext,
}: {
  question: ReviewQuestion;
  imageUrl: string | null;
  bbox: [number, number, number, number] | null | undefined;
  fieldLabel?: string | undefined;
  existing?: string | undefined;
  busy: boolean;
  position: string;
  onAnswer: (value: string, text?: string) => void;
  onPrev?: (() => void) | undefined;
  onNext: () => void;
}) {
  const [textValue, setTextValue] = useState("");
  const badge = KIND_BADGE[question.kind];

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge.cls}`}>{badge.label}</span>
        <span className="text-xs tabular-nums text-slate-400">{position}</span>
      </div>

      <div className="mb-4 flex justify-center">
        <BboxCrop imageUrl={imageUrl} bbox={bbox} />
      </div>

      {fieldLabel && (
        <p className="mb-1 text-center text-xs text-slate-400" title={fieldLabel}>
          대상 칸: {fieldLabel}
        </p>
      )}
      <p className="mb-4 text-center text-base font-semibold leading-relaxed">{question.prompt}</p>

      {existing && (
        <p className="mb-2 text-center text-xs text-slate-400">이전 답변: {existing} — 다시 답하면 갱신됩니다.</p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {question.answerType === "confirm" && (
          <>
            <AnswerButton disabled={busy} onClick={() => onAnswer("ok")} tone="ok">
              맞음
            </AnswerButton>
            <AnswerButton disabled={busy} onClick={() => onAnswer("edit")} tone="warn">
              수정 필요
            </AnswerButton>
          </>
        )}
        {question.answerType === "yes_no_unsure" && (
          <>
            <AnswerButton disabled={busy} onClick={() => onAnswer("yes")} tone="ok">
              예
            </AnswerButton>
            <AnswerButton disabled={busy} onClick={() => onAnswer("no")} tone="plain">
              아니오
            </AnswerButton>
            <AnswerButton disabled={busy} onClick={() => onAnswer("unsure")} tone="warn">
              모르겠음
            </AnswerButton>
          </>
        )}
        {question.answerType === "choice" &&
          (question.options ?? []).map((o) => (
            <AnswerButton key={o.value} disabled={busy} onClick={() => onAnswer(o.value)} tone="plain">
              {o.label}
            </AnswerButton>
          ))}
        {question.answerType === "short_text" && (
          <div className="flex w-full items-center gap-2">
            <input
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder="한 줄로 답해 주세요"
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <AnswerButton
              disabled={busy || !textValue.trim()}
              onClick={() => onAnswer(textValue.trim(), textValue.trim())}
              tone="ok"
            >
              저장
            </AnswerButton>
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between text-sm">
        <button
          onClick={onPrev}
          disabled={!onPrev}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          ‹ 이전
        </button>
        <button
          onClick={onNext}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-600 hover:bg-slate-50"
          title="답하지 않고 건너뜁니다"
        >
          건너뛰기 ›
        </button>
      </div>
    </section>
  );
}

function AnswerButton({
  children,
  disabled,
  onClick,
  tone,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tone: "ok" | "warn" | "plain";
}) {
  const cls =
    tone === "ok"
      ? "bg-emerald-600 text-white hover:bg-emerald-700"
      : tone === "warn"
        ? "bg-amber-500 text-white hover:bg-amber-600"
        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-5 py-2.5 text-sm font-semibold disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
}

function FieldEditor({
  index,
  field,
  selected,
  registerRef,
  onSelect,
  onChange,
  onRemove,
}: {
  index: number;
  field: ReviewField;
  selected: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  onSelect: () => void;
  onChange: (patch: Partial<ReviewField>) => void;
  onRemove: () => void;
}) {
  const bbox = Array.isArray(field.bbox) ? field.bbox : null;
  const held = isHeld(field.notes);
  const holdReason = holdReasonOf(field.notes);

  /** [보류] 토글: notes 접두어(`판정 보류: `)를 관리한다. */
  function toggleHold(next: boolean) {
    if (next) {
      if (held) return;
      const rest = (field.notes ?? "").trim();
      onChange({ notes: rest ? `${HOLD_PREFIX} ${rest}` : `${HOLD_PREFIX} ` });
    } else {
      // 보류 해제: 접두어 제거, 사유는 일반 notes 로 남긴다.
      onChange({ notes: holdReason });
    }
  }

  function setHoldReason(reason: string) {
    onChange({ notes: `${HOLD_PREFIX} ${reason}` });
  }

  return (
    <div
      ref={registerRef}
      onClick={onSelect}
      className={`cursor-pointer px-4 py-3 text-sm ${
        selected ? "bg-indigo-50" : held ? "bg-amber-50/60 hover:bg-amber-50" : "hover:bg-slate-50"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-400">
          #{index}
          {held && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">보류</span>
          )}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="rounded border border-rose-200 px-2 py-0.5 text-xs text-rose-600 hover:bg-rose-50"
        >
          삭제
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="key">
          <input
            value={field.key ?? ""}
            onChange={(e) => onChange({ key: e.target.value })}
            className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
          />
        </Labeled>
        <Labeled label="type">
          <select
            value={field.type ?? "text"}
            onChange={(e) => onChange({ type: e.target.value })}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="label" full>
          <input
            value={field.label ?? ""}
            onChange={(e) => onChange({ label: e.target.value })}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />
        </Labeled>
        <Labeled label="section" full>
          <input
            value={field.section ?? ""}
            onChange={(e) => onChange({ section: e.target.value })}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />
        </Labeled>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-xs">
        <Checkbox
          label="필수 (required)"
          title="별표·'필수' 표기가 있는 항목만 켭니다"
          checked={Boolean(field.required)}
          onChange={(v) => onChange({ required: v })}
        />
        <Checkbox
          label="지원자가 작성 (applicantFills)"
          title="지원자가 채우는 칸이면 켭니다 (발급기관·심사자 몫이면 끕니다)"
          checked={field.applicantFills !== false}
          onChange={(v) => onChange({ applicantFills: v })}
        />
        <Checkbox
          label="자필·서명 필요 (manual)"
          title="서명·직인·자필 동의 등 사람이 반드시 직접 해야 하는 항목이면 켭니다"
          checked={Boolean(field.manual)}
          onChange={(v) => onChange({ manual: v })}
        />
        <span className="text-slate-400">bbox: {bbox ? bbox.map((n) => n.toFixed(2)).join(", ") : "null"}</span>
      </div>

      {/* 보류 토글 + 사유 (피드백 채널 v1.1) */}
      <div className="mt-2 rounded border border-amber-200 bg-amber-50/40 px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
        <label className="flex items-center gap-1 text-xs" title="판정이 애매하면 보류로 남기고 확정하지 않습니다">
          <input type="checkbox" checked={held} onChange={(e) => toggleHold(e.target.checked)} />
          <span className="font-semibold text-amber-800">판정 보류</span>
        </label>
        {held && (
          <input
            value={holdReason}
            onChange={(e) => setHoldReason(e.target.value)}
            placeholder="보류 사유 (예: 표 구조 애매, 원본 확인 필요)"
            className="mt-1 w-full rounded border border-amber-300 px-2 py-1 text-xs"
          />
        )}
      </div>

      <div className="mt-2">
        <Labeled label="notes" full>
          <textarea
            value={field.notes ?? ""}
            onChange={(e) => onChange({ notes: e.target.value })}
            rows={2}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />
        </Labeled>
      </div>
    </div>
  );
}

function Labeled({ label, full, children }: { label: string; full?: boolean; children: ReactNode }) {
  return (
    <label className={`block ${full ? "col-span-2" : ""}`}>
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

function Checkbox({
  label,
  title,
  checked,
  onChange,
}: {
  label: string;
  title?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1" title={title} onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
