"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

export function ReviewDetailView({
  reviewerEmail,
  doc,
}: {
  reviewerEmail: string;
  doc: ReviewDetailDoc;
}) {
  const initialFields: ReviewField[] = Array.isArray(doc.labelJson.fields)
    ? doc.labelJson.fields.map((f) => ({ ...f }))
    : [];

  const [fields, setFields] = useState<ReviewField[]>(initialFields);
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
