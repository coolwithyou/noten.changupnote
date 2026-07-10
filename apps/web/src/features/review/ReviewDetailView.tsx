"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  Minus,
  Plus,
  RotateCcw,
  Save,
  ScanLine,
  Trash2,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ReviewDocEvidence, ReviewField, ReviewLabelJson, ReviewStatus } from "@/lib/server/review/reviewDocsRepo";
import { ReviewWorkspaceShell } from "./ReviewWorkspaceShell";

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
  evidence: ReviewDocEvidence | null;
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

const FIELD_TYPE_ITEMS = FIELD_TYPES.map((value) => ({ value, label: value }));

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "대기",
  in_review: "검수중",
  approved: "확정",
};

const KIND_LABEL: Record<QuestionKind, string> = {
  question: "확인 질문",
  quick_confirm: "빠른 확인",
  missing_sweep: "누락 점검",
};

const HOLD_PREFIX = "판정 보류:";

function isHeld(notes: string | undefined): boolean {
  return typeof notes === "string" && notes.trimStart().startsWith(HOLD_PREFIX);
}

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

function statusVariant(status: ReviewStatus): "default" | "secondary" | "outline" {
  if (status === "approved") return "default";
  if (status === "in_review") return "secondary";
  return "outline";
}

function StatusBadge({ status }: { status: ReviewStatus }) {
  return <Badge variant={statusVariant(status)}>{STATUS_LABEL[status]}</Badge>;
}

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
    <ToggleGroup
      value={[mode]}
      onValueChange={(value) => {
        const nextMode = value.at(-1);
        if (nextMode === "question" && hasQuestions) setMode("question");
        if (nextMode === "expert") setMode("expert");
      }}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="검수 모드"
    >
      <ToggleGroupItem value="question" disabled={!hasQuestions} title={hasQuestions ? "질문에 답하며 검수합니다" : "생성된 질문이 없습니다"}>
        질문 모드{hasQuestions ? ` ${questions.length}` : ""}
      </ToggleGroupItem>
      <ToggleGroupItem value="expert" title="필드를 직접 편집합니다">
        전문 모드
      </ToggleGroupItem>
    </ToggleGroup>
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

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

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

  const overlayFields = useMemo(() => {
    if (showNeedsCheckOnly) return needsCheck;
    return fields.map((f, i) => ({ f, i })).filter(({ f }) => (f.page ?? 1) === currentPage);
  }, [fields, currentPage, showNeedsCheckOnly, needsCheck]);

  const fieldRefs = useRef<Record<number, HTMLDivElement | null>>({});

  function selectField(index: number) {
    setSelectedIndex(index);
    const page = fields[index]?.page;
    if (typeof page === "number" && page >= 1 && page !== currentPage) setCurrentPage(page);
  }

  function selectFieldFromOverlay(index: number) {
    setSelectedIndex(index);
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

  const [redrawMode, setRedrawMode] = useState(false);
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const imageWrapRef = useRef<HTMLDivElement | null>(null);

  const canRedraw = selectedIndex != null;

  const cancelRedraw = useCallback(() => {
    setGhost(null);
    drawStart.current = null;
  }, []);

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
    <ReviewWorkspaceShell
      reviewerEmail={reviewerEmail}
      currentPath={`/internal/review/${doc.docId}`}
      title={doc.docId}
      description={`${doc.sourceFilename ?? doc.docRef} · ${fields.length} 필드 · ${totalPages} 페이지`}
      badge="전문 모드"
      document={{
        docId: doc.docId,
        statusLabel: STATUS_LABEL[status],
        fieldCount: fields.length,
        pageCount: totalPages,
      }}
      metrics={[
        { label: "보류", value: heldCount },
        { label: "현재 페이지", value: `${currentPage}/${totalPages}` },
        { label: "저장 상태", value: dirty ? "저장 필요" : "저장됨" },
      ]}
      actions={
        <>
          <Link href="/internal/review" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            <ArrowLeft data-icon="inline-start" />
            목록
          </Link>
          {modeToggle}
          <Button variant="outline" size="sm" onClick={handleSave} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
            초안 저장{dirty ? " *" : ""}
          </Button>
          {status === "approved" ? (
            <Button variant="destructive" size="sm" onClick={handleUnapprove} disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}
              확정 취소
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={heldCount > 0 ? "secondary" : "default"}
                    size="sm"
                    onClick={handleApprove}
                    disabled={busy}
                  >
                    {busy ? <Spinner data-icon="inline-start" /> : <CheckCircle2 data-icon="inline-start" />}
                    검수 확정{heldCount > 0 ? ` (보류 ${heldCount})` : ""}
                  </Button>
                }
              />
              {heldCount > 0 ? <TooltipContent>보류 {heldCount}건이 있습니다</TooltipContent> : null}
            </Tooltip>
          )}
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5">

        {message ? (
          <Alert>
            <AlertTitle>처리 결과</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.86fr)]">
          <Card className="self-start">
            <CardHeader>
              <CardTitle>문서 이미지</CardTitle>
              <CardDescription>
                {redrawMode
                  ? "이미지 위에서 드래그해 새 상자를 그리세요. Esc로 취소합니다."
                  : "필드를 선택한 뒤 bbox를 다시 그릴 수 있습니다."}
              </CardDescription>
              <CardAction>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="이전 페이지"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage <= 1}
                  >
                    <ChevronLeft />
                  </Button>
                  <Badge variant="outline" className="h-7">
                    {currentPage} / {totalPages}
                  </Badge>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="다음 페이지"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage >= totalPages}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={redrawMode ? "default" : "outline"}
                        size="sm"
                        onClick={() => {
                          if (redrawMode) {
                            cancelRedraw();
                            setRedrawMode(false);
                          } else if (canRedraw) {
                            setRedrawMode(true);
                          }
                        }}
                        disabled={!canRedraw}
                      >
                        <ScanLine data-icon="inline-start" />
                        {redrawMode ? "그리는 중" : "bbox 다시 그리기"}
                      </Button>
                    }
                  />
                  <TooltipContent>
                    {canRedraw ? "선택한 필드의 상자를 이미지 위 드래그로 다시 그립니다" : "먼저 오른쪽에서 필드를 선택하세요"}
                  </TooltipContent>
                </Tooltip>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon-sm" aria-label="축소" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>
                    <Minus />
                  </Button>
                  <Badge variant="secondary" className="h-7 min-w-14 justify-center tabular-nums">
                    {Math.round(zoom * 100)}%
                  </Badge>
                  <Button variant="outline" size="icon-sm" aria-label="확대" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
                    <Plus />
                  </Button>
                </div>
              </div>

              <div className="max-h-[78vh] overflow-auto rounded-[var(--radius-xl)] border bg-card">
                {currentImageKey ? (
                  <div
                    ref={imageWrapRef}
                    className={cn("relative inline-block", redrawMode && "cursor-crosshair")}
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
                      const overlayLabel = f.label || f.key || `field ${i}`;
                      return (
                        <Tooltip key={i}>
                          <TooltipTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                aria-label={overlayLabel}
                                onClick={() => !redrawMode && selectFieldFromOverlay(i)}
                                className={cn(
                                  "absolute size-auto min-w-0 rounded-none border bg-primary/10 p-0 transition-colors",
                                  redrawMode && "pointer-events-none",
                                  active
                                    ? "border-2 border-primary bg-primary/25"
                                    : held
                                      ? "border-destructive bg-destructive/15"
                                      : "border-primary/60",
                                )}
                                // 동적 좌표: bbox 정규화값(%)의 계산 결과 — 인라인 style 예외 유지
                                style={{
                                  left: `${x * 100}%`,
                                  top: `${y * 100}%`,
                                  width: `${w * 100}%`,
                                  height: `${h * 100}%`,
                                }}
                              />
                            }
                          />
                          <TooltipContent>{overlayLabel}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                    {ghost ? (
                      <div
                        className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/20"
                        style={{
                          left: `${ghost.x * 100}%`,
                          top: `${ghost.y * 100}%`,
                          width: `${ghost.w * 100}%`,
                          height: `${ghost.h * 100}%`,
                        }}
                      />
                    ) : null}
                  </div>
                ) : (
                  <Empty className="min-h-80">
                    <EmptyHeader>
                      <EmptyTitle>이 페이지의 이미지가 없습니다.</EmptyTitle>
                      <EmptyDescription>다른 페이지를 선택하거나 문서 임포트 상태를 확인하세요.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="self-start">
            <CardHeader>
              <CardTitle>
                필드 {fieldsOnPage.length} / {fields.length}
              </CardTitle>
              <CardDescription>{showNeedsCheckOnly ? "확인 필요 필드만 표시 중" : `현재 페이지 p${currentPage}`}</CardDescription>
              <CardAction>
                <Button variant="outline" size="sm" onClick={addField}>
                  <Plus data-icon="inline-start" />
                  필드 추가
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="key/label 검색"
                        className="h-10 sm:max-w-52"
                      />
                    }
                  />
                  <TooltipContent>key/label 부분일치로 필드를 좁힙니다</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={showNeedsCheckOnly ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => setShowNeedsCheckOnly((v) => !v)}
                      >
                        확인 필요만 ({needsCheck.length})
                      </Button>
                    }
                  />
                  <TooltipContent>사전 라벨러가 &apos;확인 필요&apos;로 표시한 필드만 전 페이지에서 모아 봅니다</TooltipContent>
                </Tooltip>
              </div>

              <Alert>
                <AlertTitle>판정 속성</AlertTitle>
                <AlertDescription>
                  필수는 반드시 채워야 하는 칸, 지원자가 작성은 발급기관 몫이 아닌 칸, 자필·서명 필요는 사람이 직접 처리해야 하는 항목입니다.
                </AlertDescription>
              </Alert>

              <div className="max-h-[70vh] overflow-auto rounded-[var(--radius-xl)] border">
                {fieldsOnPage.length === 0 ? (
                  <Empty className="min-h-64 border-0">
                    <EmptyHeader>
                      <EmptyTitle>{searchLower ? "검색 결과가 없습니다." : "이 페이지에 라벨된 필드가 없습니다."}</EmptyTitle>
                      <EmptyDescription>필요하면 현재 페이지에 새 필드를 추가하세요.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  fieldsOnPage.map(({ f, i }) => (
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
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>리뷰어 코멘트</CardTitle>
            <CardDescription>운영자에게 남기는 문서별 메모입니다. 원본 요청, 애매한 표 구조 등을 적습니다.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reviewer-comment">코멘트</FieldLabel>
                <Textarea
                  id="reviewer-comment"
                  value={reviewerComment}
                  onChange={(e) => {
                    setReviewerComment(e.target.value);
                    setDirty(true);
                  }}
                  rows={2}
                  placeholder="예: doc28 원본 HWP 파일 필요 / 5페이지 표 구조 애매"
                />
                <FieldDescription>저장 시 함께 기록됩니다.</FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <p className="text-xs text-muted-foreground">
              검수자 {reviewerEmail} · 확정 시 labeledBy가 검수자 이메일로 갱신됩니다.
            </p>
          </CardFooter>
        </Card>
      </div>
    </ReviewWorkspaceShell>
  );
}

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
      <Empty className="h-[300px] w-[460px] max-w-full border border-border">
        <EmptyHeader>
          <EmptyTitle>이미지 없음</EmptyTitle>
          <EmptyDescription>이 페이지 이미지를 찾지 못했습니다.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const box = Array.isArray(bbox) ? bbox : null;
  if (!box) {
    return (
      <div className="h-[300px] w-[460px] max-w-full overflow-hidden rounded-[var(--radius-xl)] border bg-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="page" className="h-full w-full object-contain" draggable={false} />
      </div>
    );
  }

  const [x, y, w, h] = box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rawScale = w > 0 ? 0.5 / w : 2.5;
  const scale = Math.max(1.8, Math.min(3, rawScale));
  const dispW = BOX_W * scale;
  const dispH = BOX_H * scale;
  let left = BOX_W / 2 - cx * dispW;
  let top = BOX_H / 2 - cy * dispH;
  left = Math.min(0, Math.max(BOX_W - dispW, left));
  top = Math.min(0, Math.max(BOX_H - dispH, top));

  const hlLeft = left + x * dispW;
  const hlTop = top + y * dispH;
  const hlW = w * dispW;
  const hlH = h * dispH;

  return (
    <div className="relative h-[300px] w-[460px] max-w-full overflow-hidden rounded-[var(--radius-xl)] border bg-card">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="crop"
        className="absolute max-w-none select-none"
        style={{ left, top, width: dispW, height: dispH }}
        draggable={false}
      />
      <div
        className="pointer-events-none absolute border-2 border-primary bg-primary/10"
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
  const progress = total > 0 ? Math.round((Math.min(answeredCount, total) / total) * 100) : 0;
  const totalPages = doc.pageImageKeys.length || doc.pageCount || 1;
  const currentQuestionPage = useMemo(() => {
    if (!current) return null;
    if (typeof current.page === "number" && current.page >= 1) return current.page;
    if (current.fieldIndex != null) {
      const fieldPage = fields[current.fieldIndex]?.page;
      return typeof fieldPage === "number" && fieldPage >= 1 ? fieldPage : null;
    }
    return null;
  }, [current, fields]);
  const [documentPage, setDocumentPage] = useState(() => currentQuestionPage ?? 1);

  useEffect(() => {
    if (currentQuestionPage == null) return;
    setDocumentPage(Math.max(1, Math.min(totalPages, currentQuestionPage)));
  }, [current?.id, currentQuestionPage, totalPages]);

  function imageUrlForPage(page: number | null): string | null {
    if (page == null) return doc.pageImageKeys[0] ? pageImageUrl(doc.pageImageKeys[0]) : null;
    const key = doc.pageImageKeys[page - 1];
    return key ? pageImageUrl(key) : null;
  }

  const documentImageUrl = imageUrlForPage(documentPage);
  const documentFields = useMemo(
    () => fields.map((f, i) => ({ f, i })).filter(({ f }) => (f.page ?? 1) === documentPage),
    [fields, documentPage],
  );

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
      const res = await fetch(`/internal/review/api/docs/${doc.docId}/questions/${q.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, ...(text ? { text } : {}) }),
      });
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
    <ReviewWorkspaceShell
      reviewerEmail={reviewerEmail}
      currentPath={`/internal/review/${doc.docId}`}
      title={doc.docId}
      description={doc.sourceFilename ?? doc.docRef}
      badge="질문 모드"
      document={{
        docId: doc.docId,
        statusLabel: STATUS_LABEL[status],
        fieldCount: fields.length,
        pageCount: totalPages,
      }}
      metrics={[
        { label: "답변", value: `${Math.min(answeredCount, total)}/${total}` },
        { label: "진행률", value: `${progress}%` },
        { label: "보류", value: heldCount },
      ]}
      actions={
        <>
          <Link href="/internal/review" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            <ArrowLeft data-icon="inline-start" />
            목록
          </Link>
          {modeToggle}
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-5">

        {doc.correctionNotes ? (
          <Alert variant="destructive">
            <AlertTitle>소급 교정·주의</AlertTitle>
            <AlertDescription>{doc.correctionNotes}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>질문 진행</CardTitle>
            <CardDescription>
              {Math.min(answeredCount, total)}/{total}개 답변 완료
            </CardDescription>
            <CardAction>
              <Link href="/internal/review/guide" className="text-sm font-medium text-primary hover:underline">
                검수 가이드
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            <Progress value={progress}>
              <ProgressLabel>진행률</ProgressLabel>
              <ProgressValue />
            </Progress>
          </CardContent>
        </Card>

        {message ? (
          <Alert>
            <AlertTitle>처리 결과</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}

        {current ? (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(280px,0.62fr)_minmax(420px,0.9fr)_minmax(420px,0.9fr)]">
            <div className="order-2 xl:order-1">
              <EvidenceSourcePanel evidence={doc.evidence} docRef={doc.docRef} sourceFilename={doc.sourceFilename} />
            </div>
            <div className="order-1 xl:order-2">
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
            </div>
            <div className="order-3">
              <QuestionDocumentPanel
                docId={doc.docId}
                imageUrl={documentImageUrl}
                page={documentPage}
                totalPages={totalPages}
                questionPage={currentQuestionPage}
                fields={documentFields}
                activeFieldIndex={current.fieldIndex}
                onPageChange={setDocumentPage}
              />
            </div>
          </div>
        ) : (
          <Card>
            <CardContent>
              <Empty>
                <EmptyMedia variant="icon">
                  <CheckCircle2 />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>검수 질문 완료</EmptyTitle>
                  <EmptyDescription>
                    {total}개 질문 중 {answeredCount}개에 답했습니다.
                    {answeredCount < total ? " 아직 답하지 않은 질문이 있습니다." : ""}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              {status === "approved" ? (
                <Badge variant="default">확정 완료</Badge>
              ) : (
                <Button variant={heldCount > 0 ? "secondary" : "default"} onClick={handleApprove} disabled={busy}>
                  {busy ? <Spinner data-icon="inline-start" /> : <CheckCircle2 data-icon="inline-start" />}
                  검수 확정{heldCount > 0 ? ` (보류 ${heldCount})` : ""}
                </Button>
              )}
              <Button variant="outline" onClick={() => setIdx(0)}>
                처음부터 다시 보기
              </Button>
              <Button variant="outline" onClick={onSwitchToExpert}>
                전문 모드로 검토
              </Button>
            </CardFooter>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">검수자 {reviewerEmail} · 답변은 즉시 저장되며 라벨에 반영됩니다.</p>
      </div>
    </ReviewWorkspaceShell>
  );
}

function EvidenceSourcePanel({
  evidence,
  docRef,
  sourceFilename,
}: {
  evidence: ReviewDocEvidence | null;
  docRef: string;
  sourceFilename: string | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const grantUrl = evidence?.grant?.url ?? null;
  const documentUrl = evidence?.attachment?.sourceUri ?? evidence?.surface?.sourceUrl ?? evidence?.attachment?.archiveUrl ?? null;
  const archiveUrl =
    evidence?.attachment?.archiveUrl && evidence.attachment.archiveUrl !== documentUrl
      ? evidence.attachment.archiveUrl
      : null;
  const displayFilename = evidence?.sourceFilename ?? sourceFilename ?? evidence?.attachment?.filename ?? docRef;

  async function copyValue(label: string, value: string | null) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1400);
    } catch {
      setCopied(null);
    }
  }

  return (
    <Card className="self-start xl:sticky xl:top-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 aria-hidden />
          공고 근거
        </CardTitle>
        <CardDescription className="line-clamp-2">
          {evidence?.grant?.title ?? (evidence ? `${sourceLabel(evidence.source)} ${evidence.sourceId}` : "연결된 공고를 찾지 못했습니다.")}
        </CardDescription>
        <CardAction>
          {evidence?.grant?.status ? <Badge variant="outline">{grantStatusLabel(evidence.grant.status)}</Badge> : null}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {evidence?.grant ? (
          <div className="flex flex-col gap-1 text-sm">
            <strong className="line-clamp-2">{evidence.grant.title}</strong>
            {evidence.grant.agencyOperator ? (
              <span className="text-muted-foreground">{evidence.grant.agencyOperator}</span>
            ) : null}
          </div>
        ) : (
          <Alert>
            <AlertTitle>공고 링크 미연결</AlertTitle>
            <AlertDescription>문서 ID는 확인했지만 현재 DB에서 원 공고를 매칭하지 못했습니다.</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <EvidenceActionLink href={grantUrl} label="공고 원 링크" />
          <EvidenceActionLink href={documentUrl} label="문서 원본" />
          <EvidenceActionLink href={archiveUrl} label="보관본" />
        </div>

        <Separator />

        <div className="flex flex-col gap-2 text-xs">
          <EvidenceMeta label="문서명" value={displayFilename} onCopy={() => copyValue("문서명", displayFilename)} copied={copied === "문서명"} />
          <EvidenceMeta label="docRef" value={docRef} onCopy={() => copyValue("docRef", docRef)} copied={copied === "docRef"} />
          {evidence?.surface ? (
            <>
              <EvidenceMeta label="변환 상태" value={evidence.surface.extractionStatus} />
              <EvidenceMeta label="형식" value={evidence.surface.format} />
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function EvidenceActionLink({ href, label }: { href: string | null; label: string }) {
  if (!href) {
    return (
      <Button variant="outline" size="sm" disabled className="justify-start">
        <ExternalLink data-icon="inline-start" />
        {label}
      </Button>
    );
  }

  return (
    <a
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "justify-start")}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      <ExternalLink data-icon="inline-start" />
      {label}
    </a>
  );
}

function EvidenceMeta({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string | null;
  onCopy?: (() => void) | undefined;
  copied?: boolean | undefined;
}) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius-lg)] border bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <span className="block text-muted-foreground">{label}</span>
        <Tooltip>
          <TooltipTrigger render={<strong className="block truncate font-medium">{value}</strong>} />
          <TooltipContent>{value}</TooltipContent>
        </Tooltip>
      </div>
      {onCopy ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label={`${label} 복사`} onClick={onCopy}>
                <Copy />
              </Button>
            }
          />
          <TooltipContent>{copied ? "복사됨" : `${label} 복사`}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function QuestionDocumentPanel({
  docId,
  imageUrl,
  page,
  totalPages,
  questionPage,
  fields,
  activeFieldIndex,
  onPageChange,
}: {
  docId: string;
  imageUrl: string | null;
  page: number;
  totalPages: number;
  questionPage: number | null;
  fields: Array<{ f: ReviewField; i: number }>;
  activeFieldIndex: number | null;
  onPageChange: React.Dispatch<React.SetStateAction<number>>;
}) {
  const [zoom, setZoom] = useState(1);
  const activeField = activeFieldIndex != null ? fields.find(({ i }) => i === activeFieldIndex)?.f ?? null : null;

  return (
    <Card className="self-start xl:sticky xl:top-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText aria-hidden />
          원 문서
        </CardTitle>
        <CardDescription className="tabular-nums">
          {docId} · {page}/{totalPages} 페이지
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="이전 페이지"
              onClick={() => onPageChange((value) => Math.max(1, value - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="다음 페이지"
              onClick={() => onPageChange((value) => Math.min(totalPages, value + 1))}
              disabled={page >= totalPages}
            >
              <ChevronRight />
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" aria-label="축소" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}>
              <Minus />
            </Button>
            <Badge variant="secondary" className="h-7 min-w-14 justify-center tabular-nums">
              {Math.round(zoom * 100)}%
            </Badge>
            <Button variant="outline" size="icon-sm" aria-label="확대" onClick={() => setZoom((value) => Math.min(3, value + 0.25))}>
              <Plus />
            </Button>
          </div>
          {questionPage != null && questionPage !== page ? (
            <Button variant="outline" size="sm" onClick={() => onPageChange(questionPage)}>
              <RotateCcw data-icon="inline-start" />
              질문 위치
            </Button>
          ) : null}
        </div>

        <div className="max-h-[72vh] overflow-auto rounded-[var(--radius-lg)] border bg-muted/30">
          {imageUrl ? (
            <div className="relative inline-block" style={{ width: `${zoom * 100}%` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt={`${docId} page ${page}`} className="pointer-events-none block w-full select-none" draggable={false} />
              {fields.map(({ f, i }) => {
                const bbox = Array.isArray(f.bbox) ? f.bbox : null;
                if (!bbox) return null;
                const [x, y, w, h] = bbox;
                const active = i === activeFieldIndex;
                return (
                  <div
                    key={i}
                    className={cn(
                      "pointer-events-none absolute border bg-primary/10",
                      active ? "border-2 border-primary bg-primary/25" : "border-primary/50",
                    )}
                    title={f.label || f.key || `field ${i}`}
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
            <Empty className="min-h-80 border-0">
              <EmptyHeader>
                <EmptyTitle>문서 이미지가 없습니다.</EmptyTitle>
                <EmptyDescription>페이지 이미지 업로드 상태를 확인하세요.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>

        <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
          {activeField?.label ? (
            <Tooltip>
              <TooltipTrigger render={<span className="min-w-0 truncate">대상 칸: {activeField.label}</span>} />
              <TooltipContent>{activeField.label}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="min-w-0 truncate">{fields.length}개 필드 표시</span>
          )}
          {imageUrl ? (
            <a className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "shrink-0")} href={imageUrl} target="_blank" rel="noreferrer">
              <ExternalLink data-icon="inline-start" />
              이미지 열기
            </a>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function sourceLabel(source: string): string {
  if (source === "bizinfo") return "기업마당";
  if (source === "bizinfo_event") return "기업마당 행사";
  if (source === "kstartup") return "K-Startup";
  return source;
}

function grantStatusLabel(status: string): string {
  if (status === "open") return "접수중";
  if (status === "upcoming") return "예정";
  if (status === "closed") return "마감";
  if (status === "unknown") return "상태 미확인";
  return status;
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

  return (
    <Card>
      <CardHeader>
        <Badge variant={question.kind === "missing_sweep" ? "secondary" : question.kind === "quick_confirm" ? "outline" : "default"} className="w-fit">
          {KIND_LABEL[question.kind]}
        </Badge>
        <CardTitle className="text-center text-lg leading-7">{question.prompt}</CardTitle>
        <CardDescription className="text-center tabular-nums">{position}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4">
        <div className="max-w-full overflow-x-auto">
          <BboxCrop imageUrl={imageUrl} bbox={bbox} />
        </div>

        {fieldLabel ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="max-w-full truncate text-center text-xs text-muted-foreground">대상 칸: {fieldLabel}</p>
              }
            />
            <TooltipContent>{fieldLabel}</TooltipContent>
          </Tooltip>
        ) : null}

        {existing ? (
          <Alert>
            <AlertTitle>이전 답변</AlertTitle>
            <AlertDescription>{existing} · 다시 답하면 갱신됩니다.</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex w-full flex-wrap items-center justify-center gap-2">
          {question.answerType === "confirm" ? (
            <>
              <AnswerButton disabled={busy} onClick={() => onAnswer("ok")} tone="ok">
                맞음
              </AnswerButton>
              <AnswerButton disabled={busy} onClick={() => onAnswer("edit")} tone="warn">
                수정 필요
              </AnswerButton>
            </>
          ) : null}
          {question.answerType === "yes_no_unsure" ? (
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
          ) : null}
          {question.answerType === "choice"
            ? (question.options ?? []).map((o) => (
                <AnswerButton key={o.value} disabled={busy} onClick={() => onAnswer(o.value)} tone="plain">
                  {o.label}
                </AnswerButton>
              ))
            : null}
          {question.answerType === "short_text" ? (
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              <Input
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                placeholder="한 줄로 답해 주세요"
              />
              <AnswerButton
                disabled={busy || !textValue.trim()}
                onClick={() => onAnswer(textValue.trim(), textValue.trim())}
                tone="ok"
              >
                저장
              </AnswerButton>
            </div>
          ) : null}
        </div>
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <Button variant="outline" onClick={onPrev} disabled={!onPrev}>
          <ChevronLeft data-icon="inline-start" />
          이전
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="outline" onClick={onNext}>
                건너뛰기
                <ChevronRight data-icon="inline-end" />
              </Button>
            }
          />
          <TooltipContent>답하지 않고 건너뜁니다</TooltipContent>
        </Tooltip>
      </CardFooter>
    </Card>
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
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      variant={tone === "ok" ? "default" : tone === "warn" ? "secondary" : "outline"}
    >
      {children}
    </Button>
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
  const idPrefix = `field-${index}`;
  const fieldType = FIELD_TYPES.includes((field.type ?? "text") as (typeof FIELD_TYPES)[number])
    ? (field.type ?? "text")
    : "unknown";

  function toggleHold(next: boolean) {
    if (next) {
      if (held) return;
      const rest = (field.notes ?? "").trim();
      onChange({ notes: rest ? `${HOLD_PREFIX} ${rest}` : `${HOLD_PREFIX} ` });
    } else {
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
      className={cn(
        "flex cursor-pointer flex-col gap-3 border-b p-4 text-sm last:border-b-0",
        selected ? "bg-accent" : held ? "bg-secondary/60 hover:bg-secondary" : "hover:bg-muted/50",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={selected ? "default" : "outline"}>#{index}</Badge>
          {held ? <Badge variant="secondary">보류</Badge> : null}
          <span className="text-xs text-muted-foreground">bbox: {bbox ? bbox.map((n) => Number(n).toFixed(2)).join(", ") : "null"}</span>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 data-icon="inline-start" />
          삭제
        </Button>
      </div>

      <FieldGroup className="gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-key`}>key</FieldLabel>
            <Input
              id={`${idPrefix}-key`}
              value={field.key ?? ""}
              onChange={(e) => onChange({ key: e.target.value })}
              className="h-10 font-mono text-xs"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-type`}>type</FieldLabel>
            <Select
              items={FIELD_TYPE_ITEMS}
              value={fieldType}
              onValueChange={(value) => onChange({ type: String(value) })}
            >
              <SelectTrigger id={`${idPrefix}-type`} className="h-10 w-full">
                <SelectValue placeholder="type" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FIELD_TYPE_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-label`}>label</FieldLabel>
            <Input
              id={`${idPrefix}-label`}
              value={field.label ?? ""}
              onChange={(e) => onChange({ label: e.target.value })}
              className="h-10"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-section`}>section</FieldLabel>
            <Input
              id={`${idPrefix}-section`}
              value={field.section ?? ""}
              onChange={(e) => onChange({ section: e.target.value })}
              className="h-10"
            />
          </Field>
        </div>

        <Separator />

        <FieldSet>
          <FieldLegend variant="label">판정 속성</FieldLegend>
          <div className="grid gap-3 md:grid-cols-3">
            <BooleanSwitch
              id={`${idPrefix}-required`}
              label="필수"
              description="별표·필수 표기"
              checked={Boolean(field.required)}
              onCheckedChange={(v) => onChange({ required: v })}
            />
            <BooleanSwitch
              id={`${idPrefix}-applicant`}
              label="지원자가 작성"
              description="지원자 몫"
              checked={field.applicantFills !== false}
              onCheckedChange={(v) => onChange({ applicantFills: v })}
            />
            <BooleanSwitch
              id={`${idPrefix}-manual`}
              label="자필·서명 필요"
              description="서명·직인·자필"
              checked={Boolean(field.manual)}
              onCheckedChange={(v) => onChange({ manual: v })}
            />
          </div>
        </FieldSet>

        <Separator />

        <FieldSet>
          <FieldLegend variant="label">판정 보류</FieldLegend>
          <Field orientation="horizontal">
            <Switch
              id={`${idPrefix}-hold`}
              size="sm"
              checked={held}
              onCheckedChange={(checked) => toggleHold(Boolean(checked))}
            />
            <FieldContent>
              <FieldLabel htmlFor={`${idPrefix}-hold`}>보류로 남기기</FieldLabel>
              <FieldDescription>판정이 애매하면 확정하지 않고 사유를 남깁니다.</FieldDescription>
            </FieldContent>
          </Field>
          {held ? (
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-hold-reason`}>보류 사유</FieldLabel>
              <Input
                id={`${idPrefix}-hold-reason`}
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                placeholder="예: 표 구조 애매, 원본 확인 필요"
              />
            </Field>
          ) : null}
        </FieldSet>

        <Field>
          <FieldLabel htmlFor={`${idPrefix}-notes`}>notes</FieldLabel>
          <Textarea
            id={`${idPrefix}-notes`}
            value={field.notes ?? ""}
            onChange={(e) => onChange({ notes: e.target.value })}
            rows={2}
            className="min-h-24 text-xs"
          />
        </Field>
      </FieldGroup>
    </div>
  );
}

function BooleanSwitch({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Switch id={id} size="sm" checked={checked} onCheckedChange={(value) => onCheckedChange(Boolean(value))} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
    </Field>
  );
}
