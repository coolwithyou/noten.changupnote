"use client";

import { useMemo, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Save,
  UserRound,
  XCircle,
} from "lucide-react";
import type { FeedbackKind } from "@cunote/contracts";
import type {
  ApplicationPipelineItem,
  ApplicationPipelineResult,
  ApplicationStage,
} from "@/lib/server/applications/pipeline";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ApplicationDocumentCard,
  DOCUMENT_CARD_COLUMNS,
  type EditorMode,
} from "./ApplicationDocumentCard";

/**
 * 디자인 02는 그룹 헤더 없이 문서 카드를 한 줄로 쌓는다. 순서는 예전 그룹 순서(진행 중 → 결과 대기 → 종료)를
 * 그대로 이어 붙인 것이며, 같은 그룹 안에서는 서버 정렬(단계 → D-day)을 유지한다.
 */
const STAGE_GROUP_RANK: Record<ApplicationStage, number> = {
  preparing: 0,
  saved: 0,
  recommended: 0,
  submitted: 1,
  selected: 2,
  rejected: 2,
  blocked: 2,
  dismissed: 2,
};

export function ApplicationPipelineView({
  pipeline,
}: {
  pipeline: ApplicationPipelineResult;
}) {
  const [items, setItems] = useState(pipeline.items);
  const [managementDrafts, setManagementDrafts] = useState<Record<string, ManagementDraft>>(() =>
    Object.fromEntries(pipeline.items.map((item) => [item.grantId, managementDraftFromItem(item)]))
  );
  const [pendingGrantId, setPendingGrantId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ grantId: string; mode: EditorMode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const orderedItems = useMemo(() => orderPipelineItems(items), [items]);
  const editorItem = editor ? items.find((item) => item.grantId === editor.grantId) ?? null : null;

  async function moveItem(item: ApplicationPipelineItem, kind: FeedbackKind, stage: ApplicationStage) {
    setPendingGrantId(item.grantId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/matches/${encodeURIComponent(item.grantId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, message: `pipeline:${stage}` }),
      });
      const payload = await response.json() as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "상태를 저장하지 못했습니다.");
      setItems((current) => current.map((candidate) =>
        candidate.grantId === item.grantId
          ? {
            ...candidate,
            stage,
            stageLabel: stageLabel(stage),
            lastActionAt: new Date().toISOString(),
          }
          : candidate
      ));
      setNotice(`${item.title}을(를) ${stageLabel(stage)} 단계로 이동했습니다.`);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "상태를 저장하지 못했습니다.");
      return false;
    } finally {
      setPendingGrantId(null);
    }
  }

  async function saveManagement(item: ApplicationPipelineItem) {
    const draft = managementDrafts[item.grantId] ?? managementDraftFromItem(item);
    setPendingGrantId(item.grantId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/web/matches/${encodeURIComponent(item.grantId)}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: feedbackKindForStage(item.stage),
          message: `pipeline:management:${item.stage}`,
          payload: {
            source: "application_pipeline",
            applicationStage: item.stage,
            assigneeName: optionalPayloadString(draft.assigneeName),
            reminderAt: draft.reminderAt || null,
            outcomeNote: optionalPayloadString(draft.outcomeNote),
          },
        }),
      });
      const payload = await response.json() as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? "후속 관리 정보를 저장하지 못했습니다.");
      const savedDraft = normalizeManagementDraft(draft);
      setItems((current) => current.map((candidate) =>
        candidate.grantId === item.grantId
          ? {
            ...candidate,
            assigneeName: savedDraft.assigneeName || null,
            reminderAt: savedDraft.reminderAt || null,
            outcomeNote: savedDraft.outcomeNote || null,
            lastActionAt: new Date().toISOString(),
          }
          : candidate
      ));
      setManagementDrafts((current) => ({ ...current, [item.grantId]: savedDraft }));
      setNotice(`${item.title}의 담당자, 리마인더, 메모를 저장했습니다.`);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "후속 관리 정보를 저장하지 못했습니다.");
      return false;
    } finally {
      setPendingGrantId(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-4 py-6 sm:px-8 sm:py-7">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl leading-[1.3] font-extrabold tracking-[-0.5px] text-ink-strong">
            신청 관리
          </h1>
          <p className="text-[13px] leading-5 break-keep text-text-secondary">
            작성 중인 문서로 돌아가는 곳이에요 · 후보 순위가 바뀌어도 여기 목록은 유지돼요
          </p>
        </div>
        <a
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0 self-start sm:self-end")}
          href="/applications/calendar"
        >
          <CalendarDays data-icon="inline-start" />
          캘린더로 보기
        </a>
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert role="status" aria-live="polite">
          <CheckCircle2 aria-hidden />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {items.length === 0 ? (
        <Empty className="rounded-2xl border border-dashed border-border-muted px-6 py-16">
          <EmptyHeader>
            <EmptyTitle className="text-[17px] font-extrabold text-ink-strong">아직 작성 중인 문서가 없어요</EmptyTitle>
            <EmptyDescription className="text-[13px] text-text-secondary">
              기회 맵에서 공고를 고르거나 공고 링크로 시작하세요
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <a className={buttonVariants({ size: "sm" })} href="/dashboard">
              기회 맵으로
            </a>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div
            className="flex flex-col gap-3"
            aria-label="작성 중인 문서"
            data-application-board
            style={DOCUMENT_CARD_COLUMNS}
          >
            {orderedItems.map((item) => (
              <ApplicationDocumentCard
                key={item.grantId}
                item={item}
                now={pipeline.generatedAt}
                pending={pendingGrantId === item.grantId}
                onEdit={(mode) => setEditor({ grantId: item.grantId, mode })}
                onMove={moveItem}
              />
            ))}
          </div>

          <div className="flex flex-col gap-1.5 text-[13.5px] leading-5">
            <p className="text-[13px] break-keep text-text-secondary">
              문항 완전성이 확인되지 않은 문서에는 완료율을 표시하지 않아요. 다운로드는 제출 완료가 아닙니다.
            </p>
            <a className="w-fit font-semibold text-brand-hover hover:underline" href="/dashboard">
              기회 맵에서 공고 더 보기 →
            </a>
          </div>
        </>
      )}

      <div className="flex justify-center gap-4 text-[13px] font-semibold text-text-secondary">
        <a className="hover:text-foreground" href="/api/web/applications/report">리포트 내려받기</a>
        <a className="hover:text-foreground" href="/api/web/applications/calendar">전체 일정 .ics</a>
        <a className="hover:text-foreground" href="/api/web/applications/calendar-subscription">캘린더 구독 링크</a>
      </div>

      {editorItem && editor ? (
        <ApplicationManagementDialog
          draft={managementDrafts[editorItem.grantId] ?? managementDraftFromItem(editorItem)}
          item={editorItem}
          mode={editor.mode}
          open
          pending={pendingGrantId === editorItem.grantId}
          onDraftChange={(draft) => setManagementDrafts((current) => ({
            ...current,
            [editorItem.grantId]: draft,
          }))}
          onMove={moveItem}
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
          onSaveManagement={saveManagement}
        />
      ) : null}
    </div>
  );
}

/** 그룹 순서(진행 중 → 결과 대기 → 종료)로 안정 정렬한다. 단계 이동 뒤에도 카드가 제자리를 찾도록 클라이언트에서 다시 계산한다. */
export function orderPipelineItems(items: ApplicationPipelineItem[]): ApplicationPipelineItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => STAGE_GROUP_RANK[a.item.stage] - STAGE_GROUP_RANK[b.item.stage] || a.index - b.index)
    .map(({ item }) => item);
}

function ApplicationManagementDialog({
  item,
  draft,
  mode,
  open,
  pending,
  onDraftChange,
  onMove,
  onOpenChange,
  onSaveManagement,
}: {
  item: ApplicationPipelineItem;
  draft: ManagementDraft;
  mode: EditorMode;
  open: boolean;
  pending: boolean;
  onDraftChange: (draft: ManagementDraft) => void;
  onMove: (item: ApplicationPipelineItem, kind: FeedbackKind, stage: ApplicationStage) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  onSaveManagement: (item: ApplicationPipelineItem) => Promise<boolean>;
}) {
  async function saveResult(kind: FeedbackKind, stage: ApplicationStage) {
    const managementSaved = await onSaveManagement(item);
    if (!managementSaved) return;
    const resultSaved = await onMove(item, kind, stage);
    if (resultSaved) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "result" ? "결과 입력" : "메모·리마인더"}</DialogTitle>
          <DialogDescription>{item.title}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void onSaveManagement(item).then((saved) => {
              if (saved && mode === "management") onOpenChange(false);
            });
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`application-assignee-${item.grantId}`}>
                <UserRound aria-hidden />
                담당자
              </FieldLabel>
              <Input
                id={`application-assignee-${item.grantId}`}
                value={draft.assigneeName}
                onChange={(event) => onDraftChange({ ...draft, assigneeName: event.currentTarget.value })}
                placeholder="담당자 이름"
                disabled={pending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`application-reminder-${item.grantId}`}>
                <CalendarDays aria-hidden />
                리마인더
              </FieldLabel>
              <Input
                id={`application-reminder-${item.grantId}`}
                type="date"
                value={draft.reminderAt}
                onChange={(event) => onDraftChange({ ...draft, reminderAt: event.currentTarget.value })}
                disabled={pending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`application-note-${item.grantId}`}>결과·후속 메모</FieldLabel>
              <Textarea
                id={`application-note-${item.grantId}`}
                value={draft.outcomeNote}
                onChange={(event) => onDraftChange({ ...draft, outcomeNote: event.currentTarget.value })}
                placeholder="발표 예정일, 보완 요청, 선정 후 의무, 탈락 사유를 기록하세요."
                disabled={pending}
              />
            </Field>
          </FieldGroup>

          {mode === "result" ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-foreground">결과를 선택하세요</span>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={() => void saveResult("selected", "selected")}
                >
                  <CheckCircle2 data-icon="inline-start" />
                  선정
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void saveResult("rejected", "rejected")}
                >
                  <XCircle data-icon="inline-start" />
                  탈락
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void saveResult("blocked", "blocked")}
                >
                  <CircleAlert data-icon="inline-start" />
                  막힘
                </Button>
              </div>
            </div>
          ) : null}

          <DialogFooter className="mx-0 mb-0">
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              메모 저장
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function feedbackKindForStage(stage: ApplicationStage): FeedbackKind {
  if (stage === "selected") return "selected";
  if (stage === "rejected") return "rejected";
  if (stage === "blocked") return "blocked";
  if (stage === "submitted") return "applied";
  if (stage === "dismissed") return "dismissed";
  if (stage === "saved") return "saved";
  return "note";
}

function stageLabel(stage: ApplicationStage): string {
  if (stage === "recommended") return "추천";
  if (stage === "saved") return "저장";
  if (stage === "preparing") return "준비";
  if (stage === "submitted") return "제출";
  if (stage === "selected") return "선정";
  if (stage === "rejected") return "탈락";
  if (stage === "blocked") return "막힘";
  return "보류";
}

interface ManagementDraft {
  assigneeName: string;
  reminderAt: string;
  outcomeNote: string;
}

function managementDraftFromItem(item: ApplicationPipelineItem): ManagementDraft {
  return {
    assigneeName: item.assigneeName ?? "",
    reminderAt: item.reminderAt ?? "",
    outcomeNote: item.outcomeNote ?? "",
  };
}

function normalizeManagementDraft(draft: ManagementDraft): ManagementDraft {
  return {
    assigneeName: draft.assigneeName.trim().slice(0, 80),
    reminderAt: validDateInput(draft.reminderAt) ? draft.reminderAt : "",
    outcomeNote: draft.outcomeNote.trim().slice(0, 1000),
  };
}

function optionalPayloadString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1000) : null;
}

function validDateInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime());
}
