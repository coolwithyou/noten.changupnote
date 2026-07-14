"use client";

import { useMemo, useState } from "react";
import {
  Archive,
  BellRing,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Download,
  FileText,
  Loader2,
  Mail,
  MoreHorizontal,
  Save,
  Send,
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
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ApplicationGroup = "active" | "waiting" | "closed";
type EditorMode = "management" | "result";

const GROUPS: Array<{
  id: ApplicationGroup;
  title: string;
  stages: ReadonlySet<ApplicationStage>;
}> = [
  {
    id: "active",
    title: "진행 중",
    stages: new Set(["preparing", "saved", "recommended"]),
  },
  {
    id: "waiting",
    title: "결과 대기",
    stages: new Set(["submitted"]),
  },
  {
    id: "closed",
    title: "종료",
    stages: new Set(["selected", "rejected", "blocked", "dismissed"]),
  },
];

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
  const groupedItems = useMemo(() => groupPipelineItems(items), [items]);
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
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-5 py-9 sm:px-6 sm:py-13">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-[26px] leading-tight font-extrabold tracking-[-0.02em] text-foreground">
          내 신청 현황
        </h1>
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/applications/calendar">
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

      <div className="flex flex-col gap-8" aria-label="신청 관리" data-application-board>
        {GROUPS.map((group) => {
          const groupItems = groupedItems[group.id];
          return (
            <section className="flex flex-col gap-2" key={group.id} aria-labelledby={`application-group-${group.id}`}>
              <h2
                className="px-1 text-[13px] font-extrabold text-muted-foreground"
                id={`application-group-${group.id}`}
              >
                {group.title} ({groupItems.length.toLocaleString("ko-KR")})
              </h2>
              <Card className={cn("gap-0 py-0", group.id === "closed" && "opacity-70")}>
                {groupItems.length > 0 ? (
                  <CardContent className="px-0">
                    {groupItems.map((item, index) => (
                      <div key={item.grantId}>
                        {index > 0 ? <Separator /> : null}
                        <ApplicationRow
                          item={item}
                          pending={pendingGrantId === item.grantId}
                          onEdit={(mode) => setEditor({ grantId: item.grantId, mode })}
                          onMove={moveItem}
                        />
                      </div>
                    ))}
                  </CardContent>
                ) : (
                  <CardContent>
                    <Empty className="min-h-36">
                      <EmptyHeader>
                        <EmptyTitle>{group.title}인 신청이 없습니다.</EmptyTitle>
                        <EmptyDescription>{emptyGroupCopy(group.id)}</EmptyDescription>
                      </EmptyHeader>
                      {group.id === "active" ? (
                        <EmptyContent>
                          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard">
                            새 기회 보기
                          </a>
                        </EmptyContent>
                      ) : null}
                    </Empty>
                  </CardContent>
                )}
              </Card>
            </section>
          );
        })}
      </div>

      <div className="flex justify-center gap-4 text-[13px] font-semibold text-muted-foreground">
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

function ApplicationRow({
  item,
  pending,
  onEdit,
  onMove,
}: {
  item: ApplicationPipelineItem;
  pending: boolean;
  onEdit: (mode: EditorMode) => void;
  onMove: (item: ApplicationPipelineItem, kind: FeedbackKind, stage: ApplicationStage) => Promise<boolean>;
}) {
  const primary = primaryAction(item);
  const deadlineLabel = showsDeadline(item.stage) ? formatDday(item.dDay) : null;
  return (
    <article
      className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:gap-4 sm:px-[22px]"
      data-package-href={`/api/web/grants/${encodeURIComponent(item.grantId)}/package`}
    >
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-bold text-foreground">{item.title}</h3>
        <p className={cn(
          "mt-1 line-clamp-1 text-[13.5px] leading-5 text-muted-foreground",
          item.stage === "selected" && "font-bold text-brand-mint-ink",
          (item.stage === "rejected" || item.stage === "blocked") && "font-semibold text-destructive"
        )}>
          {applicationStatusLine(item)}
          {deadlineLabel ? (
            <>
              {" · "}
              <span
                className={cn(
                  "font-bold",
                  isUrgentDday(item.dDay) ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {deadlineLabel}
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2">
        {primary.kind === "link" ? (
          <a className={buttonVariants({ variant: primary.variant, size: "sm" })} href={primary.href}>
            {primary.label}
          </a>
        ) : (
          <Button size="sm" variant={primary.variant} disabled={pending} onClick={() => onEdit("result")}>
            {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            {primary.label}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`${item.title} 추가 작업`}
                disabled={pending}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLinkItem href={item.detailHref}>
              <FileText />
              공고 보기
            </DropdownMenuLinkItem>
            <DropdownMenuItem onClick={() => onEdit("management")}>
              <BellRing />
              메모·리마인더
            </DropdownMenuItem>
            {item.applyEnd || item.reminderAt ? (
              <DropdownMenuLinkItem href={`/api/web/applications/${encodeURIComponent(item.grantId)}/calendar`}>
                <CalendarDays />
                일정 .ics 내려받기
              </DropdownMenuLinkItem>
            ) : null}
            <DropdownMenuLinkItem href={`/api/web/grants/${encodeURIComponent(item.grantId)}/package`}>
              <Download />
              서류 패키지
            </DropdownMenuLinkItem>
            {item.stage !== "dismissed" ? (
              <DropdownMenuLinkItem href={`/api/web/applications/${encodeURIComponent(item.grantId)}/reminder-email`}>
                <Mail />
                리마인더 메일
              </DropdownMenuLinkItem>
            ) : null}
            <DropdownMenuSeparator />
            {item.stage === "submitted" ? (
              <DropdownMenuItem onClick={() => onEdit("result")}>
                <CheckCircle2 />
                결과 입력
              </DropdownMenuItem>
            ) : null}
            {canMarkSubmitted(item.stage) ? (
              <DropdownMenuItem onClick={() => void onMove(item, "applied", "submitted")}>
                <Send />
                제출 완료로 이동
              </DropdownMenuItem>
            ) : null}
            {item.stage === "recommended" ? (
              <DropdownMenuItem onClick={() => void onMove(item, "saved", "saved")}>
                <Save />
                저장
              </DropdownMenuItem>
            ) : null}
            {item.stage === "dismissed" ? (
              <DropdownMenuItem onClick={() => void onMove(item, "saved", "saved")}>
                <Save />
                진행 중으로 되돌리기
              </DropdownMenuItem>
            ) : item.stage !== "selected" && item.stage !== "rejected" && item.stage !== "blocked" ? (
              <DropdownMenuItem onClick={() => void onMove(item, "dismissed", "dismissed")}>
                <Archive />
                보류로 이동
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
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

function groupPipelineItems(items: ApplicationPipelineItem[]): Record<ApplicationGroup, ApplicationPipelineItem[]> {
  const grouped: Record<ApplicationGroup, ApplicationPipelineItem[]> = {
    active: [],
    waiting: [],
    closed: [],
  };
  for (const item of items) {
    const group = GROUPS.find((candidate) => candidate.stages.has(item.stage))?.id ?? "closed";
    grouped[group].push(item);
  }
  return grouped;
}

function primaryAction(item: ApplicationPipelineItem):
  | { kind: "link"; href: string; label: string; variant: "default" | "outline" }
  | { kind: "dialog"; label: string; variant: "outline" } {
  if (item.stage === "preparing") {
    return {
      kind: "link",
      href: `/grants/${encodeURIComponent(item.grantId)}/workspace`,
      label: item.draftCount > 0 ? "이어서 작성" : "작성 시작",
      variant: "default",
    };
  }
  if (item.stage === "saved" || item.stage === "recommended") {
    return {
      kind: "link",
      href: `/grants/${encodeURIComponent(item.grantId)}/workspace`,
      label: "작성 시작",
      variant: "default",
    };
  }
  if (item.stage === "submitted") {
    return { kind: "dialog", label: "결과 입력", variant: "outline" };
  }
  return { kind: "link", href: item.detailHref, label: "상세 보기", variant: "outline" };
}

function applicationStatusLine(item: ApplicationPipelineItem): string {
  if (item.stage === "selected") return item.outcomeNote ? `선정 · ${item.outcomeNote}` : "선정";
  if (item.stage === "rejected") return item.outcomeNote ? `탈락 · ${item.outcomeNote}` : "탈락";
  if (item.stage === "blocked") return item.outcomeNote ? `신청 막힘 · ${item.outcomeNote}` : "신청 막힘";
  if (item.stage === "dismissed") return item.outcomeNote ? `보류 · ${item.outcomeNote}` : "보류";
  if (item.stage === "submitted") {
    return item.lastActionAt ? `결과 대기 · 최근 확인 ${formatCalendarDate(item.lastActionAt)}` : "제출 완료 · 결과 대기";
  }

  const parts: string[] = [];
  if (item.stage === "preparing") {
    parts.push(item.draftCount > 0
      ? `서류 ${item.reviewedDraftCount}/${item.draftCount} 확인`
      : "서류 확인 전");
  } else {
    parts.push(item.stage === "saved" ? "저장됨" : "추천됨");
  }
  return parts.join(" · ");
}

function showsDeadline(stage: ApplicationStage): boolean {
  return stage === "preparing" || stage === "saved" || stage === "recommended";
}

function emptyGroupCopy(group: ApplicationGroup): string {
  if (group === "active") return "매칭 결과에서 준비할 공고를 선택해 보세요.";
  if (group === "waiting") return "제출을 완료하면 여기에서 결과를 관리할 수 있어요.";
  return "선정, 탈락, 막힘, 보류한 신청이 여기에 모입니다.";
}

function canMarkSubmitted(stage: ApplicationStage): boolean {
  return stage === "recommended" || stage === "saved" || stage === "preparing";
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

function formatDday(value: number | null): string | null {
  if (value === null) return null;
  if (value < 0) return "마감";
  if (value === 0) return "D-Day";
  return `D-${value}`;
}

function isUrgentDday(value: number | null): boolean {
  return value !== null && value >= 0 && value <= 7;
}

function formatCalendarDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
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
