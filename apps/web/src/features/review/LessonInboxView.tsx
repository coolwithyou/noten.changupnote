"use client";

import { useCallback, useState } from "react";
import { Archive, CheckCircle2, Pencil, Quote, TriangleAlert, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  LessonInboxDto,
  LessonInboxItemDto,
  LessonSourceMetaDto,
} from "@/lib/server/knowledge/lessonInboxData";

// knowledgeRepo(서버·drizzle 의존)를 클라이언트로 끌어오지 않기 위해 타입은 로컬로 좁혀 쓴다.
type LessonStatus = "proposed" | "approved" | "rejected" | "retired";
type LessonTarget =
  | "classification"
  | "criteria"
  | "field_interpretation"
  | "fill_value"
  | "guide"
  | "evaluation";
type EvidenceTier = "official_document" | "staff_confirmed" | "ops_inference";
type LessonScope = LessonInboxItemDto["scope"];

const STATUS_ORDER: LessonStatus[] = ["proposed", "approved", "rejected", "retired"];
const STATUS_LABEL: Record<LessonStatus, string> = {
  proposed: "제안됨",
  approved: "승인됨",
  rejected: "기각됨",
  retired: "철회됨",
};

const TARGET_LABEL: Record<LessonTarget, string> = {
  classification: "분류",
  criteria: "자격·전제",
  field_interpretation: "필드 해석",
  fill_value: "기입값",
  guide: "작성 지침",
  evaluation: "심사 관점",
};

const TIER_META: Record<EvidenceTier, { label: string; warn: boolean }> = {
  official_document: { label: "공식 문서", warn: false },
  staff_confirmed: { label: "담당자 확인", warn: true },
  ops_inference: { label: "운영 추정", warn: true },
};

// scope 축의 표시 순서·한국어 라벨. knowledgeRepo LESSON_SCOPE_AXES 와 동일 순서.
const SCOPE_AXES = [
  "program",
  "institution",
  "formTemplateId",
  "documentCategory",
  "fieldPattern",
  "fieldKey",
  "condition",
] as const;
type ScopeAxis = (typeof SCOPE_AXES)[number];
const SCOPE_AXIS_LABEL: Record<ScopeAxis, string> = {
  program: "프로그램",
  institution: "기관",
  formTemplateId: "양식 ID",
  documentCategory: "문서 분류",
  fieldPattern: "필드 패턴",
  fieldKey: "표준 필드 key",
  condition: "조건",
};

const dateFmt = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" });
function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateFmt.format(d);
}

function scopeToRecord(scope: LessonScope): Record<ScopeAxis, string> {
  const record = {} as Record<ScopeAxis, string>;
  for (const axis of SCOPE_AXES) record[axis] = (scope?.[axis] as string | undefined) ?? "";
  return record;
}
function recordToScope(record: Record<ScopeAxis, string>): LessonScope {
  const scope: Record<string, string> = {};
  for (const axis of SCOPE_AXES) {
    const value = record[axis]?.trim();
    if (value) scope[axis] = value;
  }
  return scope as LessonScope;
}
function scopeHasAxis(scope: LessonScope): boolean {
  return SCOPE_AXES.some((axis) => {
    const value = scope?.[axis];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function errText(data: unknown): string {
  const d = data as { message?: string; error?: string } | null;
  return d?.message ?? d?.error ?? "요청을 처리하지 못했습니다.";
}

interface ConflictItem {
  id: string;
  instruction: string;
  scope: LessonScope;
  evidenceTier: EvidenceTier;
}
interface ConflictState {
  items: ConflictItem[];
  pending: { instruction?: string | undefined; scope?: LessonScope | undefined };
}
type OpenForm = "edit" | "reject" | null;
type Banner = { kind: "ok" | "error" | "warn"; text: string } | null;

interface CurateResult {
  ok: boolean;
  httpStatus: number;
  data: unknown;
}

export function LessonInboxView({ initialData }: { initialData: LessonInboxDto }) {
  const [status, setStatus] = useState<LessonStatus>(initialData.status);
  const [data, setData] = useState<LessonInboxDto>(initialData);
  const [switching, setSwitching] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [openForms, setOpenForms] = useState<Record<string, OpenForm>>({});
  const [editDrafts, setEditDrafts] = useState<
    Record<string, { instruction: string; scope: Record<ScopeAxis, string> }>
  >({});
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Record<string, ConflictState | undefined>>({});

  const sources = data.sources;

  const refetch = useCallback(
    async (next: LessonStatus) => {
      const params = new URLSearchParams({ status: next });
      if (data.sourceId) params.set("sourceId", data.sourceId);
      const res = await fetch(`/internal/review/api/lessons?${params.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        setBanner({ kind: "error", text: "목록을 새로고침하지 못했습니다." });
        return;
      }
      const nextData = (await res.json()) as LessonInboxDto;
      setData(nextData);
    },
    [data.sourceId],
  );

  const changeStatus = useCallback(
    async (next: LessonStatus) => {
      if (next === status && !switching) return;
      setStatus(next);
      setBanner(null);
      setSwitching(true);
      const params = new URLSearchParams();
      if (next !== "proposed") params.set("status", next);
      const query = params.toString();
      window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
      await refetch(next);
      setSwitching(false);
    },
    [status, switching, refetch],
  );

  const postCurate = useCallback(
    async (lessonId: string, body: Record<string, unknown>): Promise<CurateResult> => {
      const res = await fetch(`/internal/review/api/lessons/${lessonId}/curate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        // 본문 없음
      }
      return { ok: res.ok, httpStatus: res.status, data: payload };
    },
    [],
  );

  const closeForm = useCallback((lessonId: string) => {
    setOpenForms((prev) => ({ ...prev, [lessonId]: null }));
  }, []);
  const clearConflict = useCallback((lessonId: string) => {
    setConflicts((prev) => ({ ...prev, [lessonId]: undefined }));
  }, []);

  const runApprove = useCallback(
    async (
      lesson: LessonInboxItemDto,
      opts: {
        instruction?: string | undefined;
        scope?: LessonScope | undefined;
        force?: boolean | undefined;
      },
    ) => {
      setBusyId(lesson.id);
      setBanner(null);
      const result = await postCurate(lesson.id, {
        action: "approve",
        ...(opts.instruction !== undefined ? { instruction: opts.instruction } : {}),
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        ...(opts.force ? { force: true } : {}),
      });
      setBusyId(null);

      if (result.httpStatus === 409) {
        const payload = result.data as { conflicts?: ConflictItem[] } | null;
        setConflicts((prev) => ({
          ...prev,
          [lesson.id]: {
            items: payload?.conflicts ?? [],
            pending: { instruction: opts.instruction, scope: opts.scope },
          },
        }));
        setBanner({ kind: "warn", text: "충돌하는 승인 lesson이 있습니다. 확인 후 진행하세요." });
        return;
      }
      if (result.ok) {
        clearConflict(lesson.id);
        closeForm(lesson.id);
        setBanner({ kind: "ok", text: "lesson을 승인했습니다." });
        await refetch(status);
        return;
      }
      setBanner({ kind: "error", text: `승인 실패: ${errText(result.data)}` });
    },
    [postCurate, clearConflict, closeForm, refetch, status],
  );

  const runReject = useCallback(
    async (lesson: LessonInboxItemDto) => {
      const note = (rejectDrafts[lesson.id] ?? "").trim();
      if (!note) {
        setBanner({ kind: "error", text: "기각 사유(메모)를 입력하세요." });
        return;
      }
      setBusyId(lesson.id);
      setBanner(null);
      const result = await postCurate(lesson.id, { action: "reject", curationNote: note });
      setBusyId(null);
      if (result.ok) {
        closeForm(lesson.id);
        setBanner({ kind: "ok", text: "lesson을 기각했습니다." });
        await refetch(status);
        return;
      }
      setBanner({ kind: "error", text: `기각 실패: ${errText(result.data)}` });
    },
    [rejectDrafts, postCurate, closeForm, refetch, status],
  );

  const runRetire = useCallback(
    async (lesson: LessonInboxItemDto) => {
      if (!window.confirm("이 lesson을 철회하면 주입 대상에서 제외됩니다. 계속할까요?")) return;
      setBusyId(lesson.id);
      setBanner(null);
      const result = await postCurate(lesson.id, { action: "retire" });
      setBusyId(null);
      if (result.ok) {
        setBanner({ kind: "ok", text: "lesson을 철회했습니다." });
        await refetch(status);
        return;
      }
      setBanner({ kind: "error", text: `철회 실패: ${errText(result.data)}` });
    },
    [postCurate, refetch, status],
  );

  const openEdit = useCallback((lesson: LessonInboxItemDto) => {
    setEditDrafts((prev) => ({
      ...prev,
      [lesson.id]: { instruction: lesson.instruction, scope: scopeToRecord(lesson.scope) },
    }));
    setOpenForms((prev) => ({ ...prev, [lesson.id]: "edit" }));
  }, []);

  const saveEdit = useCallback(
    async (lesson: LessonInboxItemDto) => {
      const draft = editDrafts[lesson.id];
      if (!draft) return;
      const scope = recordToScope(draft.scope);
      if (!scopeHasAxis(scope)) {
        setBanner({ kind: "error", text: "scope 는 최소 1개 축이 필요합니다." });
        return;
      }
      const instruction = draft.instruction.trim();
      if (!instruction) {
        setBanner({ kind: "error", text: "지침(instruction)을 비울 수 없습니다." });
        return;
      }
      await runApprove(lesson, { instruction, scope });
    },
    [editDrafts, runApprove],
  );

  const lessons = data.lessons;

  return (
    <div className="flex w-full max-w-screen-2xl flex-col gap-4">
      {banner ? (
        <Alert
          variant={banner.kind === "error" ? "destructive" : "default"}
          className={cn(
            banner.kind === "ok" && "border-emerald-500/30 bg-emerald-500/5",
            banner.kind === "warn" && "border-amber-500/40 bg-amber-500/5",
          )}
        >
          <AlertTitle>
            {banner.kind === "ok" ? "완료" : banner.kind === "warn" ? "확인 필요" : "오류"}
          </AlertTitle>
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      ) : null}

      {/* 상태 필터 탭 */}
      <div role="tablist" aria-label="lesson 상태 필터" className="inline-flex w-fit flex-wrap items-center gap-1 rounded-[var(--radius-lg)] bg-muted p-1">
        {STATUS_ORDER.map((s) => {
          const active = s === status;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={switching}
              onClick={() => void changeStatus(s)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[min(var(--radius-md),12px)] px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-60",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {STATUS_LABEL[s]}
              <span
                className={cn(
                  "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] tabular-nums",
                  active ? "bg-primary/10 text-primary" : "bg-foreground/5 text-muted-foreground",
                )}
              >
                {data.counts[s] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {switching ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Spinner className="size-4" /> 불러오는 중…
        </div>
      ) : lessons.length === 0 ? (
        <Empty className="border border-border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2 />
            </EmptyMedia>
            <EmptyTitle>검수할 lesson 후보가 없습니다</EmptyTitle>
            <EmptyDescription>
              {status === "proposed"
                ? "새 운영 보고 문서를 인제스천하면 후보가 이곳에 쌓입니다."
                : `${STATUS_LABEL[status]} 상태의 lesson 이 아직 없습니다.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {lessons.map((lesson) => (
            <LessonCard
              key={lesson.id}
              lesson={lesson}
              source={lesson.sourceId ? sources[lesson.sourceId] : undefined}
              busy={busyId === lesson.id}
              openForm={openForms[lesson.id] ?? null}
              editDraft={editDrafts[lesson.id]}
              rejectDraft={rejectDrafts[lesson.id] ?? ""}
              conflict={conflicts[lesson.id]}
              onApprove={() => void runApprove(lesson, {})}
              onOpenEdit={() => openEdit(lesson)}
              onOpenReject={() => setOpenForms((prev) => ({ ...prev, [lesson.id]: "reject" }))}
              onCloseForm={() => closeForm(lesson.id)}
              onEditInstruction={(value) =>
                setEditDrafts((prev) => ({
                  ...prev,
                  [lesson.id]: {
                    instruction: value,
                    scope: prev[lesson.id]?.scope ?? scopeToRecord(lesson.scope),
                  },
                }))
              }
              onEditScope={(axis, value) =>
                setEditDrafts((prev) => {
                  const current = prev[lesson.id] ?? {
                    instruction: lesson.instruction,
                    scope: scopeToRecord(lesson.scope),
                  };
                  return {
                    ...prev,
                    [lesson.id]: { ...current, scope: { ...current.scope, [axis]: value } },
                  };
                })
              }
              onSaveEdit={() => void saveEdit(lesson)}
              onRejectDraft={(value) =>
                setRejectDrafts((prev) => ({ ...prev, [lesson.id]: value }))
              }
              onReject={() => void runReject(lesson)}
              onRetire={() => void runRetire(lesson)}
              onForceApprove={() => {
                const pending = conflicts[lesson.id]?.pending ?? {};
                void runApprove(lesson, { ...pending, force: true });
              }}
              onDismissConflict={() => clearConflict(lesson.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface LessonCardProps {
  lesson: LessonInboxItemDto;
  source: LessonSourceMetaDto | undefined;
  busy: boolean;
  openForm: OpenForm;
  editDraft: { instruction: string; scope: Record<ScopeAxis, string> } | undefined;
  rejectDraft: string;
  conflict: ConflictState | undefined;
  onApprove: () => void;
  onOpenEdit: () => void;
  onOpenReject: () => void;
  onCloseForm: () => void;
  onEditInstruction: (value: string) => void;
  onEditScope: (axis: ScopeAxis, value: string) => void;
  onSaveEdit: () => void;
  onRejectDraft: (value: string) => void;
  onReject: () => void;
  onRetire: () => void;
  onForceApprove: () => void;
  onDismissConflict: () => void;
}

function LessonCard(props: LessonCardProps) {
  const {
    lesson,
    source,
    busy,
    openForm,
    editDraft,
    rejectDraft,
    conflict,
    onApprove,
    onOpenEdit,
    onOpenReject,
    onCloseForm,
    onEditInstruction,
    onEditScope,
    onSaveEdit,
    onRejectDraft,
    onReject,
    onRetire,
    onForceApprove,
    onDismissConflict,
  } = props;

  const tier = TIER_META[lesson.evidenceTier as EvidenceTier] ?? {
    label: lesson.evidenceTier,
    warn: true,
  };
  const target = TARGET_LABEL[lesson.target as LessonTarget] ?? lesson.target;
  const reviewBy = fmtDate(lesson.reviewBy);
  const curatedAt = fmtDate(lesson.curatedAt);
  const scopeEntries = SCOPE_AXES.map((axis) => [axis, lesson.scope?.[axis]] as const).filter(
    ([, value]) => typeof value === "string" && value.length > 0,
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{target}</Badge>
          <Badge
            variant="outline"
            className={cn(
              tier.warn &&
                "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
          >
            {tier.warn ? <TriangleAlert className="size-3" aria-hidden /> : null}
            {tier.label}
          </Badge>
          {lesson.programRound ? <Badge variant="ghost">{lesson.programRound}</Badge> : null}
          <span className="ml-auto text-xs text-muted-foreground">
            {lesson.status !== "proposed" && curatedAt ? `${curatedAt} 처리` : null}
          </span>
        </div>
        <CardTitle className="text-base leading-6 font-semibold">{lesson.instruction}</CardTitle>
        {lesson.rationale ? (
          <p className="text-sm text-muted-foreground">{lesson.rationale}</p>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* scope 칩 */}
        {scopeEntries.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {scopeEntries.map(([axis, value]) => (
              <span
                key={axis}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
              >
                <span className="text-muted-foreground">{SCOPE_AXIS_LABEL[axis]}</span>
                <span className="font-medium">{value}</span>
              </span>
            ))}
          </div>
        ) : null}

        {/* 원문 인용 대조 블록 — 검수의 핵심 */}
        {lesson.sourceRefs.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Quote className="size-3.5" aria-hidden /> 원문 인용 대조
            </p>
            {lesson.sourceRefs.map((ref, index) => (
              <blockquote
                key={`${ref.sourceId}-${index}`}
                className="rounded-r-[var(--radius-md)] border-l-2 border-border bg-muted/30 px-3 py-2 text-sm text-foreground/90"
              >
                <p className="whitespace-pre-wrap leading-6">“{ref.quote}”</p>
                <footer className="mt-1.5 text-xs text-muted-foreground">
                  {source?.title ?? "출처 문서"}
                  {typeof ref.page === "number" ? ` · p.${ref.page}` : ""}
                  {source ? ` · ${source.sourceDate}` : ""}
                </footer>
              </blockquote>
            ))}
          </div>
        ) : (
          <Alert variant="destructive">
            <AlertTitle>원문 인용이 없습니다</AlertTitle>
            <AlertDescription>
              인용 없는 후보는 승인할 수 없습니다(승격 가드). goldenCaseRef 가 없으면 기각하세요.
            </AlertDescription>
          </Alert>
        )}

        {reviewBy ? (
          <p className="text-xs text-muted-foreground">재검토 기한: {reviewBy}</p>
        ) : null}

        {lesson.status === "rejected" && lesson.curationNote ? (
          <p className="text-sm">
            <span className="text-muted-foreground">기각 사유: </span>
            {lesson.curationNote}
          </p>
        ) : null}
        {lesson.curatedBy && lesson.status !== "proposed" ? (
          <p className="text-xs text-muted-foreground">처리자: {lesson.curatedBy}</p>
        ) : null}

        {/* 충돌 경고 */}
        {conflict ? (
          <Alert className="border-amber-500/40 bg-amber-500/5">
            <AlertTitle className="flex items-center gap-1.5">
              <TriangleAlert className="size-4 text-amber-600" aria-hidden />
              같은 scope 의 승인된 lesson 과 충돌
            </AlertTitle>
            <AlertDescription>
              <div className="flex flex-col gap-2">
                {conflict.items.map((item) => (
                  <div key={item.id} className="rounded-[var(--radius-md)] border border-amber-500/30 bg-background/60 p-2">
                    <p className="text-sm text-foreground">{item.instruction}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {SCOPE_AXES.map((axis) => {
                        const value = item.scope?.[axis];
                        if (typeof value !== "string" || !value) return null;
                        return (
                          <span
                            key={axis}
                            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]"
                          >
                            <span className="text-muted-foreground">{SCOPE_AXIS_LABEL[axis]}</span>
                            {value}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" variant="destructive" disabled={busy} onClick={onForceApprove}>
                    {busy ? <Spinner className="size-3.5" /> : <TriangleAlert data-icon="inline-start" />}
                    그래도 승인
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={onDismissConflict}>
                    취소
                  </Button>
                </div>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {/* 수정 후 승인 폼 */}
        {openForm === "edit" ? (
          <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-muted/20 p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`instruction-${lesson.id}`}>지침(instruction)</Label>
              <Textarea
                id={`instruction-${lesson.id}`}
                className="min-h-24 bg-background"
                value={editDraft?.instruction ?? lesson.instruction}
                onChange={(event) => onEditInstruction(event.target.value)}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {SCOPE_AXES.map((axis) => (
                <div key={axis} className="flex flex-col gap-1">
                  <Label htmlFor={`scope-${axis}-${lesson.id}`} className="text-xs">
                    {SCOPE_AXIS_LABEL[axis]}
                  </Label>
                  <Input
                    id={`scope-${axis}-${lesson.id}`}
                    className="h-9 text-sm"
                    placeholder="비우면 제외"
                    value={editDraft?.scope[axis] ?? ""}
                    onChange={(event) => onEditScope(axis, event.target.value)}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={onSaveEdit}>
                {busy ? <Spinner className="size-3.5" /> : <CheckCircle2 data-icon="inline-start" />}
                저장하고 승인
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={onCloseForm}>
                취소
              </Button>
            </div>
          </div>
        ) : null}

        {/* 기각 폼 */}
        {openForm === "reject" ? (
          <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-muted/20 p-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`reject-${lesson.id}`}>기각 사유(필수)</Label>
              <Textarea
                id={`reject-${lesson.id}`}
                className="min-h-20 bg-background"
                placeholder="왜 이 후보를 기각하는지 기록하세요."
                value={rejectDraft}
                onChange={(event) => onRejectDraft(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="destructive" disabled={busy} onClick={onReject}>
                {busy ? <Spinner className="size-3.5" /> : <X data-icon="inline-start" />}
                기각 확정
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={onCloseForm}>
                취소
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>

      {/* 액션 바 — 상태별 */}
      {openForm === null ? (
        <CardFooter className="flex flex-wrap gap-2">
          {lesson.status === "proposed" ? (
            <>
              <Button size="sm" disabled={busy} onClick={onApprove}>
                {busy ? <Spinner className="size-3.5" /> : <CheckCircle2 data-icon="inline-start" />}
                승인
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={onOpenEdit}>
                <Pencil data-icon="inline-start" />
                수정 후 승인
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onOpenReject}>
                <X data-icon="inline-start" />
                기각
              </Button>
            </>
          ) : lesson.status === "approved" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onRetire}>
              {busy ? <Spinner className="size-3.5" /> : <Archive data-icon="inline-start" />}
              철회
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              {STATUS_LABEL[lesson.status]} — 추가 조치 없음
            </span>
          )}
        </CardFooter>
      ) : null}
    </Card>
  );
}
