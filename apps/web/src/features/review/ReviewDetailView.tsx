"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import type { ReviewField, ReviewLabelJson, ReviewStatus } from "@/lib/server/review/reviewDocsRepo";

interface ReviewDetailDoc {
  docId: string;
  docRef: string;
  sourceFilename: string | null;
  pageCount: number | null;
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  correctionNotes: string | null;
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
  const [status, setStatus] = useState<ReviewStatus>(doc.reviewStatus);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const totalPages = doc.pageImageKeys.length || doc.pageCount || 1;
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);

  const currentImageKey = doc.pageImageKeys[currentPage - 1] ?? null;

  const fieldsOnPage = useMemo(
    () => fields.map((f, i) => ({ f, i })).filter(({ f }) => (f.page ?? 1) === currentPage),
    [fields, currentPage],
  );

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
    if (!window.confirm("확정하면 golden_set에 승격됩니다. 계속할까요?")) return;
    setBusy(true);
    setMessage(null);
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
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              검수 확정
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">{message}</div>
      )}

      <div className="mb-4 space-y-2">
        {doc.correctionNotes && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            <span className="font-semibold">소급 교정·주의: </span>
            {doc.correctionNotes}
          </div>
        )}
        <div className="text-xs text-slate-500">
          기준서:{" "}
          <a
            href="https://github.com"
            className="text-indigo-600 hover:underline"
            onClick={(e) => e.preventDefault()}
            title="docs/gate1-field-map-labeling-guide.md"
          >
            docs/gate1-field-map-labeling-guide.md
          </a>{" "}
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
            <div className="flex items-center gap-1">
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
              <div className="relative inline-block" style={{ width: `${zoom * 100}%` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={pageImageUrl(currentImageKey)} alt={`${doc.docId} page ${currentPage}`} className="block w-full select-none" />
                {fieldsOnPage.map(({ f, i }) => {
                  const bbox = Array.isArray(f.bbox) ? f.bbox : null;
                  if (!bbox) return null;
                  const [x, y, w, h] = bbox;
                  const active = i === selectedIndex;
                  return (
                    <button
                      key={i}
                      onClick={() => setSelectedIndex(i)}
                      title={f.label || f.key || `field ${i}`}
                      className={`absolute border ${active ? "border-2 border-indigo-600 bg-indigo-400/25" : "border-amber-400 bg-amber-300/10"}`}
                      style={{
                        left: `${x * 100}%`,
                        top: `${y * 100}%`,
                        width: `${w * 100}%`,
                        height: `${h * 100}%`,
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="p-10 text-center text-sm text-slate-400">이 페이지의 이미지가 없습니다.</div>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            bbox 정밀 재작도는 v1.1 예정. 현재는 오버레이 확인 + 필드 좌표 수동 입력만 지원합니다.
          </p>
        </section>

        {/* 우: 필드 목록/편집 */}
        <section className="rounded-lg border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <h2 className="text-sm font-semibold">필드 ({fieldsOnPage.length} / {fields.length} · p{currentPage})</h2>
            <button onClick={addField} className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold hover:bg-slate-50">
              + 필드 추가 (p{currentPage})
            </button>
          </div>
          <div className="max-h-[80vh] divide-y divide-slate-100 overflow-auto">
            {fieldsOnPage.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-slate-400">이 페이지에 라벨된 필드가 없습니다.</p>
            )}
            {fieldsOnPage.map(({ f, i }) => (
              <FieldEditor
                key={i}
                index={i}
                field={f}
                selected={i === selectedIndex}
                onSelect={() => setSelectedIndex(i)}
                onChange={(patch) => updateField(i, patch)}
                onRemove={() => removeField(i)}
              />
            ))}
          </div>
        </section>
      </div>
      <p className="mt-6 text-xs text-slate-400">검수자 {reviewerEmail} · 확정 시 labeledBy가 검수자 이메일로 갱신됩니다.</p>
    </main>
  );
}

function FieldEditor({
  index,
  field,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  index: number;
  field: ReviewField;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<ReviewField>) => void;
  onRemove: () => void;
}) {
  const bbox = Array.isArray(field.bbox) ? field.bbox : null;

  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer px-4 py-3 text-sm ${selected ? "bg-indigo-50" : "hover:bg-slate-50"}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-400">#{index}</span>
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
        <Checkbox label="required" checked={Boolean(field.required)} onChange={(v) => onChange({ required: v })} />
        <Checkbox label="applicantFills" checked={field.applicantFills !== false} onChange={(v) => onChange({ applicantFills: v })} />
        <Checkbox label="manual" checked={Boolean(field.manual)} onChange={(v) => onChange({ manual: v })} />
        <span className="text-slate-400">
          bbox: {bbox ? bbox.map((n) => n.toFixed(2)).join(", ") : "null"}
        </span>
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

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
